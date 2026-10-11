import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { lookupFairPrice } from "../research/fairprice.js";
import { draftAppeal } from "../claims/appeal.js";
import { listPayments, requirePayment, settlePayment } from "../chain/x402.js";
import type { ClaimCase } from "../types.js";
import { jsonErrors } from "./errors.js";

export const FAIR_PRICE_AUSD = "0.05";
export const APPEAL_AUSD = "0.50";

// Run the paid work, then settle; a failure in either is returned as {error} and the payer is not charged
// when the work fails (settlement only happens after success).
async function paidWork<T>(req: FastifyRequest, reply: FastifyReply, caseId: string | undefined, work: () => Promise<T>) {
  let result: T;
  try {
    result = await work();
  } catch (e) {
    return reply.code(502).send({ error: `paid call failed before settlement (not charged): ${(e as Error).message}` });
  }
  try {
    await settlePayment(req, reply, caseId);
  } catch (e) {
    return reply.code(402).send({ error: (e as Error).message });
  }
  return result;
}

export default async function x402Routes(app: FastifyInstance) {
  jsonErrors(app);
  app.get<{ Querystring: { code?: string; description?: string; hospital?: string; case?: string } }>(
    "/x402/fair-price",
    {
      preHandler: [
        async (req, reply) => {
          if (!req.query.code) return reply.code(400).send({ error: "code is required" });
        },
        requirePayment(FAIR_PRICE_AUSD, "Fair price for a billing code: Medicare rate, hospital cash price, negotiated median"),
      ],
    },
    async (req, reply) =>
      paidWork(req, reply, req.query.case, () => lookupFairPrice(req.query.code!, req.query.description ?? "", req.query.hospital)),
  );

  app.post<{ Body: { claim?: ClaimCase } & Partial<ClaimCase>; Querystring: { case?: string } }>(
    "/x402/appeal",
    {
      preHandler: [
        async (req, reply) => {
          const claim = req.body?.claim ?? req.body;
          if (!claim?.payer || !claim?.procedure) return reply.code(400).send({ error: "body must be a ClaimCase (or {claim})" });
        },
        requirePayment(APPEAL_AUSD, "Medical-necessity appeal letter drafted against the payer's policy"),
      ],
    },
    async (req, reply) => paidWork(req, reply, req.query.case, () => draftAppeal((req.body.claim ?? req.body) as ClaimCase)),
  );

  app.get("/api/x402/payments", async () => listPayments());
}
