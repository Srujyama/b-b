import type { FastifyInstance, FastifyReply } from "fastify";
import { openMandate, readLedger } from "../chain/bnb.js";
import { requireCase, updateCase, emit } from "../store.js";

// BNB Chain AdvocateLedger routes (see docs/API.md). Other modules call appendLog/recordDeal from chain/bnb.ts directly.
function fail(reply: FastifyReply, err: unknown) {
  const e = err as Error & { statusCode?: number };
  const msg = e?.message ?? String(err);
  const code = e.statusCode ?? (/is not configured/.test(msg) ? 503 : 502);
  return reply.code(code).send({ error: msg });
}

export default async function bnbRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>("/api/cases/:id/mandate", async (req, reply) => {
    try {
      requireCase(req.params.id);
      const receipt = await openMandate(req.params.id);
      updateCase(req.params.id, { status: "mandated" });
      emit(req.params.id, {
        type: "log",
        message: `Mandate recorded on BNB Chain: the agent may not settle above the patient's cap`,
        messageZh: "您的授权已记录在 BNB 链上：代理人不能同意超过您设定上限的金额",
      });
      return receipt;
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/api/cases/:id/ledger", async (req, reply) => {
    try {
      requireCase(req.params.id);
      return await readLedger(req.params.id);
    } catch (err) {
      return fail(reply, err);
    }
  });
}
