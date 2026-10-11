import type { FastifyInstance } from "fastify";
import { addReceipt, emit, requireCase, updateCase } from "../store.js";
import { fetchFedOdds, fetchPolicyRate, financingAdvice, impliedRateChangeBps, placeHedge } from "../markets/gemini.js";
import { jsonErrors, upstream } from "./errors.js";

type FinancingBody = {
  lumpSumDiscountPct?: number; // prompt-pay discount the hospital offers for paying in full now
  planMonths?: number;
  planAprPct?: number;
  fundLumpSumWith?: "savings" | "card";
  planVariable?: boolean;
};

// Scenario defaults (labeled assumptions, overridable in the body): a 10% prompt-pay discount vs a 12-month
// 0% in-house plan — the two options hospitals typically put in front of a self-pay patient.
const DEFAULTS = { lumpSumDiscountPct: 10, planMonths: 12, planAprPct: 0 };

/** Both public sources (Gemini prediction markets, FRED) are keyless; bound them so a stalled upstream cannot hang a request. */
const UPSTREAM_TIMEOUT_MS = 8000;
const timedFetch = (url: string, init?: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });

async function marketInputs() {
  return Promise.all([
    fetchFedOdds(timedFetch).catch((e) => Promise.reject(upstream("Gemini prediction-markets API", e))),
    fetchPolicyRate(timedFetch).catch((e) => Promise.reject(upstream("FRED policy-rate feed", e))),
  ]);
}

const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

/** Validate the overridable scenario before any network call: a non-number used to reach financingAdvice as NaN. */
function scenario(raw: unknown) {
  if (raw !== null && raw !== undefined && (typeof raw !== "object" || Array.isArray(raw))) throw bad("body must be a JSON object");
  const b = (raw ?? {}) as FinancingBody;
  const num = (k: keyof typeof DEFAULTS, ok: (n: number) => boolean, rule: string) => {
    const v = b[k];
    if (v === undefined || v === null) return DEFAULTS[k];
    if (typeof v !== "number" || !Number.isFinite(v) || !ok(v)) throw bad(`${k} must be ${rule}`);
    return v;
  };
  const lumpSumDiscountPct = num("lumpSumDiscountPct", (n) => n >= 0 && n < 100, "a number in [0, 100)");
  const planMonths = num("planMonths", (n) => Number.isInteger(n) && n >= 1 && n <= 120, "an integer 1-120");
  const planAprPct = num("planAprPct", (n) => n >= 0 && n <= 100, "a number in [0, 100]");
  if (b.fundLumpSumWith !== undefined && b.fundLumpSumWith !== "savings" && b.fundLumpSumWith !== "card")
    throw bad('fundLumpSumWith must be "savings" or "card"');
  if (b.planVariable !== undefined && typeof b.planVariable !== "boolean") throw bad("planVariable must be a boolean");
  return { lumpSumDiscountPct, planMonths, planAprPct, fundLumpSumWith: b.fundLumpSumWith, planVariable: b.planVariable };
}

export default async function marketsRoutes(app: FastifyInstance) {
  jsonErrors(app);

  // Public Gemini Fed-decision odds + the policy rate they move.
  app.get("/api/markets/fed", async () => {
    const [odds, rate] = await marketInputs();
    return { ...odds, impliedRateChangeBps: Math.round(impliedRateChangeBps(odds) * 10) / 10, policyRate: rate };
  });

  // Lump sum vs payment plan for this case's balance, decided by the market-implied rate path.
  app.post<{ Params: { id: string }; Body: FinancingBody | null }>("/api/cases/:id/financing", async (req) => {
    const c = requireCase(req.params.id);
    const s = scenario(req.body);
    const balance = c.agreedAmount ?? c.target ?? c.bill?.patientBalance;
    if (!balance) throw Object.assign(new Error("case has no agreedAmount, target or bill balance yet"), { statusCode: 409 });
    const [odds, rate] = await marketInputs();
    const advice = financingAdvice(balance, s.lumpSumDiscountPct, s.planMonths, s.planAprPct, {
      odds,
      policyRatePct: rate.upperPct,
      policyRateSource: rate.source,
      fundLumpSumWith: s.fundLumpSumWith,
      planVariable: s.planVariable,
    });
    updateCase(c.id, { financing: advice });
    emit(c.id, { type: "log", message: advice.reason, messageZh: advice.reasonZh });
    return advice;
  });

  // OPTIONAL (not in API.md yet): small YES hedge on the hike outcome in the Gemini SANDBOX, recorded as a Receipt.
  app.post<{ Params: { id: string }; Body: { quantity?: string } | null }>("/api/cases/:id/hedge", async (req) => {
    const c = requireCase(req.params.id);
    if (!process.env.GEMINI_API_KEY || !process.env.GEMINI_API_SECRET) {
      throw Object.assign(new Error("Gemini sandbox trading is not configured — set GEMINI_API_KEY and GEMINI_API_SECRET in vellum/server/.env"), { statusCode: 503 });
    }
    const receipt = await placeHedge({ quantity: req.body?.quantity }).catch((e) => Promise.reject(upstream("Gemini sandbox", e)));
    addReceipt(c.id, receipt);
    return receipt;
  });
}
