// XRPL DEVNET settlement for BangBang (Ripple track).
//
//   clinic social worker ──CredentialCreate("FinancialHardship")──▶ patient ──CredentialAccept
//   patient ──EscrowCreate(USD token, PREIMAGE-SHA-256 Condition, CancelAfter)──▶ hospital
//   hospital confirms $0 balance ──Batch(AllOrNothing)[ EscrowFinish(Fulfillment) by hospital,
//                                                        Payment advocate fee by patient ]
//
// The stable token is an IOU "USD" issued by the community-fund issuer account (devnet has no RLUSD
// issuer). Trust-line tokens in escrow need the issuer's asfAllowTrustLineLocking flag (TokenEscrow
// amendment); the Vault (xrplFund.ts) needs the issuer's DefaultRipple flag. setup-xrpl.ts sets both.
//
// The crypto-condition fulfillment is the release key: it never leaves this process (not in receipts,
// not in events, not in API responses) until the Batch that reveals it on-ledger.
import { createHash, randomBytes } from "node:crypto";
import {
  Client,
  Wallet,
  convertStringToHex,
  hashes,
  isoTimeToRippleTime,
  rippleTimeToISOTime,
  signMultiBatch,
  type AccountSet,
  type Batch,
  type CredentialAccept,
  type CredentialCreate,
  type CredentialDelete,
  type EscrowCreate,
  type EscrowFinish,
  type IssuedCurrencyAmount,
  type Payment,
  type SubmittableTransaction,
  type TrustSet,
  type TxResponse,
} from "xrpl";
import { need, opt } from "../env.js";
import { persistedMap } from "../persist.js";
import { explorer } from "./explorers.js";
import type { Receipt } from "../types.js";

export const DEVNET_URL = "wss://s.devnet.rippletest.net:51233";
export const USD = "USD";
export const HARDSHIP_CREDENTIAL = "FinancialHardship";
const TF_INNER_BATCH_TXN = 0x40000000;
const TF_ALL_OR_NOTHING = 0x00010000;
const ASF_DEFAULT_RIPPLE = 8;
const ASF_ALLOW_TRUSTLINE_LOCKING = 17;
const LSF_ACCEPTED = 0x00010000;

// ---------------------------------------------------------------- config / context

export type XrplActors = {
  issuer: Wallet; // issues USD + runs the community fund vault / loan broker
  patient: Wallet;
  hospital: Wallet;
  clinic: Wallet; // credential issuer (social worker attesting FinancialHardship)
  advocate: Wallet; // BangBang — receives the small advocate fee
};
export type XrplCtx = { client: Client; actors: XrplActors; network: string };

/** Refuse anything that isn't an XRPL test network. */
export function assertTestNetwork(url: string): string {
  if (!/devnet|testnet|altnet|localhost|127\.0\.0\.1/i.test(url)) {
    throw new Error(`XRPL_NETWORK=${url} is not a test network — BangBang only runs on XRPL devnet/testnet`);
  }
  return url;
}

export function networkUrl(): string {
  return assertTestNetwork(opt("XRPL_NETWORK", DEVNET_URL)!);
}

export function explorerFor(network: string, txHash: string): string {
  return /devnet/i.test(network) ? explorer.xrplDevnet(txHash) : explorer.xrplTestnet(txHash);
}

/** Wallets from .env (written by scripts/setup-xrpl.ts). Throws a clear "not configured" error. */
export function actorsFromEnv(): XrplActors {
  const w = (k: string) => {
    try {
      return Wallet.fromSeed(need(k));
    } catch (e) {
      if (/not configured/.test((e as Error).message)) {
        throw new Error(`XRPL is not configured — set ${k} (run: npx tsx scripts/setup-xrpl.ts)`);
      }
      throw new Error(`${k} is not a valid XRPL seed`);
    }
  };
  return {
    issuer: w("XRPL_FUND_ISSUER_SEED"),
    patient: w("XRPL_PATIENT_SEED"),
    hospital: w("XRPL_HOSPITAL_SEED"),
    clinic: w("XRPL_CLINIC_SEED"),
    advocate: w("XRPL_ADVOCATE_SEED"),
  };
}

let shared: XrplCtx | undefined;
/** Connected context for the server (env wallets). Reconnects if the socket dropped. */
export async function defaultCtx(): Promise<XrplCtx> {
  const actors = actorsFromEnv();
  const network = networkUrl();
  if (!shared || shared.network !== network) shared = { client: new Client(network), actors, network };
  shared.actors = actors;
  if (!shared.client.isConnected()) await shared.client.connect();
  return shared;
}

// ---------------------------------------------------------------- pure helpers (unit tested)

/** Format a USD number as an XRPL IOU value string (cents precision, no exponent). */
export function usdValue(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`invalid USD amount ${amount}`);
  return (Math.round(amount * 100) / 100).toFixed(2).replace(/\.?0+$/, "");
}

export function usd(issuer: string, amount: number): IssuedCurrencyAmount {
  return { currency: USD, issuer, value: usdValue(amount) };
}

function derLen(n: number): string {
  if (n < 0x80) return n.toString(16).padStart(2, "0");
  if (n < 0x100) return "81" + n.toString(16).padStart(2, "0");
  return "82" + n.toString(16).padStart(4, "0");
}

/**
 * PREIMAGE-SHA-256 crypto-condition (RFC draft-thomas-crypto-conditions, as used by XRPL escrow).
 *   fulfillment = A0 len { 80 len preimage }
 *   condition   = A0 25 { 80 20 sha256(preimage), 81 01 cost }   (cost = preimage length)
 */
export function preimageCondition(preimage: Buffer = randomBytes(32)): { condition: string; fulfillment: string } {
  if (preimage.length > 255) throw new Error("preimage too long for this encoder");
  const fpInner = "80" + derLen(preimage.length) + preimage.toString("hex");
  const fulfillment = "a0" + derLen(fpInner.length / 2) + fpInner;
  const fingerprint = createHash("sha256").update(preimage).digest("hex");
  const cost = preimage.length.toString(16).padStart(2, "0");
  const cInner = "8020" + fingerprint + "8101" + cost;
  const condition = "a0" + derLen(cInner.length / 2) + cInner;
  return { condition: condition.toUpperCase(), fulfillment: fulfillment.toUpperCase() };
}

/** Advocate fee: XRPL_ADVOCATE_FEE_PCT (default 1%) of the settled amount, min $1. */
export function advocateFee(amount: number, pct = Number(opt("XRPL_ADVOCATE_FEE_PCT", "1"))): number {
  if (!Number.isFinite(pct) || pct < 0 || pct > 10) throw new Error(`XRPL_ADVOCATE_FEE_PCT=${pct} must be 0-10`);
  return Math.max(1, Math.round(amount * pct) / 100);
}

export function rippleTimeIn(seconds: number, now = Date.now()): number {
  return isoTimeToRippleTime(new Date(now + seconds * 1000).toISOString());
}

export function buildCredentialCreate(clinic: string, patient: string, caseId: string, expiresInDays = 365): CredentialCreate {
  return {
    TransactionType: "CredentialCreate",
    Account: clinic,
    Subject: patient,
    CredentialType: convertStringToHex(HARDSHIP_CREDENTIAL),
    Expiration: rippleTimeIn(expiresInDays * 86400),
    // no PII on-ledger: just a pointer to the case
    URI: convertStringToHex(`bangbang:case:${caseId}`),
  };
}

export function buildEscrowCreate(p: {
  patient: string;
  hospital: string;
  issuer: string;
  amount: number;
  condition: string;
  cancelAfter: number;
}): EscrowCreate {
  return {
    TransactionType: "EscrowCreate",
    Account: p.patient,
    Destination: p.hospital,
    Amount: usd(p.issuer, p.amount),
    Condition: p.condition,
    CancelAfter: p.cancelAfter,
  };
}

/** Atomic release: hospital finishes the escrow AND patient pays the advocate fee, or neither happens. */
export function buildReleaseBatch(p: {
  hospital: string;
  patient: string;
  advocate: string;
  issuer: string;
  offerSequence: number;
  condition: string;
  fulfillment: string;
  fee: number;
}): Batch {
  const finish: EscrowFinish = {
    TransactionType: "EscrowFinish",
    Account: p.hospital,
    Owner: p.patient,
    OfferSequence: p.offerSequence,
    Condition: p.condition,
    Fulfillment: p.fulfillment,
    Flags: TF_INNER_BATCH_TXN,
  };
  const pay: Payment = {
    TransactionType: "Payment",
    Account: p.patient,
    Destination: p.advocate,
    Amount: usd(p.issuer, p.fee),
    Flags: TF_INNER_BATCH_TXN,
  };
  return {
    TransactionType: "Batch",
    Account: p.hospital,
    Flags: TF_ALL_OR_NOTHING,
    RawTransactions: [{ RawTransaction: finish }, { RawTransaction: pay }],
  };
}

export function txResult(res: TxResponse): string {
  const meta = res.result.meta;
  return typeof meta === "object" && meta ? (meta as { TransactionResult: string }).TransactionResult : "unknown";
}

export function assertSuccess(res: TxResponse, label: string): void {
  const r = txResult(res);
  if (r !== "tesSUCCESS") throw new Error(`XRPL ${label} failed: ${r} (tx ${res.result.hash})`);
}

export function receiptFor(network: string, kind: string, txHash: string, detail?: Record<string, unknown>): Receipt {
  return { chain: "xrpl", kind, txHash, explorerUrl: explorerFor(network, txHash), detail, at: new Date().toISOString() };
}

// ---------------------------------------------------------------- network helpers

/** autofill + sign + submitAndWait; throws unless tesSUCCESS. */
export async function submitTx(ctx: XrplCtx, tx: SubmittableTransaction, wallet: Wallet): Promise<TxResponse> {
  const prepared = await ctx.client.autofill(tx);
  const signed = wallet.sign(prepared);
  const res = await ctx.client.submitAndWait(signed.tx_blob);
  assertSuccess(res, tx.TransactionType);
  return res;
}

export async function submitReceipt(
  ctx: XrplCtx,
  tx: SubmittableTransaction,
  wallet: Wallet,
  detail?: Record<string, unknown>,
): Promise<{ res: TxResponse; receipt: Receipt }> {
  const res = await submitTx(ctx, tx, wallet);
  return { res, receipt: receiptFor(ctx.network, tx.TransactionType, res.result.hash, detail) };
}

/** USD (IOU from issuer) balance of an account, 0 if no trust line. */
export async function usdBalance(ctx: XrplCtx, account: string): Promise<number> {
  const r = await ctx.client.request({ command: "account_lines", account, peer: ctx.actors.issuer.address, ledger_index: "validated" });
  const line = r.result.lines.find((l) => l.currency === USD);
  return line ? Number(line.balance) : 0;
}

async function ledgerEntry(ctx: XrplCtx, req: Record<string, unknown>): Promise<Record<string, any> | undefined> {
  try {
    const r = await ctx.client.request({ command: "ledger_entry", ledger_index: "validated", ...req } as any);
    return (r.result as any).node;
  } catch (e) {
    if (/entryNotFound|not found/i.test(String((e as any)?.data?.error ?? (e as Error).message))) return undefined;
    throw e;
  }
}

/** One-time token setup: issuer flags (DefaultRipple for the vault, trust-line locking for escrow),
 *  trust lines for every holder, and initial USD mints. Idempotent enough to re-run. */
export async function setupToken(ctx: XrplCtx, mints: { wallet: Wallet; amount: number }[]): Promise<Receipt[]> {
  const { issuer } = ctx.actors;
  const receipts: Receipt[] = [];
  for (const flag of [ASF_DEFAULT_RIPPLE, ASF_ALLOW_TRUSTLINE_LOCKING]) {
    const tx: AccountSet = { TransactionType: "AccountSet", Account: issuer.address, SetFlag: flag };
    receipts.push((await submitReceipt(ctx, tx, issuer, { setFlag: flag })).receipt);
  }
  const holders = [ctx.actors.patient, ctx.actors.hospital, ctx.actors.clinic, ctx.actors.advocate];
  for (const h of holders) {
    const ts: TrustSet = {
      TransactionType: "TrustSet",
      Account: h.address,
      LimitAmount: { currency: USD, issuer: issuer.address, value: "1000000000" },
    };
    receipts.push((await submitReceipt(ctx, ts, h, { holder: h.address })).receipt);
  }
  for (const m of mints) {
    const pay: Payment = { TransactionType: "Payment", Account: issuer.address, Destination: m.wallet.address, Amount: usd(issuer.address, m.amount) };
    receipts.push((await submitReceipt(ctx, pay, issuer, { mint: m.amount, to: m.wallet.address })).receipt);
  }
  return receipts;
}

// ---------------------------------------------------------------- credentials

export async function hasHardshipCredential(ctx: XrplCtx, subject = ctx.actors.patient.address): Promise<boolean> {
  const node = await ledgerEntry(ctx, {
    credential: { subject, issuer: ctx.actors.clinic.address, credential_type: convertStringToHex(HARDSHIP_CREDENTIAL) },
  });
  return Boolean(node && (Number(node.Flags) & LSF_ACCEPTED));
}

/** Clinic's social worker issues FinancialHardship to the patient; the patient accepts it.
 *  If a previous credential exists (re-running the demo) it is deleted first so the issuance is fresh. */
export async function issueHardshipCredential(caseId: string, ctx?: XrplCtx): Promise<Receipt[]> {
  ctx ??= await defaultCtx();
  const { clinic, patient } = ctx.actors;
  const type = convertStringToHex(HARDSHIP_CREDENTIAL);
  const receipts: Receipt[] = [];
  const existing = await ledgerEntry(ctx, { credential: { subject: patient.address, issuer: clinic.address, credential_type: type } });
  if (existing) {
    const del: CredentialDelete = { TransactionType: "CredentialDelete", Account: clinic.address, Subject: patient.address, CredentialType: type };
    receipts.push((await submitReceipt(ctx, del, clinic, { reason: "replace previous demo credential" })).receipt);
  }
  const create = buildCredentialCreate(clinic.address, patient.address, caseId);
  receipts.push(
    (await submitReceipt(ctx, create, clinic, { issuer: clinic.address, subject: patient.address, credentialType: HARDSHIP_CREDENTIAL })).receipt,
  );
  const accept: CredentialAccept = { TransactionType: "CredentialAccept", Account: patient.address, Issuer: clinic.address, CredentialType: type };
  receipts.push((await submitReceipt(ctx, accept, patient, { credentialType: HARDSHIP_CREDENTIAL })).receipt);
  return receipts;
}

// ---------------------------------------------------------------- escrow settlement

type EscrowRecord = {
  owner: string;
  destination: string;
  offerSequence: number;
  condition: string;
  fulfillment: string; // SECRET — never returned
  amount: number;
  cancelAfter: number;
  txHash: string;
};
// Persisted to DATA_DIR/escrows.json (mode 0600, contents never logged) so a restart between
// /settle and /confirm-zero-balance can still release the escrow.
const escrowStore = persistedMap<EscrowRecord>("escrows", { secret: true, strict: true, debounceMs: 0 });
const escrows = escrowStore.map;
/** Test/ops hook: re-read escrow records from DATA_DIR (restart simulation). */
export const _reloadEscrows = () => escrowStore.load();
/** Escrow changes are written synchronously, not debounced: losing a fulfillment strands funds.
 *  Throws if escrows.json could not be written (strict store). */
function writeEscrows() {
  escrowStore.save();
  escrowStore.flush();
}

/** Public view of a case's escrow (no fulfillment). */
export function escrowFor(caseId: string): Omit<EscrowRecord, "fulfillment"> | undefined {
  const e = escrows.get(caseId);
  if (!e) return undefined;
  const { fulfillment: _secret, ...pub } = e;
  return pub;
}

/** Lock the agreed amount (USD token) in a conditional escrow patient -> hospital. */
export async function createSettlementEscrow(
  caseId: string,
  amount: number,
  ctx?: XrplCtx,
  opts: { cancelAfterSec?: number } = {},
): Promise<{ condition: string; offerSequence: number; receipt: Receipt }> {
  ctx ??= await defaultCtx();
  const { patient, hospital, issuer } = ctx.actors;
  const prior = escrows.get(caseId);
  if (prior) throw Object.assign(new Error(`case ${caseId} already has an open escrow (tx ${prior.txHash})`), { statusCode: 409 });
  const bal = await usdBalance(ctx, patient.address);
  if (bal < amount) {
    throw Object.assign(new Error(`patient wallet holds ${bal} USD but the settlement needs ${amount} — fund it (setup-xrpl) or open a 0% loan first`), {
      statusCode: 409,
    });
  }
  // Fail before anything is locked on-chain if the release key could not be saved here
  // (e.g. another server process owns DATA_DIR).
  escrowStore.claim();
  const { condition, fulfillment } = preimageCondition();
  const cancelAfter = rippleTimeIn(opts.cancelAfterSec ?? Number(opt("XRPL_ESCROW_CANCEL_DAYS", "14")) * 86400);
  const tx = buildEscrowCreate({ patient: patient.address, hospital: hospital.address, issuer: issuer.address, amount, condition, cancelAfter });
  const res = await submitTx(ctx, tx, patient);
  const offerSequence = Number((res.result.tx_json as { Sequence?: number }).Sequence);
  escrows.set(caseId, { owner: patient.address, destination: hospital.address, offerSequence, condition, fulfillment, amount, cancelAfter, txHash: res.result.hash });
  const receipt = receiptFor(ctx.network, "EscrowCreate", res.result.hash, {
    amount,
    currency: USD,
    owner: patient.address,
    destination: hospital.address,
    offerSequence,
    condition,
    cancelAfter,
  });
  // The release key must be on disk before we acknowledge the lock. If it is not, say so loudly:
  // the funds ARE locked on-chain, and the key now exists only in this process's memory.
  try {
    writeEscrows();
  } catch (err) {
    const cancelAt = rippleTimeToISOTime(cancelAfter);
    throw Object.assign(
      new Error(
        `${amount} USD IS LOCKED on-chain in XRPL escrow ${res.result.hash} (${receipt.explorerUrl}, offerSequence ${offerSequence}), ` +
          `but its release key could not be saved to ${escrowStore.file()}: ${(err as Error).message}. ` +
          `The key is held in memory only — fix DATA_DIR and release with POST /confirm-zero-balance before this server restarts; ` +
          `otherwise the escrow can only be cancelled after ${cancelAt}.`,
      ),
      { statusCode: 500 },
    );
  }
  return { condition, offerSequence, receipt };
}

/** Hospital confirms a $0 balance -> one atomic Batch: EscrowFinish (reveals fulfillment) + advocate fee. */
export async function releaseOnZeroBalance(caseId: string, ctx?: XrplCtx): Promise<Receipt[]> {
  ctx ??= await defaultCtx();
  const e = escrows.get(caseId);
  if (!e) throw Object.assign(new Error(`case ${caseId} has no open escrow — POST /settle first`), { statusCode: 409 });
  const { hospital, patient, advocate, issuer } = ctx.actors;
  const fee = advocateFee(e.amount);
  const batch = buildReleaseBatch({
    hospital: hospital.address,
    patient: patient.address,
    advocate: advocate.address,
    issuer: issuer.address,
    offerSequence: e.offerSequence,
    condition: e.condition,
    fulfillment: e.fulfillment,
    fee,
  });
  const prepared = (await ctx.client.autofill(batch, 1)) as Batch; // 1 = one BatchSigner (patient)
  signMultiBatch(patient, prepared);
  const signed = hospital.sign(prepared);
  const res = await ctx.client.submitAndWait(signed.tx_blob);
  assertSuccess(res, "Batch");
  // A Batch can be tesSUCCESS while its inner txs did not apply — prove the escrow actually closed.
  const still = await ledgerEntry(ctx, { escrow: { owner: e.owner, seq: e.offerSequence } });
  if (still) throw new Error(`XRPL Batch ${res.result.hash} validated but the escrow is still open — inner EscrowFinish did not apply`);
  escrows.delete(caseId);
  try {
    writeEscrows();
  } catch (err) {
    // The escrow is already released on-chain; don't hide the receipts. A stale record on disk only
    // means a restarted server will refuse a second /settle for this case (409), never lose funds.
    console.error(`[xrpl] escrow for case ${caseId} released, but escrows.json could not be updated: ${(err as Error).message}`);
  }
  const inner = prepared.RawTransactions.map((r) => hashes.hashSignedTx(r.RawTransaction));
  return [
    receiptFor(ctx.network, "Batch", res.result.hash, { mode: "AllOrNothing", inner, confirmedBy: hospital.address }),
    receiptFor(ctx.network, "EscrowFinish", inner[0], { amount: e.amount, to: hospital.address, inBatch: res.result.hash }),
    receiptFor(ctx.network, "Payment", inner[1], { advocateFee: fee, to: advocate.address, inBatch: res.result.hash }),
  ];
}

/** Test hook: drop in-memory escrow state. */
export function _resetEscrows() {
  escrows.clear();
  writeEscrows();
}

