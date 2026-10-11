// Hospital portal API: the billing office's side of the settlement.
//
// The one-button pipeline simulates the hospital's "$0 balance" confirmation by default. With the portal, a real
// person (a teammate on a second laptop playing Stanford billing) sees the agreed amount and the XRPL escrow the
// patient's wallet locked for them, checks the account, and confirms. That confirmation runs the exact same release
// path as POST /api/cases/:id/confirm-zero-balance (invoked in-process), which submits the atomic XRPL Batch
// [EscrowFinish by the hospital + advocate fee by the patient].
//
//   GET  /api/hospital/cases                       cases with an agreed amount (pending first)
//   GET  /api/hospital/cases/:id                   one case: patient, provider, amount, escrow, credential, receipts
//   GET  /api/hospital/cases/:id/ledger            live XRPL check: is the escrow / hardship credential on-ledger?
//   POST /api/hospital/cases/:id/confirm-zero-balance  {attest: true, staffName?} -> release the escrow
//
// The escrow's crypto-condition fulfillment (the release key) is never returned here: escrowFor() strips it, and
// this module only ever copies named public fields.
import type { FastifyInstance, FastifyReply } from "fastify";
import { emit, getCase, listCases, requireCase } from "../store.js";
import type { CasePacket, Receipt } from "../types.js";
import { defaultCtx, escrowFor, explorerFor, hasHardshipCredential, networkUrl } from "../chain/xrpl.js";
import { getRun } from "./pipeline.js";
import { jsonErrors } from "./errors.js";

/** XRPL "ripple epoch" (2000-01-01) offset from the Unix epoch, in seconds. */
const RIPPLE_EPOCH = 946684800;
const RELEASE_KINDS = new Set(["Batch", "EscrowFinish", "Payment"]);
const CREDENTIAL_KINDS = new Set(["CredentialCreate", "CredentialAccept"]);

export type HospitalStage = "awaiting_escrow" | "awaiting_confirmation" | "released";

type EscrowView = {
  state: "open" | "released" | "none";
  amount?: number;
  currency: "USD";
  txHash?: string;
  explorerUrl?: string;
  condition?: string;
  offerSequence?: number;
  owner?: string;
  destination?: string;
  cancelAfter?: string; // ISO
};

const isPreview = (c: CasePacket) =>
  c.facts.some((f) => /^PREVIEW/.test(String(f))) || c.receipts.some((r) => /PREVIEW/.test(String(r.txHash)));

const lastReceipt = (c: CasePacket, kind: string) => [...c.receipts].reverse().find((r) => r.kind === kind && r.chain === "xrpl");

/** A release Batch recorded after the case's latest escrow (so a re-settled case is not shown as released). */
function releaseReceipts(c: CasePacket): Receipt[] {
  const created = c.receipts.map((r) => r.kind).lastIndexOf("EscrowCreate");
  return c.receipts.filter(
    (r, i) => i > created && r.chain === "xrpl" && RELEASE_KINDS.has(r.kind) && (r.kind === "Batch" || r.detail?.inBatch !== undefined),
  );
}

function stageOf(c: CasePacket): HospitalStage {
  if (escrowFor(c.id)) return "awaiting_confirmation";
  if (c.status === "settled" || releaseReceipts(c).some((r) => r.kind === "Batch")) return "released";
  return "awaiting_escrow";
}

/** Escrow as the hospital may see it: public ledger fields only. */
function escrowView(c: CasePacket): EscrowView {
  const open = escrowFor(c.id);
  const created = lastReceipt(c, "EscrowCreate");
  if (open) {
    return {
      state: "open",
      amount: open.amount,
      currency: "USD",
      txHash: open.txHash,
      explorerUrl: created?.txHash === open.txHash ? created.explorerUrl : explorerFor(networkUrl(), open.txHash),
      condition: open.condition,
      offerSequence: open.offerSequence,
      owner: open.owner,
      destination: open.destination,
      cancelAfter: new Date((open.cancelAfter + RIPPLE_EPOCH) * 1000).toISOString(),
    };
  }
  if (created) {
    const d = created.detail ?? {};
    const num = (v: unknown) => (typeof v === "number" ? v : undefined);
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const cancel = num(d.cancelAfter);
    return {
      state: stageOf(c) === "released" ? "released" : "none",
      amount: num(d.amount),
      currency: "USD",
      txHash: created.txHash,
      explorerUrl: created.explorerUrl,
      condition: str(d.condition),
      offerSequence: num(d.offerSequence),
      owner: str(d.owner),
      destination: str(d.destination),
      cancelAfter: cancel != null ? new Date((cancel + RIPPLE_EPOCH) * 1000).toISOString() : undefined,
    };
  }
  return { state: "none", currency: "USD" };
}

const waitingOnPortal = (id: string) => getRun(id)?.status === "running" && getRun(id)?.awaiting === "hospital-portal";

/** Eligible for the portal: a patient bill case with a negotiated amount (or an escrow / settlement). */
const eligible = (c: CasePacket) => c.mode === "patient" && (c.agreedAmount != null || Boolean(escrowFor(c.id)) || c.status === "settled");

export function caseSummary(c: CasePacket) {
  const escrow = escrowFor(c.id);
  return {
    id: c.id,
    patientName: c.patient?.name ?? c.bill?.patientName ?? null,
    provider: c.bill?.provider?.name ?? null,
    accountNumber: c.bill?.accountNumber ?? null,
    serviceDate: c.bill?.serviceDate ?? null,
    billedBalance: c.bill?.patientBalance ?? null,
    agreedAmount: c.agreedAmount ?? null,
    escrowAmount: escrow?.amount ?? null,
    status: c.status,
    stage: stageOf(c),
    waitingOnPortal: waitingOnPortal(c.id),
    preview: isPreview(c),
    createdAt: c.createdAt,
  };
}

export function caseDetail(c: CasePacket) {
  const credentialReceipts = c.receipts.filter((r) => r.chain === "xrpl" && CREDENTIAL_KINDS.has(r.kind));
  const accepted = credentialReceipts.filter((r) => r.kind === "CredentialAccept").at(-1);
  const created = credentialReceipts.filter((r) => r.kind === "CredentialCreate").at(-1);
  const pub = (r?: Receipt) => (r ? { kind: r.kind, txHash: r.txHash, explorerUrl: r.explorerUrl, at: r.at, detail: r.detail ?? {} } : null);
  return {
    ...caseSummary(c),
    escrow: escrowView(c),
    credential: {
      type: "FinancialHardship",
      accepted: Boolean(accepted),
      issuer: (created?.detail?.issuer as string | undefined) ?? null,
      subject: (created?.detail?.subject as string | undefined) ?? null,
      create: pub(created),
      accept: pub(accepted),
    },
    release: releaseReceipts(c).map((r) => pub(r)!),
    run: getRun(c.id) ? { status: getRun(c.id)!.status, awaiting: getRun(c.id)!.awaiting ?? null } : null,
  };
}

/** Live devnet check (separate endpoint so the page never blocks on the ledger). */
export async function ledgerCheck(c: CasePacket) {
  const out: {
    network: string;
    escrow: { onLedger: boolean | null; amount?: string; destination?: string; error?: string };
    credential: { onLedger: boolean | null; error?: string };
    checkedAt: string;
  } = { network: networkUrl(), escrow: { onLedger: null }, credential: { onLedger: null }, checkedAt: new Date().toISOString() };
  const ctx = await defaultCtx(); // throws "XRPL is not configured — set ..." -> 503
  const e = escrowFor(c.id);
  if (e) {
    try {
      const res = (await ctx.client.request({
        command: "ledger_entry",
        escrow: { owner: e.owner, seq: e.offerSequence },
        ledger_index: "validated",
      } as never)) as { result: { node?: { Amount?: { value?: string } | string; Destination?: string } } };
      const node = res.result.node;
      const amt = node?.Amount;
      out.escrow = { onLedger: Boolean(node), amount: typeof amt === "string" ? amt : amt?.value, destination: node?.Destination };
    } catch (err) {
      const msg = (err as { data?: { error?: string } })?.data?.error ?? (err as Error).message;
      out.escrow = msg === "entryNotFound" ? { onLedger: false } : { onLedger: null, error: msg };
    }
  }
  try {
    out.credential = { onLedger: await hasHardshipCredential(ctx) };
  } catch (err) {
    out.credential = { onLedger: null, error: (err as Error).message };
  }
  return out;
}

function fail(reply: FastifyReply, err: unknown) {
  const e = err as Error & { statusCode?: number };
  const msg = e?.message ?? String(err);
  const code = /not configured/i.test(msg) ? 503 : e?.statusCode && e.statusCode < 600 ? e.statusCode : 502;
  return reply.code(code).send({ error: msg });
}

const inFlight = new Set<string>();
/** Test hook. */
export const _resetHospital = () => inFlight.clear();

export default async function hospitalRoutes(app: FastifyInstance) {
  jsonErrors(app);
  app.get("/api/hospital/cases", async () => {
    const order: Record<HospitalStage, number> = { awaiting_confirmation: 0, awaiting_escrow: 1, released: 2 };
    return listCases()
      .filter(eligible)
      .map(caseSummary)
      .sort((a, b) => order[a.stage] - order[b.stage] || b.createdAt.localeCompare(a.createdAt));
  });

  app.get<{ Params: { id: string } }>("/api/hospital/cases/:id", async (req, reply) => {
    const c = getCase(req.params.id);
    if (!c) return reply.code(404).send({ error: "unknown case" });
    if (!eligible(c)) return reply.code(409).send({ error: "this case has no agreed amount yet — the negotiation is not finished" });
    return caseDetail(c);
  });

  app.get<{ Params: { id: string } }>("/api/hospital/cases/:id/ledger", async (req, reply) => {
    try {
      return await ledgerCheck(requireCase(req.params.id));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post<{ Params: { id: string }; Body: { attest?: boolean; staffName?: string } | null }>(
    "/api/hospital/cases/:id/confirm-zero-balance",
    async (req, reply) => {
      const { id } = req.params;
      const c = getCase(id);
      if (!c) return reply.code(404).send({ error: "unknown case" });
      if (req.body?.attest !== true)
        return reply.code(400).send({ error: "attest must be true: billing staff confirm the patient's account balance is $0 before the escrow is released" });
      const staffName = typeof req.body.staffName === "string" ? req.body.staffName.replace(/\s+/g, " ").trim().slice(0, 80) : "";
      if (stageOf(c) === "released") return reply.code(409).send({ error: "this case is already settled — the escrow was released" });
      if (!escrowFor(id)) return reply.code(409).send({ error: "no open escrow for this case yet — the patient's side has not locked the agreed amount (POST /settle)" });
      if (inFlight.has(id)) return reply.code(409).send({ error: "a release for this case is already being submitted" });
      inFlight.add(id);
      try {
        const who = staffName ? ` by ${staffName}` : "";
        emit(id, {
          type: "log",
          message: `Hospital billing confirmed the account is at $0 in the hospital portal${who}; releasing the XRPL escrow`,
          messageZh: "医院工作人员已在医院端确认您的账户余额为零，正在放行托管款",
        });
        // Same code path as the public route (and the pipeline's simulated confirmation).
        const res = await app.inject({ method: "POST", url: `/api/cases/${encodeURIComponent(id)}/confirm-zero-balance`, payload: {} });
        let data: unknown;
        try {
          data = res.json();
        } catch {
          data = { error: res.body };
        }
        if (res.statusCode >= 400) {
          const d = data as { error?: string; message?: string };
          return reply.code(res.statusCode).send({ error: d?.error ?? d?.message ?? `release failed (${res.statusCode})` });
        }
        return { receipts: data as Receipt[], case: caseDetail(requireCase(id)), confirmedBy: staffName || null };
      } finally {
        inFlight.delete(id);
      }
    },
  );
}
