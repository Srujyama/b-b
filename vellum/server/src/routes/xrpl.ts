import type { FastifyInstance, FastifyReply } from "fastify";
import { addReceipt, emit, requireCase, updateCase } from "../store.js";
import type { Receipt } from "../types.js";
import { createSettlementEscrow, defaultCtx, escrowFor, issueHardshipCredential, releaseOnZeroBalance } from "../chain/xrpl.js";
import { fundIdsFromEnv, openZeroInterestLoan } from "../chain/xrplFund.js";
import { jsonErrors } from "./errors.js";

type IdParams = { Params: { id: string } };

/** Map errors: missing config -> 503, explicit statusCode (404/409) -> as-is, chain failure -> 502. */
function fail(reply: FastifyReply, err: unknown) {
  const e = err as Error & { statusCode?: number };
  const msg = e?.message ?? String(err);
  const code = /not configured/i.test(msg) ? 503 : e?.statusCode && e.statusCode < 600 ? e.statusCode : 502;
  return reply.code(code).send({ error: msg });
}

function record(id: string, receipts: Receipt[]) {
  for (const r of receipts) addReceipt(id, r);
  return receipts;
}

function agreedAmount(id: string): number {
  const c = requireCase(id);
  if (!c.agreedAmount || c.agreedAmount <= 0) {
    throw Object.assign(new Error("case has no agreedAmount yet — finish the negotiation first"), { statusCode: 409 });
  }
  return c.agreedAmount;
}

export default async function xrplRoutes(app: FastifyInstance) {
  jsonErrors(app);
  // Clinic social worker attests FinancialHardship (CredentialCreate), patient accepts (CredentialAccept)
  app.post<IdParams>("/api/cases/:id/credential", async (req, reply) => {
    try {
      const { id } = req.params;
      requireCase(id);
      emit(id, { type: "log", message: "Issuing FinancialHardship credential on XRPL", messageZh: "正在 XRPL 上签发经济困难证明" });
      return record(id, await issueHardshipCredential(id));
    } catch (e) {
      return fail(reply, e);
    }
  });

  // Lock the agreed amount in a conditional escrow (fulfillment stays server-side)
  app.post<IdParams>("/api/cases/:id/settle", async (req, reply) => {
    try {
      const { id } = req.params;
      const amount = agreedAmount(id);
      emit(id, { type: "log", message: `Locking ${amount} USD in XRPL escrow for the hospital`, messageZh: `正在把 ${amount} 美元锁入 XRPL 托管` });
      const { receipt } = await createSettlementEscrow(id, amount);
      return record(id, [receipt]);
    } catch (e) {
      return fail(reply, e);
    }
  });

  // Hospital confirms a zero balance -> Batch [EscrowFinish + advocate fee], all-or-nothing
  app.post<IdParams>("/api/cases/:id/confirm-zero-balance", async (req, reply) => {
    try {
      const { id } = req.params;
      requireCase(id);
      if (!escrowFor(id)) return reply.code(409).send({ error: "no open escrow for this case — POST /settle first" });
      const receipts = record(id, await releaseOnZeroBalance(id));
      emit(id, { type: "log", message: "Hospital confirmed $0 balance; escrow released", messageZh: "医院已确认余额为零，托管款已放行" });
      updateCase(id, { status: "settled" });
      return receipts;
    } catch (e) {
      return fail(reply, e);
    }
  });

  // 0% payment plan from the community fund vault. Donor deposits happen at fund setup: devnet's
  // closed-ended vault rejects VaultDeposit (tecEXPIRED) once loans may originate.
  app.post<IdParams & { Body: { months?: number } }>("/api/cases/:id/loan", async (req, reply) => {
    try {
      const { id } = req.params;
      const months = Number(req.body?.months ?? 12);
      if (!Number.isInteger(months) || months < 1 || months > 60) return reply.code(400).send({ error: "months must be an integer 1-60" });
      const principal = agreedAmount(id);
      const ids = fundIdsFromEnv();
      const ctx = await defaultCtx();
      const loan = await openZeroInterestLoan(id, principal, months, ctx, ids);
      const receipts = loan.receipts;
      emit(id, { type: "log", message: `0% payment plan: ${principal} USD over ${months} months`, messageZh: `零利息分期：${principal} 美元，分 ${months} 个月` });
      return record(id, receipts);
    } catch (e) {
      return fail(reply, e);
    }
  });
}
