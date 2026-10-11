// Community fund dashboard (Ripple lending challenge): broker -> vault -> depositors -> borrowers, read live
// from XRPL devnet. Every number in these responses comes from the validated ledger; nothing is cached or seeded.
//
//   GET  /api/fund                      vault + loan broker + every loan + fund transaction history
//   GET  /api/fund/donors               depositors (credential holders of the private vault's domain) + shares
//   POST /api/fund/loans/:loanId/pay    borrower pays one installment (LoanPay signed by the patient wallet).
//                                       Body { caseId } is required and is the capability, as on the other case
//                                       routes: the case must exist here AND be the case named in the loan's memo.
import type { FastifyInstance, FastifyReply } from "fastify";
import { addReceipt, emit, getCase } from "../store.js";
import { defaultCtx, type XrplCtx } from "../chain/xrpl.js";
import { fundDonors, fundIdsWithDomain, fundState, loanCaseId, loanInfo, payInstallment, type FundIds } from "../chain/xrplFund.js";
import { jsonErrors } from "./errors.js";

export type FundRouteOpts = { ctx?: () => Promise<XrplCtx>; ids?: () => FundIds };

/** Missing config -> 503, explicit statusCode (400/404/409) -> as-is, chain failure -> 502. */
function fail(reply: FastifyReply, err: unknown) {
  const e = err as Error & { statusCode?: number };
  const msg = e?.message ?? String(err);
  const code = /not configured/i.test(msg) ? 503 : e?.statusCode && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 502;
  return reply.code(code).send({ error: msg });
}

export default async function fundRoutes(app: FastifyInstance, opts: FundRouteOpts = {}) {
  jsonErrors(app);
  // ids first: a missing XRPL_VAULT_ID should say so before we try to connect anywhere
  const load = async () => {
    const ids = (opts.ids ?? fundIdsWithDomain)();
    const ctx = await (opts.ctx ?? defaultCtx)();
    return { ids, ctx };
  };

  app.get("/api/fund", async (_req, reply) => {
    try {
      const { ids, ctx } = await load();
      // `signer`: the only borrower this server can sign LoanPay for (the env patient wallet)
      return { ...(await fundState(ctx, ids)), signer: { patient: ctx.actors.patient.address } };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get("/api/fund/donors", async (_req, reply) => {
    try {
      const { ids, ctx } = await load();
      return await fundDonors(ctx, ids);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post<{ Params: { loanId: string }; Body: { caseId?: string } | null }>("/api/fund/loans/:loanId/pay", async (req, reply) => {
    try {
      const { loanId } = req.params;
      if (!/^[0-9A-F]{64}$/i.test(loanId)) return reply.code(400).send({ error: "loanId must be a 64-hex XRPL ledger object id" });
      const caseId = typeof req.body?.caseId === "string" ? req.body.caseId : "";
      if (!caseId) return reply.code(400).send({ error: "caseId is required: only the case a loan was opened for can pay it" });
      if (!getCase(caseId)) return reply.code(404).send({ error: `unknown case ${caseId}` });
      const { ids, ctx } = await load();
      let loan: Record<string, any> | undefined;
      try {
        loan = await loanInfo(ctx, loanId);
      } catch (e) {
        if (/entryNotFound|not found/i.test(String((e as any)?.data?.error ?? (e as Error).message))) loan = undefined;
        else throw e;
      }
      if (!loan) return reply.code(404).send({ error: `loan ${loanId} is not on the ledger` });
      if (loan.LoanBrokerID !== ids.loanBrokerId) return reply.code(409).send({ error: `loan ${loanId} is not from this fund's loan broker` });
      if (loan.Borrower !== ctx.actors.patient.address) {
        return reply.code(409).send({ error: `loan ${loanId} belongs to ${loan.Borrower}; this server can only sign for the patient wallet ${ctx.actors.patient.address}` });
      }
      if (Number(loan.PaymentRemaining) === 0) return reply.code(409).send({ error: `loan ${loanId} is already paid off` });
      const loanCase = await loanCaseId(ctx, loanId, loan);
      if (loanCase !== caseId) {
        return reply
          .code(403)
          .send({ error: loanCase ? `loan ${loanId} was opened for case ${loanCase}, not ${caseId}` : `loan ${loanId} is not linked to any case` });
      }
      const receipt = await payInstallment(ctx, loanId);
      addReceipt(caseId, receipt);
      const amt = Number(receipt.detail?.amount);
      emit(caseId, { type: "log", message: `Paid an installment of ${amt} USD to the community fund`, messageZh: `已向社区基金还了一期分期：${amt} 美元` });
      return receipt;
    } catch (e) {
      return fail(reply, e);
    }
  });
}
