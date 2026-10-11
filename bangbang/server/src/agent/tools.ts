// ElevenLabs Conversational AI tool definitions + the PURE tool handler that applies a tool call
// to the case store. Tool JSON follows the ElevenLabs REST shape (POST /v1/convai/tools,
// `tool_config` with snake_case keys): webhook = {type:"webhook", name, description,
// api_schema:{url, method, request_body_schema}}, client = {type:"client", name, description,
// parameters, expects_response}. Verified against elevenlabs.io/docs/api-reference/tools/create.
import { emit, requireCase, updateCase } from "../store.js";
import type { CasePacket, Offer, Patient } from "../types.js";

export type ToolName = "log_offer" | "accept_offer" | "end_call" | "submit_intake";
export const TOOL_NAMES: ToolName[] = ["log_offer", "accept_offer", "end_call", "submit_intake"];

type Prop = { type: "number" | "string" | "boolean" | "integer"; description: string; enum?: string[] };

const SPECS: Record<ToolName, { description: string; properties: Record<string, Prop>; required: string[] }> = {
  log_offer: {
    description:
      "Log an amount the other side (billing office or insurer) just named. Call this the moment any amount is said, BEFORE responding.",
    properties: {
      amount: { type: "number", description: "Amount in US dollars, as a plain number (e.g. 9800)" },
      note: { type: "string", description: "Short context, e.g. 'after removing duplicate CT charge'" },
    },
    required: ["amount"],
  },
  accept_offer: {
    description:
      "Accept the deal at this amount. Refused if it exceeds the patient's signed mandate — if refused, keep negotiating or end with no_deal.",
    properties: { amount: { type: "number", description: "Agreed amount in US dollars, plain number" } },
    required: ["amount"],
  },
  end_call: {
    description: "Signal the final outcome right before hanging up.",
    properties: {
      outcome: { type: "string", description: "deal or no_deal", enum: ["deal", "no_deal"] },
      amount: { type: "number", description: "Final agreed amount in US dollars if outcome is deal" },
      summary: { type: "string", description: "One-sentence summary of what was agreed or why there was no deal" },
    },
    required: ["outcome"],
  },
  submit_intake: {
    description:
      "Submit the patient's intake once name, household size, annual income, max payment and explicit consent are collected.",
    properties: {
      name: { type: "string", description: "Patient's name as she gave it" },
      household_size: { type: "integer", description: "People in the household, including her" },
      annual_income: { type: "number", description: "Household annual income in US dollars" },
      max_pay: { type: "number", description: "The most she authorizes paying for this bill, US dollars" },
      consent: { type: "boolean", description: "true only if she explicitly agreed to let BangBang negotiate for her" },
    },
    required: ["name", "max_pay", "consent"],
  },
};

function objectSchema(name: ToolName, withCaseId: boolean) {
  const spec = SPECS[name];
  const properties: Record<string, unknown> = { ...spec.properties };
  // case_id comes from the conversation's dynamic variables, not from the LLM.
  if (withCaseId) properties.case_id = { type: "string", dynamic_variable: "case_id" };
  return { type: "object", required: withCaseId ? [...spec.required, "case_id"] : spec.required, properties };
}

/** Server (webhook) tool → ElevenLabs POSTs to `${baseUrl}/api/eleven/tools/<name>` with the args + case_id. */
export function elevenWebhookTool(name: ToolName, baseUrl: string) {
  return {
    type: "webhook" as const,
    name,
    description: SPECS[name].description,
    response_timeout_secs: 20,
    api_schema: {
      url: `${baseUrl.replace(/\/$/, "")}/api/eleven/tools/${name}`,
      method: "POST" as const,
      request_body_schema: objectSchema(name, true),
    },
  };
}

/** Client tool → handled by the browser SDK's clientTools; the page forwards it to the server. */
export function elevenClientTool(name: ToolName) {
  return {
    type: "client" as const,
    name,
    description: SPECS[name].description,
    expects_response: true,
    response_timeout_secs: 20,
    parameters: objectSchema(name, false),
  };
}

export type AgentRole = "advocate" | "intake" | "hospital" | "insurer";
export function toolNamesFor(role: AgentRole): ToolName[] {
  if (role === "advocate") return ["log_offer", "accept_offer", "end_call"];
  if (role === "intake") return ["submit_intake"];
  return []; // counterparties don't get tools — the advocate logs everything
}

export function webhookToolsFor(role: AgentRole, baseUrl: string) {
  return toolNamesFor(role).map((n) => elevenWebhookTool(n, baseUrl));
}

export function clientToolsFor(role: AgentRole) {
  return toolNamesFor(role).map((n) => elevenClientTool(n));
}

// ---------- handler ----------
export type ToolResult = { ok: boolean; message: string; packet?: CasePacket };

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[$,\s]/g, ""));
    if (v.trim() && Number.isFinite(n)) return n;
  }
  return undefined;
}

function bool(v: unknown): boolean {
  return v === true || v === "true" || v === "yes";
}

function counterparty(c: CasePacket): Offer["by"] {
  return c.mode === "clinic" ? "insurer" : "hospital";
}

/** The ceiling the advocate may never exceed (patient mode). undefined = no mandate recorded. */
export function ceilingOf(c: CasePacket): number | undefined {
  return c.walkaway ?? c.patient?.maxPay;
}

/**
 * Apply one tool call to the case store. Returns a message the voice agent hears back.
 * Never throws for bad args — the agent gets `ok:false` + a reason so it can recover on the call.
 * Throws only for an unknown case (404, via requireCase).
 */
export function handleTool(caseId: string, name: string, args: Record<string, unknown> = {}): ToolResult {
  const c = requireCase(caseId);
  const now = new Date().toISOString();

  switch (name as ToolName) {
    case "log_offer": {
      const amount = num(args.amount ?? args.price);
      if (amount == null || amount < 0) return { ok: false, message: "log_offer needs a non-negative numeric amount" };
      const offer: Offer = { by: counterparty(c), amount, at: now, ...(typeof args.note === "string" && args.note ? { note: args.note } : {}) };
      c.offers.push(offer);
      emit(caseId, { type: "offer", offer });
      const packet = c.status === "negotiating" ? updateCase(caseId, {}) : updateCase(caseId, { status: "negotiating" });
      let hint = "Logged.";
      if (c.mode === "patient") {
        const ceiling = ceilingOf(c);
        if (c.target != null && amount <= c.target) hint = "Logged. This is at or below your goal — snap-accept it now.";
        else if (ceiling != null && amount > ceiling) hint = "Logged. This is above your ceiling — you cannot accept it; keep negotiating.";
      }
      return { ok: true, message: hint, packet };
    }

    case "accept_offer":
      return accept(caseId, c, num(args.amount ?? args.price), now);

    case "end_call": {
      const outcome = args.outcome === "deal" ? "deal" : args.outcome === "no_deal" ? "no_deal" : undefined;
      if (!outcome) return { ok: false, message: "end_call needs outcome 'deal' or 'no_deal'" };
      const summary = typeof args.summary === "string" ? args.summary : undefined;
      if (outcome === "deal") {
        if (c.agreedAmount == null) {
          // The agent skipped accept_offer — run the same guarded path.
          const r = accept(caseId, c, num(args.amount ?? args.price), now);
          if (!r.ok) return r;
        }
        emit(caseId, { type: "log", message: `Call ended with a deal at $${c.agreedAmount}${summary ? `: ${summary}` : ""}` });
        return { ok: true, message: "Call ended with a deal.", packet: c };
      }
      emit(caseId, { type: "log", message: `Call ended with no deal${summary ? `: ${summary}` : ""}`, messageZh: "本次通话未达成协议" });
      const packet = c.agreedAmount == null ? updateCase(caseId, { status: "failed" }) : c;
      return { ok: true, message: "Call ended with no deal.", packet };
    }

    case "submit_intake": {
      const pname = typeof args.name === "string" ? args.name.trim() : "";
      const maxPay = num(args.max_pay ?? args.maxPay);
      const householdSize = num(args.household_size ?? args.householdSize);
      const annualIncome = num(args.annual_income ?? args.annualIncome);
      const consent = bool(args.consent);
      if (!pname) return { ok: false, message: "submit_intake needs her name" };
      if (maxPay == null || maxPay <= 0) return { ok: false, message: "submit_intake needs a positive max_pay in dollars" };
      const patient: Patient = {
        name: pname,
        language: "zh",
        maxPay,
        consent,
        ...(householdSize != null ? { householdSize: Math.round(householdSize) } : {}),
        ...(annualIncome != null ? { annualIncome } : {}),
      };
      if (!consent) {
        updateCase(caseId, { patient });
        emit(caseId, { type: "log", message: "Patient did not consent — BangBang will not negotiate", messageZh: "您没有授权，帮帮不会代表您协商" });
        return { ok: true, message: "Recorded. She did not consent, so no negotiation will happen. Thank her and end politely." };
      }
      const packet = updateCase(caseId, { patient, walkaway: maxPay });
      emit(caseId, { type: "log", message: `Intake complete: ${pname}, max $${maxPay}`, messageZh: `信息已记录：${pname}，最高支付 ${maxPay} 美元` });
      return { ok: true, message: "Intake saved. Tell her the next steps in Chinese.", packet };
    }

    default:
      return { ok: false, message: `unknown tool ${name}` };
  }
}

function accept(caseId: string, c: CasePacket, amount: number | undefined, now: string): ToolResult {
  if (amount == null || amount < 0) return { ok: false, message: "accept_offer needs a non-negative numeric amount" };
  if (c.agreedAmount != null) return { ok: false, message: `A deal is already recorded at ${c.agreedAmount}.` };
  if (c.mode === "patient") {
    const ceiling = ceilingOf(c);
    if (ceiling == null) return { ok: false, message: "REFUSED: no patient mandate is recorded — you cannot accept any amount." };
    if (c.patient && !c.patient.consent) return { ok: false, message: "REFUSED: the patient has not consented." };
    if (amount > ceiling) {
      emit(caseId, { type: "log", message: `Refused to accept $${amount}: above the patient's mandate`, messageZh: `已拒绝 ${amount} 美元：超过您设定的上限` });
      return { ok: false, message: "REFUSED: that amount is above the patient's signed mandate. Keep negotiating or end with no_deal." };
    }
  }
  const offer: Offer = { by: "advocate", amount, at: now, note: "accepted" };
  c.offers.push(offer);
  emit(caseId, { type: "offer", offer });
  const packet = updateCase(caseId, { agreedAmount: amount, status: "agreed" });
  emit(caseId, { type: "deal", amount });
  return { ok: true, message: `Accepted at ${amount}. Confirm it out loud and ask for a written zero-balance confirmation.`, packet };
}
