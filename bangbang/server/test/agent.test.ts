import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/llm.js", () => ({
  llmText: vi.fn(async (_system: string, user: string) => `ZH(${user})`),
  llmJson: vi.fn(),
}));

import { llmText } from "../src/llm.js";
import { createCase, subscribe } from "../src/store.js";
import type { CaseEvent, CasePacket } from "../src/types.js";
import {
  advocatePrompt,
  hospitalLimits,
  hospitalPrompt,
  insurerPrompt,
  intakePrompt,
  spokenUsd,
} from "../src/agent/prompts.js";
import { elevenClientTool, elevenWebhookTool, handleTool, webhookToolsFor } from "../src/agent/tools.js";
import { clearTranslateCache, translateLine } from "../src/agent/translate.js";

const FACT_DUP = "The CT head scan (CPT 70450) is billed twice for the same date, 2026-09-14, at $3,120 each.";
const FACT_FAP = "St. Example Medical Center's financial assistance policy gives free care under 200% of the federal poverty level.";

function patientInit(): Partial<CasePacket> & Pick<CasePacket, "mode"> {
  return {
    mode: "patient",
    status: "researched",
    patient: { name: "Lin Mei", language: "zh", householdSize: 3, annualIncome: 38000, maxPay: 4321, consent: true },
    bill: {
      provider: { name: "St. Example Medical Center" },
      patientName: "Mei Lin",
      accountNumber: "A-778812",
      serviceDate: "2026-09-14",
      lineItems: [
        { code: "99285", codeType: "CPT", description: "ER visit level 5", qty: 1, charge: 4800 },
        { code: "70450", codeType: "CPT", description: "CT head w/o contrast", qty: 1, charge: 3120 },
        { code: "70450", codeType: "CPT", description: "CT head w/o contrast", qty: 1, charge: 3120 },
      ],
      totalCharges: 14210,
      patientBalance: 14210,
    },
    flags: [{ kind: "duplicate", lineIndex: 2, message: "duplicate CT", amountAtStake: 3120 }],
    fairPrices: [{ code: "70450", medicareRate: 180, sources: [] }],
    charity: { hospital: "St. Example Medical Center", hasFap: true, freeCareBelowPctFpl: 200, summary: "Free care under 200% FPL.", sources: [] },
    facts: [FACT_DUP, FACT_FAP],
    target: 2500,
    opening: 1800,
    walkaway: 4321,
  };
}

function spy(id: string): CaseEvent[] {
  const events: CaseEvent[] = [];
  subscribe(id, { readyState: 1, send: (d: string) => events.push(JSON.parse(d)), on: () => {} } as never);
  events.length = 0; // drop the initial snapshot
  return events;
}

describe("prompts", () => {
  it("spokenUsd writes amounts as words", () => {
    expect(spokenUsd(14210)).toBe("fourteen thousand two hundred ten dollars");
    expect(spokenUsd(0)).toBe("zero dollars");
    expect(spokenUsd(1_250_000)).toBe("one million two hundred fifty thousand dollars");
  });

  it("advocate prompt cites the facts, identifies as AI, and carries the ladder", () => {
    const p = advocatePrompt(createCase(patientInit()));
    expect(p).toContain(FACT_DUP);
    expect(p).toContain(FACT_FAP);
    expect(p).toMatch(/AI advocate/);
    expect(p).toMatch(/financial assistance/i);
    expect(p).toMatch(/payment plan/i);
    expect(p).toMatch(/prompt-pay/i);
    expect(p).toContain(spokenUsd(4321)); // ceiling is the advocate's own secret
    expect(p).toMatch(/NEVER INVENT/);
  });

  it("advocate without a mandate may not accept anything", () => {
    const p = advocatePrompt(createCase({ ...patientInit(), walkaway: undefined, patient: undefined, target: undefined, opening: undefined }));
    expect(p).toMatch(/may NOT accept any amount/);
  });

  it("hospital prompt never leaks the patient's walkaway, target or opening", () => {
    const c = createCase(patientInit());
    const h = hospitalPrompt(c);
    for (const n of [4321, 2500, 1800]) {
      expect(h).not.toContain(spokenUsd(n));
      expect(h).not.toContain(String(n));
      expect(h).not.toContain(n.toLocaleString("en-US"));
    }
    expect(h).not.toContain("38000"); // income only reaches the hospital if the advocate says it
    expect(h).toContain("70450"); // but it can see its own itemization
    expect(h).toMatch(/Free care under 200% FPL/);
  });

  it("hospital floor is derived from bill+policy, below the corrected balance, independent of the mandate", () => {
    const a = hospitalLimits(createCase(patientInit()));
    const b = hospitalLimits(createCase({ ...patientInit(), walkaway: 9999, patient: { ...patientInit().patient!, maxPay: 9999 } }));
    expect(a).toEqual(b);
    expect(a.correctable).toBe(3120);
    expect(a.floor).toBeLessThan(14210 - 3120);
    expect(a.floor).toBeGreaterThanOrEqual(180); // not below Medicare
  });

  it("clinic advocate argues criteria; insurer prompt has the policy", () => {
    const c = createCase({
      mode: "clinic",
      claim: {
        payer: "Acme Health",
        denialReason: "Not medically necessary",
        procedure: { code: "72148", description: "MRI lumbar spine" },
        diagnoses: [{ code: "M54.16", description: "Radiculopathy, lumbar" }],
        clinicalNotes: "6 weeks PT failed.",
        policy: { title: "Lumbar MRI policy", url: "https://x", criteria: ["6 weeks conservative therapy", "Neurologic deficit"] },
        criteriaMet: [
          { criterion: "6 weeks conservative therapy", met: true, evidence: "PT 8/1-9/15" },
          { criterion: "Neurologic deficit", met: true, evidence: "Diminished L5 reflex" },
        ],
      },
      facts: ["The payer's policy requires six weeks of conservative therapy."],
    });
    const a = advocatePrompt(c);
    expect(a).toContain("Diminished L5 reflex");
    expect(a).toContain("Lumbar MRI policy");
    expect(a).toMatch(/medical necessity/i);
    const i = insurerPrompt(c);
    expect(i).toContain("Neurologic deficit");
    expect(i).not.toContain("Diminished L5 reflex"); // the advocate must bring the evidence
  });

  it("intake prompt is Mandarin and asks for all mandate fields", () => {
    const p = intakePrompt();
    for (const s of ["家庭人数", "年收入", "最多", "同意", "submit_intake"]) expect(p).toContain(s);
  });
});

describe("tool definitions", () => {
  it("webhook tool matches the ElevenLabs tool_config shape", () => {
    const t = elevenWebhookTool("accept_offer", "https://bb.example/");
    expect(t.type).toBe("webhook");
    expect(t.api_schema.url).toBe("https://bb.example/api/eleven/tools/accept_offer");
    expect(t.api_schema.method).toBe("POST");
    expect(t.api_schema.request_body_schema.required).toEqual(["amount", "case_id"]);
    expect(t.api_schema.request_body_schema.properties.case_id).toEqual({ type: "string", dynamic_variable: "case_id" });
    expect(webhookToolsFor("advocate", "https://x").map((x) => x.name)).toEqual(["log_offer", "accept_offer", "end_call"]);
  });
  it("client tool has parameters and expects a response", () => {
    const t = elevenClientTool("submit_intake");
    expect(t.type).toBe("client");
    expect(t.expects_response).toBe(true);
    expect(t.parameters.required).toEqual(["name", "max_pay", "consent"]);
  });
});

describe("handleTool", () => {
  it("log_offer records a hospital offer and moves to negotiating", () => {
    const c = createCase(patientInit());
    const ev = spy(c.id);
    const r = handleTool(c.id, "log_offer", { amount: "$9,800", note: "after dup removal" });
    expect(r.ok).toBe(true);
    expect(c.offers).toHaveLength(1);
    expect(c.offers[0]).toMatchObject({ by: "hospital", amount: 9800, note: "after dup removal" });
    expect(c.status).toBe("negotiating");
    expect(ev.some((e) => e.type === "offer")).toBe(true);
    expect(ev.some((e) => e.type === "status" && e.status === "negotiating")).toBe(true);
    expect(handleTool(c.id, "log_offer", { amount: 2000 }).message).toMatch(/snap-accept/);
    expect(handleTool(c.id, "log_offer", { amount: "abc" }).ok).toBe(false);
  });

  it("accept_offer above the walkaway is refused and nothing changes", () => {
    const c = createCase(patientInit());
    const r = handleTool(c.id, "accept_offer", { amount: 4322 });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/REFUSED/);
    expect(c.agreedAmount).toBeUndefined();
    expect(c.status).toBe("researched");
  });

  it("accept_offer within the walkaway agrees the deal", () => {
    const c = createCase(patientInit());
    const ev = spy(c.id);
    const r = handleTool(c.id, "accept_offer", { amount: 4321 });
    expect(r.ok).toBe(true);
    expect(c.agreedAmount).toBe(4321);
    expect(c.status).toBe("agreed");
    expect(ev).toContainEqual({ type: "deal", amount: 4321 });
    expect(handleTool(c.id, "accept_offer", { amount: 100 }).ok).toBe(false); // no double deal
    expect(handleTool(c.id, "end_call", { outcome: "deal" }).ok).toBe(true);
    expect(c.status).toBe("agreed");
  });

  it("accept_offer with no mandate or no consent is refused", () => {
    const noMandate = createCase({ ...patientInit(), walkaway: undefined, patient: undefined });
    expect(handleTool(noMandate.id, "accept_offer", { amount: 1 }).ok).toBe(false);
    const noConsent = createCase({ ...patientInit(), patient: { ...patientInit().patient!, consent: false } });
    expect(handleTool(noConsent.id, "accept_offer", { amount: 1 }).ok).toBe(false);
  });

  it("end_call deal without accept goes through the same guard", () => {
    const c = createCase(patientInit());
    expect(handleTool(c.id, "end_call", { outcome: "deal", amount: 99999 }).ok).toBe(false);
    expect(c.agreedAmount).toBeUndefined();
    expect(handleTool(c.id, "end_call", { outcome: "deal", amount: 3000 }).ok).toBe(true);
    expect(c.agreedAmount).toBe(3000);
  });

  it("end_call no_deal marks the case failed", () => {
    const c = createCase(patientInit());
    expect(handleTool(c.id, "end_call", { outcome: "no_deal", summary: "won't move" }).ok).toBe(true);
    expect(c.status).toBe("failed");
    expect(handleTool(c.id, "end_call", { outcome: "maybe" }).ok).toBe(false);
  });

  it("submit_intake sets the patient and the walkaway", () => {
    const c = createCase({ mode: "patient" });
    const r = handleTool(c.id, "submit_intake", { name: "林美", household_size: "3", annual_income: 38000, max_pay: 3000, consent: true, case_id: c.id });
    expect(r.ok).toBe(true);
    expect(c.patient).toEqual({ name: "林美", language: "zh", householdSize: 3, annualIncome: 38000, maxPay: 3000, consent: true });
    expect(c.walkaway).toBe(3000);
    expect(handleTool(c.id, "submit_intake", { name: "林美", max_pay: 0, consent: true }).ok).toBe(false);
  });

  it("submit_intake without consent records no walkaway", () => {
    const c = createCase({ mode: "patient" });
    handleTool(c.id, "submit_intake", { name: "林美", max_pay: 3000, consent: false });
    expect(c.patient?.consent).toBe(false);
    expect(c.walkaway).toBeUndefined();
    expect(handleTool(c.id, "accept_offer", { amount: 10 }).ok).toBe(false);
  });

  it("unknown tool and unknown case", () => {
    const c = createCase(patientInit());
    expect(handleTool(c.id, "launch_rockets", {}).ok).toBe(false);
    expect(() => handleTool("nope", "log_offer", { amount: 1 })).toThrow(/unknown case/);
  });

  it("clinic mode logs insurer offers and accepts without a patient mandate", () => {
    const c = createCase({ mode: "clinic" });
    handleTool(c.id, "log_offer", { amount: 1200 });
    expect(c.offers[0].by).toBe("insurer");
    expect(handleTool(c.id, "accept_offer", { amount: 1200 }).ok).toBe(true);
    expect(c.status).toBe("agreed");
  });
});

describe("translateLine", () => {
  beforeEach(() => {
    clearTranslateCache();
    vi.mocked(llmText).mockClear();
  });

  it("translates via llmText and caches repeats", async () => {
    expect(await translateLine("  Let me check.  ", "zh")).toBe("ZH(Let me check.)");
    expect(await translateLine("Let me check.", "zh")).toBe("ZH(Let me check.)");
    expect(llmText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(llmText).mock.calls[0][0]).toMatch(/Simplified Chinese/);
    await translateLine("Let me check.", "en"); // different direction = different key
    expect(llmText).toHaveBeenCalledTimes(2);
  });

  it("empty text costs nothing", async () => {
    expect(await translateLine("   ", "zh")).toBe("");
    expect(llmText).not.toHaveBeenCalled();
  });

  it("evicts the least recently used entry past 500", async () => {
    for (let i = 0; i < 501; i++) await translateLine(`line ${i}`, "zh");
    expect(llmText).toHaveBeenCalledTimes(501);
    await translateLine("line 0", "zh"); // evicted → recomputed
    expect(llmText).toHaveBeenCalledTimes(502);
    await translateLine("line 500", "zh"); // still cached
    expect(llmText).toHaveBeenCalledTimes(502);
  });
});
