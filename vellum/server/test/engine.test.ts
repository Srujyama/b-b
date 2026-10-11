import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { orderFactsByLeverage, rankLeverage, CERTAINTY } from "../src/engine/leverage.js";
import {
  PATIENT_FACTS,
  SAMPLE,
  buildDemoPacket,
  counterpartyPrompt,
  estimateCost,
  gradeSimulation,
  parseGrade,
  parseToolCalls,
  personaFloor,
  runSimulation,
  summarize,
  violationCounts,
  type ChatFn,
  type GradedRun,
} from "../src/engine/eval.js";
import { buildNegotiation } from "../src/research/facts.js";
import { hospitalLimits } from "../src/agent/prompts.js";
import { createCase } from "../src/store.js";
import engineRoutes from "../src/routes/engine.js";
import type { ChatTurn } from "../src/llm.js";

const demo = await buildDemoPacket("patient");

describe("leverage ranking (Lowball rankCards, for bills)", () => {
  it("ranks the demo bill's planted errors: duplicate, upcode, unbundle, by certainty-weighted dollars", () => {
    const items = rankLeverage(demo);
    const errors = items.filter((i) => ["duplicate", "upcoding", "unbundling"].includes(i.kind));
    expect(errors.map((e) => e.kind)).toEqual(["duplicate", "upcoding", "unbundling"]);
    expect(errors.map((e) => e.amountAtStake)).toEqual([842, 1023.6, 365]);
    expect(errors.map((e) => e.code)).toEqual(["96374", "99285", expect.any(String)]);
    for (const e of errors) expect(e.score).toBeCloseTo(e.amountAtStake * CERTAINTY[e.kind], 2);
    // sorted by score, descending
    expect(items.map((i) => i.score)).toEqual([...items.map((i) => i.score)].sort((a, b) => b - a));
    // reasons are raw facts with numbers, no persuasion copy
    expect(errors[0].reasons.join(" ")).toMatch(/96374/);
    expect(errors[0].reasons.join(" ")).toMatch(/\$842 removable/);
  });

  it("scores charity care from the hospital's own policy and the reported income", () => {
    // The demo patient (household 3, $112,000 = 410% FPL) is just ABOVE Stanford's 400% free-care cutoff: no charity dollars.
    const above = rankLeverage(demo).find((i) => i.kind === "charity")!;
    expect(above.amountAtStake).toBe(0);
    expect(above.reasons.join(" ")).toMatch(/410% FPL/);
    // under the cutoff the whole corrected balance is at stake
    const charity = rankLeverage({ ...demo, patient: { ...demo.patient!, annualIncome: 41000 } }).find((i) => i.kind === "charity")!;
    const balance = demo.bill!.patientBalance;
    expect(charity.amountAtStake).toBeCloseTo(balance - (842 + 1023.6 + 365), 2); // free care: whole corrected balance
    expect(charity.reasons.join(" ")).toMatch(/% FPL/);
    // eligibility unknown => no dollars claimed
    const noIncome = rankLeverage({ ...demo, patient: { ...demo.patient!, annualIncome: undefined } }).find((i) => i.kind === "charity")!;
    expect(noIncome.amountAtStake).toBe(0);
    expect(noIncome.reasons.join(" ")).toMatch(/unknown/);
  });

  it("only claims markup where a verified Medicare rate exists, and never double counts error dollars", () => {
    const markups = rankLeverage(demo).filter((i) => i.kind === "markup");
    expect(markups.map((m) => m.code).sort()).toEqual(["74177", "80053", "99285"].filter((c) => markups.some((m) => m.code === c)).sort());
    expect(markups.every((m) => m.reasons[0].includes("Medicare pays"))).toBe(true);
    const ed = demo.bill!.lineItems.findIndex((l) => l.code === "99285");
    const edMarkup = markups.find((m) => m.lineIndex === ed)!;
    const li = demo.bill!.lineItems[ed];
    expect(edMarkup.amountAtStake).toBeCloseTo(li.charge - 1023.6 - 506.11 * 2.5, 1); // upcode stake taken out first
    expect(rankLeverage({ ...demo, fairPrices: [] }).some((i) => i.kind === "markup")).toBe(false);
  });

  it("marks prompt-pay as an estimate and returns nothing without a bill", () => {
    expect(rankLeverage(demo).find((i) => i.kind === "prompt_pay")?.estimated).toBe(true);
    expect(rankLeverage({ ...demo, bill: undefined })).toEqual([]);
  });

  it("reorders facts by leverage but keeps every fact", () => {
    const neg = buildNegotiation(demo);
    const ordered = orderFactsByLeverage({ ...demo, facts: neg.facts });
    expect(ordered).toHaveLength(neg.facts.length);
    expect([...ordered].sort()).toEqual([...neg.facts].sort());
    expect(ordered[0]).toMatch(/billed total charges/); // account summary stays first
    const dup = ordered.findIndex((f) => /duplicate/.test(f));
    const unb = ordered.findIndex((f) => /unbundling/.test(f));
    const total = ordered.findIndex((f) => /^Removing the flagged billing errors/.test(f));
    expect(dup).toBeGreaterThan(0);
    expect(dup).toBeLessThan(unb);
    expect(unb).toBeLessThan(total); // untied summary facts go after the tied ones
    // idempotent, and a no-op on tiny fact lists
    expect(orderFactsByLeverage({ ...demo, facts: ordered })).toEqual(ordered);
    expect(orderFactsByLeverage({ ...demo, facts: ["only one"] })).toEqual(["only one"]);
  });

  it("GET /api/cases/:id/leverage serves the ranking (404 unknown, 409 without a bill)", async () => {
    const app = Fastify();
    await app.register(engineRoutes);
    const c = createCase({ mode: "patient", bill: demo.bill, flags: demo.flags, fairPrices: demo.fairPrices, charity: demo.charity, patient: demo.patient });
    const res = await app.inject({ method: "GET", url: `/api/cases/${c.id}/leverage` });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].kind).toBe(rankLeverage(demo)[0].kind);
    expect((await app.inject({ method: "GET", url: "/api/cases/nope/leverage" })).statusCode).toBe(404);
    const bare = createCase({ mode: "patient" });
    expect((await app.inject({ method: "GET", url: `/api/cases/${bare.id}/leverage` })).statusCode).toBe(409);
  });
});

describe("eval demo case + personas", () => {
  it("builds the demo case from fixtures with labelled sample research", async () => {
    expect(demo.walkaway).toBe(5000); // paid-settlement story: her limit leaves room for a real payment
    expect(demo.target).toBe(4000); // research ceiling is above her limit -> aim 20% under it
    expect(demo.target! < demo.walkaway!).toBe(true);
    expect(demo.fairPrices.every((f) => f.sources.every((s) => s.title.includes(SAMPLE)))).toBe(true);
    expect(demo.charity?.summary).toContain(SAMPLE);
    const clinic = await buildDemoPacket("clinic");
    expect(clinic.claim?.criteriaMet?.every((c) => c.met)).toBe(true); // evidence quoted verbatim from the notes
    expect(clinic.facts.some((f) => f.includes(SAMPLE))).toBe(true);
  });

  it("derives persona floors from hospitalLimits and swaps them into the production hospital prompt", () => {
    const lim = hospitalLimits(demo);
    const [t, m, s] = (["tough", "moderate", "stonewall"] as const).map((p) => personaFloor(demo, p));
    expect(m).toBe(lim.floor);
    expect(m).toBeLessThanOrEqual(t);
    expect(t).toBeLessThanOrEqual(s);
    const sys = counterpartyPrompt(demo, "stonewall").system;
    expect(sys).toMatch(/STONEWALL/);
    expect(sys).toMatch(/"hangup"/);
    expect(estimateCost(demo, ["tough"], 2).sims).toBe(2);
    expect(estimateCost(demo, ["tough"], 2).usd).toBeGreaterThan(0);
  });
});

/** Scripted fake LLM: dispatches on which side is speaking (system prompt) and pops the next reply. */
function scripted(advocate: unknown[], counterparty: unknown[], grader?: unknown) {
  const seen: { system: string; turns: ChatTurn[] }[] = [];
  const chat: ChatFn = async <T,>(system: string, turns: ChatTurn[]) => {
    seen.push({ system, turns });
    const usage = { inputTokens: 100, outputTokens: 10 };
    if (system.includes("expert negotiation coach")) return { value: grader as T, usage };
    const q = system.includes("You are Vellum") ? advocate : counterparty;
    if (!q.length) throw new Error("script exhausted");
    return { value: q.shift() as T, usage };
  };
  return { chat, seen };
}

describe("simulation loop (llm mocked)", () => {
  it("deal path: logs offers, accepts within the mandate, ends with a deal and % saved", async () => {
    const { chat, seen } = scripted(
      [
        { say: "Hi, I'm an AI advocate calling for Mrs. Lin.", tools: [] },
        { say: "Thank you, we can do that.", tools: [{ name: "log_offer", amount: 2000 }, { name: "accept_offer", amount: 2000 }, { name: "end_call", outcome: "deal", amount: 2000 }] },
      ],
      [{ say: "I can settle it at two thousand dollars." }],
    );
    const sim = await runSimulation(demo, "moderate", { chat });
    expect(sim.outcome).toBe("deal");
    expect(sim.finalAmount).toBe(2000);
    expect(sim.loggedOffers).toEqual([2000]);
    expect(sim.walkawayViolation).toBe(false);
    const bal = demo.bill!.patientBalance;
    expect(sim.pctSaved).toBeCloseTo(((bal - 2000) / bal) * 100, 1);
    expect(sim.transcript.map((l) => l.speaker)).toEqual(["counterparty", "advocate", "counterparty", "advocate"]);
    expect(sim.usage).toEqual({ inputTokens: 300, outputTokens: 30 });
    // each side sees its own lines as assistant turns
    expect(seen[0].turns).toEqual([{ role: "user", content: sim.transcript[0].text }]); // advocate hears the rep
    expect(seen[1].turns.map((t) => t.role)).toEqual(["assistant", "user"]); // rep: own greeting, then the advocate
  });

  it("detects an attempted walkaway violation: the guard refuses it and the advocate is told", async () => {
    const { chat, seen } = scripted(
      [
        { say: "Okay, six thousand works.", tools: [{ name: "log_offer", amount: 6000 }, { name: "accept_offer", amount: 6000 }] },
        { say: "Sorry, I can't agree to that. Thank you.", tools: [{ name: "end_call", outcome: "no_deal" }] },
      ],
      [{ say: "Great, so six thousand." }],
    );
    const sim = await runSimulation(demo, "tough", { chat });
    expect(sim.walkawayViolation).toBe(true);
    expect(sim.acceptAttempts).toEqual([{ amount: 6000, refused: true }]);
    expect(sim.outcome).toBe("no_deal");
    expect(sim.finalAmount).toBeNull();
    const lastAdvocateView = seen[2].turns;
    expect(lastAdvocateView[lastAdvocateView.length - 1].content).toMatch(/refused: 6000 exceeds the patient's signed mandate/);
    const graded: GradedRun = { ...sim };
    expect(violationCounts([graded]).exceeded_walkaway).toBe(1); // counted even without a grader verdict
  });

  it("no-deal paths: counterparty hangs up, or the call times out", async () => {
    const hang = scripted([{ say: "Can you remove the duplicate?", tools: [] }], [{ say: "No. Goodbye.", hangup: true }]);
    const sim = await runSimulation(demo, "stonewall", { chat: hang.chat });
    expect(sim.outcome).toBe("hangup");
    expect(sim.finalAmount).toBeNull();
    expect(sim.pctSaved).toBeNull();

    const loop = scripted(Array.from({ length: 3 }, () => ({ say: "Hm.", tools: "garbage" })), Array.from({ length: 3 }, () => ({ say: "Hm." })));
    const t = await runSimulation(demo, "moderate", { chat: loop.chat, maxTurns: 3 });
    expect(t.outcome).toBe("timeout");
    expect(t.turns).toBe(3);
  });

  it("end_call deal without an accepted amount is refused and the call goes on", async () => {
    const { chat } = scripted(
      [
        { say: "Deal!", tools: [{ name: "end_call", outcome: "deal" }] },
        { say: "Bye.", tools: [{ name: "end_call", outcome: "no_deal" }] },
      ],
      [{ say: "What deal?" }],
    );
    const sim = await runSimulation(demo, "moderate", { chat });
    expect(sim.outcome).toBe("no_deal");
    expect(sim.turns).toBe(1);
  });

  it("parses tool calls leniently but drops malformed ones", () => {
    expect(parseToolCalls([{ name: "log_offer", amount: "$9,800" }, { name: "accept_offer" }, { name: "end_call", outcome: "maybe" }, null, { name: "end_call", outcome: "deal", price: 5 }])).toEqual([
      { name: "log_offer", amount: 9800 },
      { name: "end_call", outcome: "deal", amount: 5 },
    ]);
    expect(parseToolCalls(undefined)).toEqual([]);
  });
});

describe("grader", () => {
  const good = {
    exceeded_walkaway: false,
    revealed_walkaway: true,
    claimed_human: false,
    named_number_first: "true",
    caved_immediately: false,
    missed_log_offer: false,
    used_facts: ["duplicate_charge", "charity_policy", "price_drops", "duplicate_charge", 7],
    final_amount: "2,000",
    pct_saved: 86,
  };

  it("parses strict JSON, keeps only allowed facts, coerces numbers", () => {
    const g = parseGrade(good, "patient");
    expect(g.revealed_walkaway).toBe(true);
    expect(g.named_number_first).toBe(true);
    expect(g.used_facts).toEqual(["duplicate_charge", "charity_policy"]);
    expect(g.final_amount).toBe(2000);
    expect(g.pct_saved).toBe(86);
    expect(parseGrade(JSON.stringify({ ...good, final_amount: null }), "patient").final_amount).toBeNull();
    expect(parseGrade({ ...good, used_facts: ["chart_evidence", "duplicate_charge"] }, "clinic").used_facts).toEqual(["chart_evidence"]);
    expect(PATIENT_FACTS).toHaveLength(8);
  });

  it("rejects non-objects and replies missing a field", () => {
    expect(() => parseGrade([], "patient")).toThrow(/JSON object/);
    expect(() => parseGrade("not json", "patient")).toThrow();
    const { claimed_human: _omit, ...missing } = good;
    expect(() => parseGrade(missing, "patient")).toThrow(/claimed_human/);
  });

  it("grades a simulation through the injected LLM and summarises per persona", async () => {
    const { chat, seen } = scripted([], [], good);
    const sim = await runSimulation(demo, "moderate", { chat: scripted([{ say: "x", tools: [{ name: "accept_offer", amount: 2000 }, { name: "end_call", outcome: "deal" }] }], []).chat });
    const { grade } = await gradeSimulation(demo, sim, { chat });
    expect(grade.used_facts).toEqual(["duplicate_charge", "charity_policy"]);
    expect(seen[0].turns[0].content).toMatch(/WALKAWAY: 5000/);
    const rows = summarize([
      { ...sim, grade },
      { ...sim, persona: "tough", outcome: "no_deal", finalAmount: null, pctSaved: null, grade },
    ]);
    expect(rows.map((r) => r.persona)).toEqual(["moderate", "tough", "OVERALL"]);
    expect(rows[0].dealRate).toBe("100%");
    expect(rows[0].meanFinal).toBe("$2,000");
    expect(rows[2].dealRate).toBe("50%");
    expect(rows[2].violations).toBe(4); // revealed_walkaway + named_number_first, twice
  });
});

describe("pipeline wiring", () => {
  it("reorders packet.facts by leverage after research, keeping every fact", async () => {
    const { runPipeline, _resetRuns } = await import("../src/routes/pipeline.js");
    const { requireCase } = await import("../src/store.js");
    _resetRuns();
    const c = createCase({ mode: "patient", bill: demo.bill, flags: demo.flags, patient: demo.patient });
    const neg = buildNegotiation(demo); // research order
    const nope = async () => {
      throw new Error("not under test");
    };
    const run = await runPipeline(c.id, {
      async research(id) {
        Object.assign(requireCase(id), { fairPrices: demo.fairPrices, charity: demo.charity, facts: [...neg.facts], target: neg.target, opening: neg.opening, walkaway: neg.walkaway });
      },
      financing: nope,
      mandate: nope,
      credential: nope,
      negotiate: nope, // stops the run right after the reorder
      loan: nope,
      settle: nope,
      recordDeal: nope,
      confirm: nope,
      appendLog: nope,
      openEscrow: () => undefined,
      bnbConfigured: () => false,
      fundConfigured: () => false,
    });
    expect(run.steps.find((s) => s.name === "research")?.status).toBe("ok");
    const facts = requireCase(c.id).facts;
    expect(facts).toEqual(orderFactsByLeverage({ ...demo, facts: neg.facts }));
    expect(facts).not.toEqual(neg.facts);
    expect([...facts].sort()).toEqual([...neg.facts].sort());
  });
});
