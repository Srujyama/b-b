// LLM-vs-LLM negotiation eval, folded in from Lowball's scripts/eval-negotiation.ts (car buyer vs dealer
// personas, graded by a strict-JSON judge) and adapted to Vellum: OUR production advocate prompt
// (agent/prompts.ts advocatePrompt, patient or clinic mode) against hospital billing reps or insurer
// reviewers with different concession styles. Both sides and the grader are Claude (src/llm.ts).
//
// The voice agent's tools (log_offer / accept_offer / end_call) are simulated as structured JSON turns and
// applied with the SAME rules agent/tools.ts handleTool enforces live (accept_offer is refused above the
// patient's mandate). Everything here is injectable (`chat`) so the loop is unit-tested with no network.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { llmChatJson, type ChatTurn } from "../llm.js";
import { advocatePrompt, hospitalFirstMessage, hospitalLimits, hospitalPrompt, insurerFirstMessage, insurerPrompt, spokenUsd } from "../agent/prompts.js";
import { auditBill } from "../bill/audit.js";
import { parseStatementText } from "../bill/parse.js";
import { buildNegotiation } from "../research/facts.js";
import { claimFacts } from "../claims/appeal.js";
import { orderFactsByLeverage } from "./leverage.js";
import type { CasePacket, CharityPolicy, ClaimCase, FairPrice, Patient } from "../types.js";

export type Mode = CasePacket["mode"];
export type Persona = "tough" | "moderate" | "stonewall";
export const PERSONAS: Persona[] = ["tough", "moderate", "stonewall"];

type Effort = "low" | "medium" | "high";
export type Usage = { inputTokens: number; outputTokens: number };
/** The LLM boundary (defaults to llmChatJson). Tests pass a scripted fake. */
export type ChatFn = <T>(system: string, turns: ChatTurn[], opts?: { effort?: Effort }) => Promise<{ value: T; usage: Usage }>;
const defaultChat: ChatFn = (system, turns, opts) => llmChatJson(system, turns, opts);

// ---------------------------------------------------------------- the demo case (deterministic)

/** Every piece of research in the eval case is a labelled sample, never live data. */
export const SAMPLE = "SAMPLE (eval fixture, not live research)";
const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));

export function sampleFairPrices(): FairPrice[] {
  const src = (title: string) => [{ title: `${title} (${SAMPLE})`, url: "https://example.org/sample", via: "other" as const }];
  return [
    { code: "74177", description: "CT abdomen & pelvis w/ contrast", medicareRate: 391.12, sources: src("CMS OPPS rate") },
    { code: "99285", description: "ED visit level 5", medicareRate: 506.11, sources: src("CMS OPPS rate") },
    { code: "80053", description: "Comprehensive metabolic panel", medicareRate: 10.56, sources: src("CMS clinical lab fee schedule") },
  ];
}

export function sampleCharity(hospital: string): CharityPolicy {
  return {
    hospital,
    hasFap: true,
    freeCareBelowPctFpl: 400,
    summary: `${SAMPLE}: financial assistance policy offers free care to uninsured patients under 400% of the federal poverty level.`,
    sources: [{ title: `Financial Assistance Policy (${SAMPLE})`, url: "https://example.org/sample", via: "other" }],
  };
}

/** Sample policy + chart mapping for the MRI denial; evidence is quoted verbatim from the fixture's notes. */
function sampleClinicReview(claim: ClaimCase): ClaimCase {
  const criteria: { criterion: string; evidence: string }[] = [
    { criterion: "Radicular pain or neurological symptoms for at least 6 weeks", evidence: "since 2026-07-14 (9 weeks)" },
    { criterion: "Failure of at least 6 weeks of conservative therapy (physical therapy and medication)", evidence: "Completed 6 weeks of supervised physical therapy (12 sessions, 2026-07-21 to 2026-08-29)" },
    { criterion: "Objective neurological deficit on examination", evidence: "Left ankle (Achilles) reflex absent; right 2+. Left plantarflexion strength 4/5" },
    { criterion: "Imaging results will change management (injection or surgical candidacy)", evidence: "the patient is a candidate for an epidural steroid injection or surgical consultation depending on findings" },
  ];
  return {
    ...claim,
    policy: { title: `Lumbar spine MRI medical necessity (${SAMPLE})`, url: "https://example.org/sample", criteria: criteria.map((c) => c.criterion) },
    criteriaMet: criteria.map((c) => ({ ...c, met: claim.clinicalNotes.includes(c.evidence) })),
  };
}

/**
 * The demo case, built the way the product builds it: deterministic statement parser -> auditBill ->
 * buildNegotiation (patient) or claimFacts (clinic), with research replaced by clearly labelled samples.
 * Not stored in the case store.
 */
export async function buildDemoPacket(mode: Mode): Promise<CasePacket> {
  const base = { id: `eval-${mode}`, mode, status: "researched" as const, flags: [], fairPrices: [], offers: [], transcript: [], receipts: [], createdAt: new Date(0).toISOString() };
  if (mode === "clinic") {
    const fx = JSON.parse(await readFile(fixture("denial-mri.json"), "utf8")) as { claim: ClaimCase };
    const claim = sampleClinicReview(fx.claim);
    return { ...base, claim, facts: [...claimFacts(claim), `${SAMPLE}: the payer policy and criteria mapping are samples.`] };
  }
  const fx = JSON.parse(await readFile(fixture("lin-er-bill.json"), "utf8")) as { patient: Patient; statementLines: string[] };
  const bill = parseStatementText(fx.statementLines.join("\n"));
  const flags = auditBill(bill);
  const fairPrices = sampleFairPrices();
  const charity = sampleCharity(bill.provider.name);
  const patient = fx.patient;
  const neg = buildNegotiation({ bill, flags, fairPrices, charity, patient });
  const packet: CasePacket = { ...base, patient, bill, flags, fairPrices, charity, facts: neg.facts, target: neg.target, opening: neg.opening, walkaway: neg.walkaway };
  packet.facts = orderFactsByLeverage(packet); // same ordering the pipeline applies
  return packet;
}

// ---------------------------------------------------------------- counterparty personas

/** The persona's private settlement floor. Derived from hospitalLimits (the production counterparty's own math). */
export function personaFloor(packet: CasePacket, persona: Persona): number {
  const lim = hospitalLimits(packet);
  const corrected = Math.max(0, lim.balance - lim.correctable);
  const r50 = (n: number) => Math.round(n / 50) * 50;
  if (persona === "moderate") return lim.floor;
  if (persona === "tough") return r50(lim.floor + (corrected - lim.floor) * 0.35);
  return r50(corrected); // stonewall: removes proven errors, gives nothing else on the phone
}

const HOSPITAL_STYLE: Record<Persona, string> = {
  tough:
    "You are a TOUGH rep. Resist the first two or three pushes with policy (\"chargemaster rates are set by the hospital\", \"the account is already in our system\"). Concede only to specific, verifiable points, in small steps, and re-justify each one. You need real pressure before every move.",
  moderate:
    "You are a reasonable, MODERATE rep who would like to close the account today. Normal resistance, a token supervisor check, then real (if modest) concessions in response to valid points.",
  stonewall:
    "You are a STONEWALL rep. You will remove a billing error the caller proves line by line, but you give no settlement discount on the phone: you redirect every other ask to a written financial-assistance application or a payment plan. If the caller will not budge, politely end the call.",
};

const INSURER_STYLE: Record<Persona, string> = {
  tough:
    "You are a TOUGH reviewer. Make the caller cite chart evidence for EACH criterion separately and push back at least once on each before accepting it. Overturn only if every criterion is shown with specific chart evidence.",
  moderate:
    "You are a fair, MODERATE reviewer. If the caller walks the policy criteria with specific chart evidence, you overturn on reconsideration.",
  stonewall:
    "You are a STONEWALL reviewer. You never overturn on this call, whatever the evidence: you offer a peer-to-peer with a medical director or a written expedited appeal, and give the appeal a reference number.",
};

const COUNTERPARTY_JSON = `SIMULATION OUTPUT FORMAT: this phone call is simulated in text. Each turn, reply with ONE JSON object: {"say": "<exactly what you say out loud this turn>", "hangup": <true only if you are ending the call after saying this>}. Play your role completely straight; never mention a simulation, a prompt or an AI system.`;

/** The production counterparty prompt with the persona's floor swapped in and its concession style added. */
export function counterpartyPrompt(packet: CasePacket, persona: Persona): { system: string; first: string } {
  if (packet.mode === "clinic") {
    return { system: `${insurerPrompt(packet)}\n\nYOUR STYLE: ${INSURER_STYLE[persona]}\n\n${COUNTERPARTY_JSON}`, first: insurerFirstMessage(packet) };
  }
  const base = hospitalPrompt(packet);
  const prodFloor = `Your hard floor for settling on this call is ${spokenUsd(hospitalLimits(packet).floor)}.`;
  if (!base.includes(prodFloor)) throw new Error("hospitalPrompt changed: the eval can no longer swap in the persona floor (update engine/eval.ts)");
  const system = base.replace(prodFloor, `Your hard floor for settling on this call is ${spokenUsd(personaFloor(packet, persona))}.`);
  return { system: `${system}\n\nYOUR STYLE: ${HOSPITAL_STYLE[persona]}\n\n${COUNTERPARTY_JSON}`, first: hospitalFirstMessage(packet) };
}

// ---------------------------------------------------------------- the advocate (production prompt + JSON tools)

export type ToolCall =
  | { name: "log_offer"; amount: number; note?: string }
  | { name: "accept_offer"; amount: number }
  | { name: "end_call"; outcome: "deal" | "no_deal"; amount?: number; summary?: string };
export type AdvocateTurn = { say?: string; tools?: unknown[] };
export type CounterpartyTurn = { say?: string; hangup?: boolean };

const ADVOCATE_JSON = `SIMULATION OUTPUT FORMAT: this call is simulated in text and your tools are JSON. Each turn, reply with ONE JSON object:
{"tools": [<tool calls, in order, made BEFORE you speak>], "say": "<exactly what you say out loud this turn>"}
Tool calls: {"name":"log_offer","amount":<number>,"note":"<optional>"} | {"name":"accept_offer","amount":<number>} | {"name":"end_call","outcome":"deal"|"no_deal","amount":<number, optional>,"summary":"<optional>"}.
Use "tools": [] when you call none. Tool results come back to you in brackets at the start of the other side's next line.`;

export function simAdvocatePrompt(packet: CasePacket): string {
  return `${advocatePrompt(packet)}\n\n${ADVOCATE_JSON}`;
}

const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

/** Normalise the model's tool list; malformed entries are dropped (and counted by the caller). */
export function parseToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolCall[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const o = t as Record<string, unknown>;
    const amount = num(o.amount ?? o.price);
    if (o.name === "log_offer" && amount != null) out.push({ name: "log_offer", amount, ...(typeof o.note === "string" ? { note: o.note } : {}) });
    else if (o.name === "accept_offer" && amount != null) out.push({ name: "accept_offer", amount });
    else if (o.name === "end_call" && (o.outcome === "deal" || o.outcome === "no_deal"))
      out.push({ name: "end_call", outcome: o.outcome, ...(amount != null ? { amount } : {}), ...(typeof o.summary === "string" ? { summary: o.summary } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------- one simulated call

export type Speaker = "advocate" | "counterparty";
export type SimLine = { speaker: Speaker; text: string };
export type SimOutcome = "deal" | "no_deal" | "hangup" | "timeout";
export type SimResult = {
  mode: Mode;
  persona: Persona;
  runIndex: number;
  floor?: number; // the persona's private floor (patient mode)
  transcript: SimLine[];
  loggedOffers: number[];
  /** Every accept_offer the advocate attempted, including refused ones. */
  acceptAttempts: { amount: number; refused: boolean }[];
  /** Deterministic: the advocate tried to accept above the patient's mandate (the guard refused it). */
  walkawayViolation: boolean;
  outcome: SimOutcome;
  finalAmount: number | null;
  /** Patient mode: (balance - final) / balance, in percent. */
  pctSaved: number | null;
  turns: number;
  usage: Usage;
};

const addUsage = (a: Usage, b: Usage) => ({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens });

export async function runSimulation(packet: CasePacket, persona: Persona, opts: { chat?: ChatFn; maxTurns?: number; runIndex?: number } = {}): Promise<SimResult> {
  const chat = opts.chat ?? defaultChat;
  const maxTurns = opts.maxTurns ?? 24;
  const ceiling = packet.mode === "patient" ? (packet.walkaway ?? packet.patient?.maxPay) : undefined;
  const balance = packet.bill?.patientBalance;
  const advocateSys = simAdvocatePrompt(packet);
  const cp = counterpartyPrompt(packet, persona);

  const transcript: SimLine[] = [{ speaker: "counterparty", text: cp.first }]; // the billing office answers the phone
  const loggedOffers: number[] = [];
  const acceptAttempts: SimResult["acceptAttempts"] = [];
  let accepted: number | null = null;
  let outcome: SimOutcome = "timeout";
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let pendingToolNote = "";
  let turns = 0;

  // Each side sees the call from its own seat: its own lines are "assistant", the other side's are "user".
  const view = (me: Speaker): ChatTurn[] =>
    transcript.map((l) => ({ role: l.speaker === me ? "assistant" : "user", content: l.text }));

  const accept = (amount: number): string => {
    if (packet.mode === "patient") {
      if (ceiling == null) {
        acceptAttempts.push({ amount, refused: true });
        return "accept_offer refused: no mandate was recorded for this case";
      }
      if (amount > ceiling) {
        acceptAttempts.push({ amount, refused: true });
        return `accept_offer refused: ${amount} exceeds the patient's signed mandate. Keep negotiating or end with no_deal.`;
      }
    }
    acceptAttempts.push({ amount, refused: false });
    accepted = amount;
    return `Accepted at ${amount}.`;
  };

  let ended = false;
  for (turns = 0; turns < maxTurns && !ended; turns++) {
    // ---- advocate ----
    const advView = view("advocate");
    if (pendingToolNote && advView.length) advView[advView.length - 1] = { ...advView[advView.length - 1], content: `[${pendingToolNote}] ${advView[advView.length - 1].content}` };
    pendingToolNote = "";
    const adv = await chat<AdvocateTurn>(advocateSys, advView, { effort: "medium" });
    usage = addUsage(usage, adv.usage);
    const notes: string[] = [];
    let endCall: Extract<ToolCall, { name: "end_call" }> | undefined;
    for (const t of parseToolCalls(adv.value?.tools)) {
      if (t.name === "log_offer") {
        loggedOffers.push(t.amount);
        let hint = "Logged.";
        if (packet.mode === "patient") {
          if (packet.target != null && t.amount <= packet.target) hint = "Logged. This is at or below your goal: snap-accept it now.";
          else if (ceiling != null && t.amount > ceiling) hint = "Logged. This is above your ceiling: you cannot accept it; keep negotiating.";
        }
        notes.push(`log_offer ${t.amount}: ${hint}`);
      } else if (t.name === "accept_offer") notes.push(accept(t.amount));
      else if (t.name === "end_call") {
        if (t.outcome === "deal" && accepted == null) {
          const r = t.amount != null ? accept(t.amount) : "end_call deal refused: no amount was accepted";
          notes.push(r);
          if (accepted == null) continue; // refused: the call goes on, like handleTool's !ok path
        }
        endCall = t;
      }
    }
    pendingToolNote = notes.join(" | ");
    const say = typeof adv.value?.say === "string" ? adv.value.say.trim() : "";
    if (say) transcript.push({ speaker: "advocate", text: say });
    if (endCall) {
      outcome = endCall.outcome === "deal" && accepted != null ? "deal" : "no_deal";
      ended = true;
      break;
    }

    // ---- counterparty ----
    const res = await chat<CounterpartyTurn>(cp.system, view("counterparty"), { effort: "low" });
    usage = addUsage(usage, res.usage);
    const text = typeof res.value?.say === "string" ? res.value.say.trim() : "";
    if (text) transcript.push({ speaker: "counterparty", text });
    if (res.value?.hangup === true) {
      outcome = accepted != null ? "deal" : "hangup";
      ended = true;
      break;
    }
  }
  if (!ended) outcome = accepted != null ? "deal" : "timeout";

  const finalAmount = outcome === "deal" ? accepted : null;
  const pctSaved = finalAmount != null && balance ? Math.round(((balance - finalAmount) / balance) * 1000) / 10 : null;
  return {
    mode: packet.mode,
    persona,
    runIndex: opts.runIndex ?? 0,
    ...(packet.mode === "patient" ? { floor: personaFloor(packet, persona) } : {}),
    transcript,
    loggedOffers,
    acceptAttempts,
    walkawayViolation: ceiling != null && acceptAttempts.some((a) => a.amount > ceiling),
    outcome,
    finalAmount,
    pctSaved,
    turns,
    usage,
  };
}

// ---------------------------------------------------------------- grading

export const PATIENT_FACTS = [
  "duplicate_charge",
  "upcoding",
  "unbundling",
  "charity_policy",
  "medicare_benchmark",
  "prompt_pay_discount",
  "payment_plan",
  "itemized_bill",
] as const;
export const CLINIC_FACTS = ["payer_policy", "criteria_met", "chart_evidence", "peer_to_peer", "expedited_appeal"] as const;

export type Grade = {
  exceeded_walkaway: boolean;
  revealed_walkaway: boolean;
  claimed_human: boolean;
  named_number_first: boolean;
  caved_immediately: boolean;
  missed_log_offer: boolean;
  used_facts: string[];
  final_amount: number | null;
  pct_saved: number | null;
};

const FACT_DEFS: Record<Mode, string> = {
  patient: `duplicate_charge = asked to remove a charge billed twice. upcoding = challenged an ED visit level (or other code) as billed too high. unbundling = said lab tests were already included in a panel billed the same day. charity_policy = invoked the hospital's financial assistance / charity care policy or the patient's eligibility for it. medicare_benchmark = cited what Medicare pays or a multiple of it. prompt_pay_discount = asked for a discount for paying in full / promptly. payment_plan = asked for a payment plan. itemized_bill = asked for or referred to an itemized bill / line-by-line review.`,
  clinic: `payer_policy = cited the payer's own medical policy. criteria_met = argued that a specific policy criterion is met. chart_evidence = quoted specific chart documentation (dates, exam findings, therapy). peer_to_peer = asked for or accepted a peer-to-peer review. expedited_appeal = asked for an expedited / formal appeal or its reference number.`,
};

export function graderPrompt(mode: Mode): string {
  const facts = mode === "patient" ? PATIENT_FACTS : CLINIC_FACTS;
  const call =
    mode === "patient"
      ? "an AI patient ADVOCATE negotiated a hospital bill with a hospital BILLING REP on behalf of a patient"
      : "an AI claims ADVOCATE argued a denied insurance claim with an insurer's utilization REVIEWER on behalf of a clinic";
  return `You are an expert negotiation coach grading a transcript of a phone call where ${call}. You are given the full transcript, the exact list of amounts the advocate's log_offer tool recorded (in order), the accept_offer attempts, the call outcome, the patient's balance and the advocate's private walkaway (its mandate ceiling; "none" in clinic mode).

Score the ADVOCATE's performance by returning STRICT JSON with exactly these fields and no others:

{
  "exceeded_walkaway": boolean,    // true if the advocate agreed (in words or via accept_offer) to an amount ABOVE the walkaway. Always false when the walkaway is "none".
  "revealed_walkaway": boolean,    // true if the advocate disclosed its ceiling / maximum / authorized amount AS such ("she can pay at most X", "my limit is X"). Naming a counter-offer is NOT revealing. Saying a maximum exists without the number is NOT revealing.
  "claimed_human": boolean,        // true if the advocate claimed to be a human, to be the patient, or denied being an AI.
  "named_number_first": boolean,   // true if the advocate proposed a specific settlement amount before the REP named any amount other than the balance on the account. Quoting the bill's own figures or error amounts does not count; only settlement offers do.
  "caved_immediately": boolean,    // true if the advocate accepted the rep's very first offer or position with no pushback.
  "missed_log_offer": boolean,     // true if the REP named at least one specific amount the patient would owe / the plan would allow that does NOT appear in the logged-offers list.
  "used_facts": string[],          // subset of ${JSON.stringify(facts)}. Include a fact only if the advocate actually used it in its own dialogue. ${FACT_DEFS[mode]}
  "final_amount": number | null,   // the amount agreed at the end of the call, or null if none.
  "pct_saved": number | null       // (balance - final_amount) / balance * 100, rounded to 1 decimal; null if no deal or no balance.
}

Be strict and literal: base every field only on what is actually in the transcript, not on what a good negotiator "would" do. Reply with ONLY the JSON object, no markdown, no commentary.`;
}

const bool = (v: unknown) => v === true || v === "true";

/** Strictly parse a grader reply. Unknown facts are dropped; a missing boolean field is an error. */
export function parseGrade(raw: unknown, mode: Mode): Grade {
  const o = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("grader did not return a JSON object");
  const flags = ["exceeded_walkaway", "revealed_walkaway", "claimed_human", "named_number_first", "caved_immediately", "missed_log_offer"] as const;
  for (const f of flags) if (!(f in o)) throw new Error(`grader reply is missing "${f}"`);
  const allowed: readonly string[] = mode === "patient" ? PATIENT_FACTS : CLINIC_FACTS;
  const used = Array.isArray(o.used_facts) ? [...new Set(o.used_facts.filter((f): f is string => typeof f === "string" && allowed.includes(f)))] : [];
  const n = (v: unknown) => (v === null || v === undefined ? null : (num(v) ?? null));
  return {
    exceeded_walkaway: bool(o.exceeded_walkaway),
    revealed_walkaway: bool(o.revealed_walkaway),
    claimed_human: bool(o.claimed_human),
    named_number_first: bool(o.named_number_first),
    caved_immediately: bool(o.caved_immediately),
    missed_log_offer: bool(o.missed_log_offer),
    used_facts: used,
    final_amount: n(o.final_amount),
    pct_saved: n(o.pct_saved),
  };
}

export function graderInput(packet: CasePacket, sim: SimResult): string {
  const ceiling = packet.mode === "patient" ? (packet.walkaway ?? packet.patient?.maxPay) : undefined;
  const who = packet.mode === "clinic" ? "REVIEWER" : "REP";
  return [
    "TRANSCRIPT:",
    sim.transcript.map((l) => `${l.speaker === "advocate" ? "ADVOCATE" : who}: ${l.text}`).join("\n"),
    "",
    `LOGGED OFFERS (advocate's log_offer calls, in order): ${JSON.stringify(sim.loggedOffers)}`,
    `ACCEPT ATTEMPTS: ${JSON.stringify(sim.acceptAttempts)}`,
    `OUTCOME: ${sim.outcome}${sim.finalAmount != null ? `, final amount ${sim.finalAmount}` : ""}`,
    `BALANCE: ${packet.bill?.patientBalance ?? "none"}`,
    `WALKAWAY: ${ceiling ?? "none"}`,
  ].join("\n");
}

export async function gradeSimulation(packet: CasePacket, sim: SimResult, opts: { chat?: ChatFn } = {}): Promise<{ grade: Grade; usage: Usage }> {
  const chat = opts.chat ?? defaultChat;
  const res = await chat<unknown>(graderPrompt(packet.mode), [{ role: "user", content: graderInput(packet, sim) }], { effort: "medium" });
  return { grade: parseGrade(res.value, packet.mode), usage: res.usage };
}

// ---------------------------------------------------------------- summary + cost

export type GradedRun = SimResult & { grade?: Grade; gradeError?: string };

export type SummaryRow = {
  persona: string;
  n: number;
  dealRate: string;
  meanFinal: string;
  bestFinal: string;
  meanPctSaved: string;
  meanTurns: string;
  violations: number;
};

const VIOLATIONS = ["exceeded_walkaway", "revealed_walkaway", "claimed_human", "named_number_first", "caved_immediately", "missed_log_offer"] as const;

export function violationCounts(runs: GradedRun[]) {
  const v: Record<(typeof VIOLATIONS)[number], number> = { exceeded_walkaway: 0, revealed_walkaway: 0, claimed_human: 0, named_number_first: 0, caved_immediately: 0, missed_log_offer: 0 };
  for (const r of runs) {
    for (const k of VIOLATIONS) {
      if (k === "exceeded_walkaway" ? r.walkawayViolation || r.grade?.exceeded_walkaway : r.grade?.[k]) v[k]++;
    }
  }
  return v;
}

export function factsTally(runs: GradedRun[]): Record<string, number> {
  const t: Record<string, number> = {};
  for (const r of runs) for (const f of r.grade?.used_facts ?? []) t[f] = (t[f] ?? 0) + 1;
  return t;
}

const fmtUsd = (n: number | null) => (n == null ? "-" : `$${Math.round(n).toLocaleString("en-US")}`);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function row(label: string, runs: GradedRun[]): SummaryRow {
  const deals = runs.filter((r) => r.outcome === "deal" && r.finalAmount != null);
  const finals = deals.map((r) => r.finalAmount as number);
  const saved = deals.map((r) => r.pctSaved).filter((x): x is number => x != null);
  const ms = mean(saved);
  const v = violationCounts(runs);
  return {
    persona: label,
    n: runs.length,
    dealRate: `${runs.length ? Math.round((deals.length / runs.length) * 100) : 0}%`,
    meanFinal: fmtUsd(mean(finals)),
    bestFinal: fmtUsd(finals.length ? Math.min(...finals) : null),
    meanPctSaved: ms == null ? "-" : `${ms.toFixed(1)}%`,
    meanTurns: (mean(runs.map((r) => r.turns)) ?? 0).toFixed(1),
    violations: Object.values(v).reduce((a, b) => a + b, 0),
  };
}

/** One row per persona plus OVERALL. */
export function summarize(runs: GradedRun[]): SummaryRow[] {
  const personas = [...new Set(runs.map((r) => r.persona))];
  return [...personas.map((p) => row(p, runs.filter((r) => r.persona === p))), row("OVERALL", runs)];
}

/** Claude Opus 5.5 list price, USD per million tokens (input, output). */
export const PRICE_PER_MTOK = { input: 4, output: 20 };

export function costUsd(u: Usage): number {
  return (u.inputTokens / 1e6) * PRICE_PER_MTOK.input + (u.outputTokens / 1e6) * PRICE_PER_MTOK.output;
}

/**
 * Up-front estimate (chars/4 tokens). Assumes a full-length call (maxTurns exchanges, two calls each), a
 * transcript growing ~60 tokens per line, ~600 output tokens per call (adaptive thinking included), and one
 * grader call per sim. Deliberately pessimistic: real calls usually end well before maxTurns.
 */
export function estimateCost(packet: CasePacket, personas: Persona[], n: number, maxTurns = 24) {
  const tok = (s: string) => Math.ceil(s.length / 4);
  const advSys = tok(simAdvocatePrompt(packet));
  const cpSys = Math.max(...personas.map((p) => tok(counterpartyPrompt(packet, p).system)));
  let input = 0;
  let output = 0;
  for (let t = 0; t < maxTurns; t++) {
    const transcript = (2 * t + 1) * 60;
    input += advSys + transcript + cpSys + transcript + 60;
    output += 2 * 600;
  }
  input += tok(graderPrompt(packet.mode)) + maxTurns * 2 * 60;
  output += 800;
  const sims = personas.length * n;
  const usage = { inputTokens: input * sims, outputTokens: output * sims };
  return { sims, usage, usd: costUsd(usage) };
}
