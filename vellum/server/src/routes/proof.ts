// GET /api/cases/:id/proof — a self-contained, downloadable proof bundle for the advocate's tamper-evident log
// (YZi Labs "trusted agent infra"). Everything a third party needs to re-check the log without trusting us:
// the off-chain entry bodies, each entry's hash, the claimed chain head, the mandate commitment, the on-chain head
// (when the AdvocateLedger is deployed) and the settlement receipts. web/verify.html recomputes it all in the browser.
import type { FastifyInstance, FastifyReply } from "fastify";
import { createPublicClient, http, isAddress, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { bscTestnet } from "viem/chains";
import {
  BSC_CHAIN_ID,
  DEFAULT_BSC_RPC,
  LEDGER_ABI,
  caseKey,
  consentHash,
  getEntries,
  hashEntry,
  nextHead,
  toCents,
  verifyChain,
  type ChainVerification,
  type LedgerEntry,
  type LedgerEntryBody,
  type LedgerView,
} from "../chain/bnb.js";
import { seedPreview } from "../dev/preview.js";
import { opt } from "../env.js";
import { requireCase } from "../store.js";
import type { CasePacket, Receipt } from "../types.js";

export const PROOF_FORMAT = "vellum-proof/v1";
const PREVIEW = "PREVIEW (dev harness, not live data)";
const NOT_DEPLOYED = "contract not deployed";

export type ProofEntry = { body: LedgerEntryBody; entryHash: Hex; head: Hex; txHash?: Hex };

export type OnChainHead = {
  contract: string;
  chainId: number;
  caseKey: Hex;
  head: Hex;
  count: number;
  contractUrl: string;
  mandate: LedgerView["mandate"];
  deal: LedgerView["deal"];
};

export type ChainRead = { onChain: OnChainHead | null; reason?: string; detail?: string };

export type ProofBundle = {
  format: typeof PROOF_FORMAT;
  generatedAt: string;
  preview: boolean;
  notice?: string;
  case: {
    id: string;
    caseKey: Hex;
    mode: CasePacket["mode"];
    status: CasePacket["status"];
    provider?: string;
    billedBalance?: number;
    agreedAmount?: number;
    createdAt: string;
  };
  algorithm: { canonicalJson: string; entryHash: string; head: string; genesis: Hex; caseKey: string; source: string[] };
  mandate:
    | {
        maxAmountUsd: number;
        maxAmountCents: string;
        consent: boolean;
        consentHash: Hex;
        consentHashOf: string;
        anchored: boolean;
        onChain: LedgerView["mandate"];
        consentHashMatchesOnChain: boolean | null;
      }
    | null;
  mandateReason?: string;
  entriesSource: string;
  entries: ProofEntry[];
  claimedHead: { head: Hex; count: number };
  onChain: OnChainHead | null;
  onChainReason?: string;
  onChainDetail?: string;
  serverCheck: ChainVerification;
  receipts: { xrpl: Receipt[]; bsc: Receipt[]; other: Receipt[] };
};

// ---------------------------------------------------------------- preview log (DEV_PREVIEW=1 only)

// The real log lives in chain/bnb.ts and only grows when an entry is appended on BNB testnet. A preview-seeded case
// has none, so the design harness can attach a PREVIEW-labelled local log here (hashed with the same helpers, never
// sent to any chain) so the verify page has something to recompute. Only the /dev route below writes to it.
const previewLogs = new Map<string, LedgerEntry[]>();

export function buildLocalLog(bodies: Omit<LedgerEntryBody, "seq">[]): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  let head: Hex = zeroHash;
  bodies.forEach((b, seq) => {
    const body: LedgerEntryBody = { seq, kind: b.kind, by: b.by, text: b.text, amount: b.amount, at: b.at };
    const entryHash = hashEntry(body);
    head = nextHead(head, entryHash);
    out.push({ ...body, entryHash, head });
  });
  return out;
}

export function previewLogFor(c: CasePacket): LedgerEntry[] {
  // call lines and offers as separate entries, merged by time (stable: a line comes before an offer made at the same instant)
  const timeline: { at: string; body: Omit<LedgerEntryBody, "seq"> }[] = [
    ...c.transcript.map((l) => ({ at: l.at, body: { kind: "transcript" as const, by: l.role, text: l.text, at: l.at } })),
    ...c.offers.map((o) => ({ at: o.at, body: { kind: "offer" as const, by: o.by, amount: o.amount, at: o.at } })),
  ];
  timeline.sort((a, b) => a.at.localeCompare(b.at));
  const note: Omit<LedgerEntryBody, "seq"> = { kind: "note", by: "system", text: `${PREVIEW}: local log for the verify page; never appended on-chain`, at: c.createdAt };
  return buildLocalLog([note, ...timeline.map((x) => x.body)]);
}

// ---------------------------------------------------------------- bundle

const isPreviewCase = (c: CasePacket) =>
  c.facts.some((f) => /^PREVIEW/.test(f)) || c.receipts.some((r) => /PREVIEW/.test(r.txHash));

/** Read-only view of the AdvocateLedger for one case. Public view calls only: no BSC_PRIVATE_KEY needed (unlike
 *  chain/bnb.ts readLedger, which goes through the signing clients). Same contract, ABI and caseKey as bnb.ts. */
export async function readHeadPublic(caseId: string, address: Address): Promise<OnChainHead> {
  const pub = createPublicClient({ chain: bscTestnet, transport: http(opt("BSC_RPC_URL", DEFAULT_BSC_RPC)) });
  const key = caseKey(caseId);
  const [m, [head, count], d] = await Promise.all([
    pub.readContract({ address, abi: LEDGER_ABI, functionName: "getMandate", args: [key] }),
    pub.readContract({ address, abi: LEDGER_ABI, functionName: "getHead", args: [key] }),
    pub.readContract({ address, abi: LEDGER_ABI, functionName: "getDeal", args: [key] }),
  ]);
  return {
    contract: address,
    chainId: BSC_CHAIN_ID,
    caseKey: key,
    head,
    count: Number(count),
    contractUrl: `https://testnet.bscscan.com/address/${address}`,
    mandate:
      m.patient === zeroAddress
        ? null
        : { patient: m.patient, agent: m.agent, maxAmountCents: m.maxAmountCents.toString(), consentHash: m.consentHash, openedAt: Number(m.openedAt), patientSigned: m.patientSigned, revoked: m.revoked },
    deal:
      d.recordedAt === 0n
        ? null
        : { amountCents: d.amountCents.toString(), transcriptRoot: d.transcriptRoot, logHead: d.logHead, logCount: Number(d.logCount), settlementRef: d.settlementRef, recordedAt: Number(d.recordedAt) },
  };
}

/** Read the AdvocateLedger head for this case, or say exactly why there is none. Never throws. */
export async function readChainHead(caseId: string, read: typeof readHeadPublic = readHeadPublic): Promise<ChainRead> {
  if (!process.env.ADVOCATE_LEDGER_ADDRESS) {
    return {
      onChain: null,
      reason: NOT_DEPLOYED,
      detail: "ADVOCATE_LEDGER_ADDRESS is not set — deploy contracts/AdvocateLedger.sol to BSC testnet (needs tBNB) and set it in bangbang/server/.env",
    };
  }
  const address = process.env.ADVOCATE_LEDGER_ADDRESS;
  if (!isAddress(address)) {
    return { onChain: null, reason: "on-chain read failed", detail: `ADVOCATE_LEDGER_ADDRESS is not a valid address (${address}) — fix it in bangbang/server/.env` };
  }
  try {
    return { onChain: await read(caseId, address) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { onChain: null, reason: "on-chain read failed", detail: msg };
  }
}

export function buildProofBundle(c: CasePacket, entries: LedgerEntry[], chain: ChainRead, opts: { entriesSource?: string; now?: Date } = {}): ProofBundle {
  const preview = isPreviewCase(c);
  const proofEntries: ProofEntry[] = entries.map((e) => {
    const { entryHash, head, txHash, ...body } = e;
    return { body, entryHash, head, ...(txHash ? { txHash } : {}) };
  });
  const last = entries[entries.length - 1];
  const onChain = chain.onChain;

  let mandate: ProofBundle["mandate"] = null;
  let mandateReason: string | undefined;
  const maxUsd = c.patient?.maxPay ?? c.walkaway;
  if (!c.patient) mandateReason = "no patient intake yet — no mandate to show";
  else if (!(typeof maxUsd === "number" && maxUsd > 0)) mandateReason = "patient has not set a maximum payment yet";
  else {
    const cents = toCents(maxUsd);
    const hash = consentHash(c, cents);
    const om = onChain?.mandate ?? null;
    mandate = {
      maxAmountUsd: maxUsd,
      maxAmountCents: cents.toString(),
      consent: c.patient.consent,
      consentHash: hash,
      consentHashOf: "keccak256(utf8(canonicalJson({caseId, patient, language, consent, maxAmountCents, scope:'negotiate-and-settle-medical-bill'}))) — PII stays off-chain",
      anchored: Boolean(om),
      onChain: om,
      consentHashMatchesOnChain: om ? om.consentHash.toLowerCase() === hash.toLowerCase() : null,
    };
  }

  const by = (chainName: Receipt["chain"]) => c.receipts.filter((r) => r.chain === chainName);
  return {
    format: PROOF_FORMAT,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    preview,
    ...(preview ? { notice: `${PREVIEW}: this case was seeded by the design harness. Nothing here is a real patient, call or transaction.` } : {}),
    case: {
      id: c.id,
      caseKey: caseKey(c.id),
      mode: c.mode,
      status: c.status,
      provider: c.bill?.provider?.name ?? c.claim?.payer,
      billedBalance: c.bill?.patientBalance,
      agreedAmount: c.agreedAmount,
      createdAt: c.createdAt,
    },
    algorithm: {
      canonicalJson: "JSON with object keys sorted, undefined fields dropped, arrays in order",
      entryHash: "keccak256(utf8(canonicalJson(body)))",
      head: "head_i = keccak256(abi.encodePacked(head_{i-1}, entryHash_i)) — 64 raw bytes",
      genesis: zeroHash,
      caseKey: "keccak256(utf8(caseId)) — the AdvocateLedger mapping key",
      source: ["bangbang/server/src/chain/bnb.ts (hashEntry, nextHead, verifyChain)", "bangbang/contracts/AdvocateLedger.sol (appendLog)"],
    },
    mandate,
    ...(mandateReason ? { mandateReason } : {}),
    entriesSource: opts.entriesSource ?? "server off-chain log (chain/bnb.ts appendLog: each entry was appended to the AdvocateLedger)",
    entries: proofEntries,
    claimedHead: { head: last ? last.head : zeroHash, count: entries.length },
    onChain,
    ...(onChain ? {} : { onChainReason: chain.reason ?? NOT_DEPLOYED, ...(chain.detail ? { onChainDetail: chain.detail } : {}) }),
    serverCheck: verifyChain(entries, onChain ? { head: onChain.head, count: onChain.count } : undefined),
    receipts: { xrpl: by("xrpl"), bsc: by("bsc"), other: c.receipts.filter((r) => r.chain !== "xrpl" && r.chain !== "bsc") },
  };
}

function fail(reply: FastifyReply, err: unknown) {
  const e = err as Error & { statusCode?: number };
  return reply.code(e.statusCode ?? 500).send({ error: e?.message ?? String(err) });
}

export default async function proofRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { download?: string } }>("/api/cases/:id/proof", async (req, reply) => {
    try {
      const c = requireCase(req.params.id);
      const real = getEntries(c.id);
      const local = previewLogs.get(c.id);
      const usePreview = real.length === 0 && local !== undefined;
      const bundle = buildProofBundle(c, usePreview ? local : real, await readChainHead(c.id), {
        ...(usePreview ? { entriesSource: `${PREVIEW}: local log built from the seeded transcript; never appended on-chain` } : {}),
      });
      if (req.query.download === "1") {
        reply.header("content-disposition", `attachment; filename="vellum-proof-${c.id.slice(0, 8)}.json"`);
        reply.type("application/json; charset=utf-8");
        return JSON.stringify(bundle, null, 2);
      }
      return bundle;
    } catch (err) {
      return fail(reply, err);
    }
  });

  // UI design harness for the verify page: a preview case WITH a (PREVIEW-labelled, local-only) log to recompute.
  if (process.env.DEV_PREVIEW === "1") {
    app.get("/dev/preview/proof", async (_req, reply) => {
      const c = await seedPreview("receipts", 0);
      previewLogs.set(c.id, previewLogFor(c));
      return reply.redirect(`/verify.html#case=${c.id}`);
    });
  }
}
