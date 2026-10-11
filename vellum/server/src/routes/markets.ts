import type { FastifyInstance } from "fastify";
import { addReceipt, emit, requireCase, updateCase } from "../store.js";
import { fetchFedOdds, fetchPolicyRate, financingAdvice, impliedRateChangeBps, placeHedge } from "../markets/gemini.js";

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

export default async function marketsRoutes(app: FastifyInstance) {
  // Public Gemini Fed-decision odds + the policy rate they move.
  app.get("/api/markets/fed", async () => {
    const [odds, rate] = await Promise.all([fetchFedOdds(), fetchPolicyRate()]);
    return { ...odds, impliedRateChangeBps: Math.round(impliedRateChangeBps(odds) * 10) / 10, policyRate: rate };
  });

  // Lump sum vs payment plan for this case's balance, decided by the market-implied rate path.
  app.post<{ Params: { id: string }; Body: FinancingBody | null }>("/api/cases/:id/financing", async (req) => {
    const c = requireCase(req.params.id);
    const b = req.body ?? {};
    const balance = c.agreedAmount ?? c.target ?? c.bill?.patientBalance;
    if (!balance) throw Object.assign(new Error("case has no agreedAmount, target or bill balance yet"), { statusCode: 409 });
    const [odds, rate] = await Promise.all([fetchFedOdds(), fetchPolicyRate()]);
    const advice = financingAdvice(
      balance,
      b.lumpSumDiscountPct ?? DEFAULTS.lumpSumDiscountPct,
      b.planMonths ?? DEFAULTS.planMonths,
      b.planAprPct ?? DEFAULTS.planAprPct,
      { odds, policyRatePct: rate.upperPct, policyRateSource: rate.source, fundLumpSumWith: b.fundLumpSumWith, planVariable: b.planVariable },
    );
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
    const receipt = await placeHedge({ quantity: req.body?.quantity });
    addReceipt(c.id, receipt);
    return receipt;
  });
}
