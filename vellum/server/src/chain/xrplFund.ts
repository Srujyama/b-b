// Community medical-debt fund on XRPL DEVNET (Ripple lending challenge):
//   fund ──PermissionedDomainSet──▶ domain accepting the fund's "VerifiedDonor" credential (XLS-80 + XLS-70)
//   fund ──CredentialCreate──▶ donor ──CredentialAccept   (only vetted donors: no anonymous money in a charity fund)
//   donors ──VaultDeposit──▶ PRIVATE closed-ended Vault bound to that domain (XLS-65, asset = USD IOU);
//                            anyone without the credential is rejected by the ledger itself (tecNO_AUTH)
//   fund ──LoanBrokerSet──▶ LoanBroker on that vault (XLS-66; no first-loss cover, no mgmt fee)
//   fund + patient ──LoanSet (InterestRate 0, CounterpartySignature)──▶ 0% payment plan
//   patient ──LoanPay──▶ monthly installments
//
// Devnet runs LendingProtocolV1_1, which only allows a NEW LoanBroker on a CLOSED-ended vault
// (VaultKind 1 + SubscriptionDate/RedemptionDate). Loans originate only in the investment phase
// (after SubscriptionDate), and the final payment must land >= 60 s before RedemptionDate.
import {
  convertStringToHex,
  hashes,
  signLoanSetByCounterparty,
  VaultCreateFlags,
  type CredentialAccept,
  type CredentialCreate,
  type LoanBrokerSet,
  type PermissionedDomainSet,
  type LoanPay,
  type LoanSet,
  type VaultCreate,
  type VaultDeposit,
  type Wallet,
} from "xrpl";
import { need } from "../env.js";
import type { Receipt } from "../types.js";
import {
  USD,
  assertSuccess,
  defaultCtx,
  hasHardshipCredential,
  receiptFor,
  rippleTimeIn,
  submitTx,
  usd,
  usdValue,
  type XrplCtx,
} from "./xrpl.js";

export const MONTH_SEC = 30 * 86400;
const VAULT_KIND_CLOSED = 1;
/** Credential the fund issues to vetted donors; the vault's Permissioned Domain accepts only this. */
export const DONOR_CREDENTIAL = "VerifiedDonor";

export type FundIds = { vaultId: string; loanBrokerId: string; domainId?: string };

export function fundIdsFromEnv(): FundIds {
  const get = (k: string) => {
    try {
      return need(k);
    } catch {
      throw new Error(`XRPL community fund is not configured — set ${k} (run: npx tsx scripts/setup-xrpl.ts)`);
    }
  };
  return { vaultId: get("XRPL_VAULT_ID"), loanBrokerId: get("XRPL_LOAN_BROKER_ID") };
}

// ---------------------------------------------------------------- pure builders (unit tested)

/** Domain whose members are holders of the fund owner's VerifiedDonor credential. */
export function buildDonorDomain(owner: string): PermissionedDomainSet {
  return {
    TransactionType: "PermissionedDomainSet",
    Account: owner,
    AcceptedCredentials: [{ Credential: { Issuer: owner, CredentialType: convertStringToHex(DONOR_CREDENTIAL) } }],
  };
}

export function buildDonorCredential(owner: string, donor: string): CredentialCreate {
  return { TransactionType: "CredentialCreate", Account: owner, Subject: donor, CredentialType: convertStringToHex(DONOR_CREDENTIAL) };
}

/** Closed-ended vault; with `domainId` it is PRIVATE and only that domain's members may deposit. */
export function buildVaultCreate(owner: string, issuer: string, subscriptionDate: number, redemptionDate: number, domainId?: string): VaultCreate {
  if (redemptionDate - subscriptionDate < 180) throw new Error("vault investment window must be >= 180 s");
  return {
    TransactionType: "VaultCreate",
    Account: owner,
    Asset: { currency: USD, issuer },
    VaultKind: VAULT_KIND_CLOSED,
    SubscriptionDate: subscriptionDate,
    RedemptionDate: redemptionDate,
    Data: convertStringToHex("Vellum community medical-debt fund"),
    ...(domainId ? { DomainID: domainId, Flags: VaultCreateFlags.tfVaultPrivate } : {}),
  };
}

export function buildLoanBrokerSet(owner: string, vaultId: string): LoanBrokerSet {
  return {
    TransactionType: "LoanBrokerSet",
    Account: owner,
    VaultID: vaultId,
    ManagementFeeRate: 0, // charity: no fee on interest (there is no interest anyway)
    CoverRateMinimum: 0, // no first-loss capital required (both cover rates 0 is valid; one alone is not)
    CoverRateLiquidation: 0,
    Data: convertStringToHex("Vellum 0% medical payment plans"),
  };
}

/** 0% loan of `principal` USD over `months` monthly payments, initiated by the broker owner. */
export function buildZeroInterestLoan(p: {
  brokerOwner: string;
  borrower: string;
  loanBrokerId: string;
  principal: number;
  months: number;
  caseId: string;
  intervalSec?: number;
  graceSec?: number;
}): LoanSet {
  if (!Number.isInteger(p.months) || p.months < 1 || p.months > 60) throw new Error(`months must be an integer 1-60, got ${p.months}`);
  const interval = p.intervalSec ?? MONTH_SEC;
  const grace = Math.min(p.graceSec ?? 7 * 86400, interval);
  if (grace < 60) throw new Error("GracePeriod must be >= 60 s");
  return {
    TransactionType: "LoanSet",
    Account: p.brokerOwner,
    Counterparty: p.borrower,
    LoanBrokerID: p.loanBrokerId,
    PrincipalRequested: usdValue(p.principal),
    InterestRate: 0,
    LateInterestRate: 0,
    PaymentTotal: p.months,
    PaymentInterval: interval,
    GracePeriod: grace,
    Data: convertStringToHex(`vellum:case:${p.caseId}:0pct`),
  };
}

function createdIndex(meta: unknown, entryType: string): string | undefined {
  const nodes = (meta as { AffectedNodes?: any[] })?.AffectedNodes ?? [];
  for (const n of nodes) if (n.CreatedNode?.LedgerEntryType === entryType) return n.CreatedNode.LedgerIndex as string;
  return undefined;
}

// ---------------------------------------------------------------- network ops

/** Vet a donor: the fund issues VerifiedDonor and the donor accepts it, making them a domain member. */
export async function verifyDonor(ctx: XrplCtx, owner: Wallet, donor: Wallet): Promise<Receipt[]> {
  const cc = await submitTx(ctx, buildDonorCredential(owner.address, donor.address), owner);
  const accept: CredentialAccept = { TransactionType: "CredentialAccept", Account: donor.address, Issuer: owner.address, CredentialType: convertStringToHex(DONOR_CREDENTIAL) };
  const ca = await submitTx(ctx, accept, donor);
  return [
    receiptFor(ctx.network, "CredentialCreate", cc.result.hash, { credential: DONOR_CREDENTIAL, subject: donor.address }),
    receiptFor(ctx.network, "CredentialAccept", ca.result.hash, { credential: DONOR_CREDENTIAL, subject: donor.address }),
  ];
}

/** Create the fund: donor-only Permissioned Domain -> private closed-ended vault -> vetted donation -> loan broker.
 *  `investAfterSec`: subscription window (deposits) before loans may originate. `permissioned: false` = open vault. */
export async function createCommunityFund(
  ctx: XrplCtx,
  p: { owner: Wallet; donor: Wallet; donation: number; investAfterSec?: number; termYears?: number; permissioned?: boolean },
): Promise<FundIds & { receipts: Receipt[]; subscriptionDate: number; redemptionDate: number }> {
  const receipts: Receipt[] = [];
  let domainId: string | undefined;
  if (p.permissioned !== false) {
    const dres = await submitTx(ctx, buildDonorDomain(p.owner.address), p.owner);
    domainId = createdIndex(dres.result.meta, "PermissionedDomain");
    if (!domainId) throw new Error("PermissionedDomainSet succeeded but created no PermissionedDomain");
    receipts.push(receiptFor(ctx.network, "PermissionedDomainSet", dres.result.hash, { domainId, accepts: DONOR_CREDENTIAL }));
    if (p.donor.address !== p.owner.address) receipts.push(...(await verifyDonor(ctx, p.owner, p.donor)));
  }
  const subscriptionDate = rippleTimeIn(p.investAfterSec ?? 30);
  const redemptionDate = rippleTimeIn((p.termYears ?? 6) * 365 * 86400);
  const vc = buildVaultCreate(p.owner.address, ctx.actors.issuer.address, subscriptionDate, redemptionDate, domainId);
  const vres = await submitTx(ctx, vc, p.owner);
  const vaultId = createdIndex(vres.result.meta, "Vault") ?? hashes.hashVault(p.owner.address, Number((vres.result.tx_json as any).Sequence));
  receipts.push(receiptFor(ctx.network, "VaultCreate", vres.result.hash, { vaultId, kind: "closed", private: Boolean(domainId), domainId, subscriptionDate, redemptionDate }));

  receipts.push(await donate(ctx, vaultId, p.donor, p.donation));

  const bres = await submitTx(ctx, buildLoanBrokerSet(p.owner.address, vaultId), p.owner);
  const loanBrokerId = createdIndex(bres.result.meta, "LoanBroker") ?? hashes.hashLoanBroker(p.owner.address, Number((bres.result.tx_json as any).Sequence));
  receipts.push(receiptFor(ctx.network, "LoanBrokerSet", bres.result.hash, { loanBrokerId, vaultId, managementFeeRate: 0 }));
  return { vaultId, loanBrokerId, domainId, receipts, subscriptionDate, redemptionDate };
}

export async function donate(ctx: XrplCtx, vaultId: string, donor: Wallet, amount: number): Promise<Receipt> {
  const tx: VaultDeposit = { TransactionType: "VaultDeposit", Account: donor.address, VaultID: vaultId, Amount: usd(ctx.actors.issuer.address, amount) };
  const res = await submitTx(ctx, tx, donor);
  return receiptFor(ctx.network, "VaultDeposit", res.result.hash, { vaultId, amount, donor: donor.address });
}

export async function vaultInfo(ctx: XrplCtx, vaultId: string): Promise<{ assetsAvailable: number; assetsTotal: number; raw: Record<string, any> }> {
  const r = await ctx.client.request({ command: "ledger_entry", index: vaultId, ledger_index: "validated" } as any);
  const node = (r.result as any).node;
  return { assetsAvailable: Number(node.AssetsAvailable ?? 0), assetsTotal: Number(node.AssetsTotal ?? 0), raw: node };
}

/** Open a 0% payment plan for the patient. Requires an accepted FinancialHardship credential on-ledger. */
export async function openZeroInterestLoan(
  caseId: string,
  principal: number,
  months: number,
  ctx?: XrplCtx,
  ids: FundIds = fundIdsFromEnv(),
  opts: { intervalSec?: number; graceSec?: number } = {},
): Promise<{ loanId: string; receipts: Receipt[] }> {
  ctx ??= await defaultCtx();
  const { issuer: owner, patient } = ctx.actors;
  if (!(await hasHardshipCredential(ctx, patient.address))) {
    throw Object.assign(new Error("patient has no accepted FinancialHardship credential on-ledger — POST /credential first"), { statusCode: 409 });
  }
  const vault = await vaultInfo(ctx, ids.vaultId);
  if (vault.assetsAvailable < principal) {
    throw Object.assign(new Error(`community fund vault has ${vault.assetsAvailable} USD available, loan needs ${principal}`), { statusCode: 409 });
  }
  const tx = buildZeroInterestLoan({
    brokerOwner: owner.address,
    borrower: patient.address,
    loanBrokerId: ids.loanBrokerId,
    principal,
    months,
    caseId,
    ...opts,
  });
  const prepared = await ctx.client.autofill(tx);
  const first = owner.sign(prepared);
  const both = signLoanSetByCounterparty(patient, first.tx_blob);
  const res = await ctx.client.submitAndWait(both.tx_blob);
  assertSuccess(res, "LoanSet");
  const loanId = createdIndex(res.result.meta, "Loan");
  if (!loanId) throw new Error(`LoanSet ${res.result.hash} succeeded but created no Loan entry`);
  return {
    loanId,
    receipts: [
      receiptFor(ctx.network, "LoanSet", res.result.hash, {
        loanId,
        loanBrokerId: ids.loanBrokerId,
        principal,
        interestRate: 0,
        payments: months,
        borrower: patient.address,
        hardshipCredential: true,
      }),
    ],
  };
}

export async function loanInfo(ctx: XrplCtx, loanId: string): Promise<Record<string, any>> {
  const r = await ctx.client.request({ command: "ledger_entry", index: loanId, ledger_index: "validated" } as any);
  return (r.result as any).node;
}

/** Patient pays one installment (amount defaults to the loan's PeriodicPayment). */
export async function payInstallment(ctx: XrplCtx, loanId: string, amount?: number): Promise<Receipt> {
  const loan = await loanInfo(ctx, loanId);
  const due = amount ?? Number(loan.PeriodicPayment);
  if (!Number.isFinite(due) || due <= 0) throw new Error(`cannot determine installment for loan ${loanId}`);
  // round UP to cents so a periodic payment with more decimals is still covered
  const pay = Math.ceil(due * 100) / 100;
  const tx: LoanPay = { TransactionType: "LoanPay", Account: ctx.actors.patient.address, LoanID: loanId, Amount: usd(ctx.actors.issuer.address, pay) };
  const res = await submitTx(ctx, tx, ctx.actors.patient);
  return receiptFor(ctx.network, "LoanPay", res.result.hash, { loanId, amount: pay });
}

// ---------------------------------------------------------------- read-only dashboard view (GET /api/fund)
//
// Everything below only READS the ledger (vault_info / ledger_entry / account_objects / account_tx) and
// returns what devnet says right now. Nothing is invented: a field the ledger does not carry is null.
import { convertHexToString } from "xrpl";
import { explorerFor as txExplorerFor } from "./xrpl.js";

/** Ripple epoch (2000-01-01) in Unix seconds. */
export const RIPPLE_EPOCH = 946684800;
const LSF_CREDENTIAL_ACCEPTED = 0x00010000;
const LSF_VAULT_PRIVATE = 0x00010000;
const LSF_LOAN_DEFAULT = 0x00010000;
const LSF_LOAN_IMPAIRED = 0x00020000;
const FUND_TX_TYPES = new Set([
  "PermissionedDomainSet", "CredentialCreate", "CredentialAccept", "CredentialDelete", "VaultCreate", "VaultSet", "VaultDeposit",
  "VaultWithdraw", "VaultClawback", "LoanBrokerSet", "LoanBrokerCoverDeposit", "LoanBrokerCoverWithdraw", "LoanSet", "LoanPay",
  "LoanManage", "LoanDelete",
]);

export const rippleToIso = (t: unknown): string | null =>
  typeof t === "number" && Number.isFinite(t) ? new Date((t + RIPPLE_EPOCH) * 1000).toISOString() : null;

export function accountExplorerFor(network: string, address: string): string {
  return `https://${/devnet/i.test(network) ? "devnet" : "testnet"}.xrpl.org/accounts/${address}`;
}

const num = (v: unknown): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
function hexText(hex: unknown): string | null {
  if (typeof hex !== "string" || !hex || !/^[0-9a-f]+$/i.test(hex)) return null;
  try {
    return convertHexToString(hex);
  } catch {
    return null;
  }
}
/** Case id from a LoanSet Data memo "vellum:case:<id>:0pct" (hex on-ledger). Loans written before the rename
 *  carry the old "bangbang:case:" prefix and stay on the ledger, so both are accepted. */
export function caseIdFromLoanData(data: unknown): string | null {
  const m = /^(?:vellum|bangbang):case:(.+):0pct$/.exec(hexText(data) ?? "");
  return m ? m[1] : null;
}

export type VaultPhase = {
  kind: "closed" | "open";
  phase: "subscription" | "investment" | "redemption" | "open";
  depositsOpen: boolean;
  loansCanOriginate: boolean;
  subscriptionDate: string | null;
  redemptionDate: string | null;
};

/** Where a vault is in its life, judged against the LEDGER's close time (what the ledger itself enforces).
 *  Closed-ended (VaultKind 1): deposits only before SubscriptionDate, loans only between Subscription and Redemption. */
export function vaultPhase(vault: { VaultKind?: number; SubscriptionDate?: number; RedemptionDate?: number }, ledgerTime: number): VaultPhase {
  const subscriptionDate = rippleToIso(vault.SubscriptionDate);
  const redemptionDate = rippleToIso(vault.RedemptionDate);
  const base = { subscriptionDate, redemptionDate };
  if (vault.VaultKind !== 1) return { kind: "open", phase: "open", depositsOpen: true, loansCanOriginate: true, ...base };
  if (ledgerTime < Number(vault.SubscriptionDate)) return { kind: "closed", phase: "subscription", depositsOpen: true, loansCanOriginate: false, ...base };
  if (ledgerTime < Number(vault.RedemptionDate)) return { kind: "closed", phase: "investment", depositsOpen: false, loansCanOriginate: true, ...base };
  return { kind: "closed", phase: "redemption", depositsOpen: false, loansCanOriginate: false, ...base };
}

export type FundTx = { type: string; hash: string; account: string; result: string; at: string | null; amount: number | null; explorerUrl: string };
export type FundLoan = {
  id: string;
  loanSequence: number;
  borrower: string;
  borrowerExplorerUrl: string;
  caseId: string | null; // from the LoanSet Data memo
  status: "active" | "paid" | "impaired" | "defaulted";
  interestRate: number;
  principalRequested: number | null; // from the LoanSet tx (null if not in the borrower's recent history)
  principalOutstanding: number | null;
  totalValueOutstanding: number | null;
  periodicPayment: number | null;
  paymentTotal: number | null; // from the LoanSet tx
  paymentRemaining: number | null;
  paymentsMade: number | null;
  nextPaymentDue: string | null;
  previousPaymentDue: string | null;
  startDate: string | null;
  paymentIntervalSec: number | null;
  gracePeriodSec: number | null;
  origin: FundTx | null;
  payments: FundTx[];
};
export type FundState = {
  network: string;
  ledgerIndex: number | null;
  ledgerTime: string | null;
  vault: {
    id: string;
    account: string;
    accountExplorerUrl: string;
    owner: string;
    asset: { currency: string; issuer?: string };
    assetsTotal: number;
    assetsAvailable: number;
    assetsLent: number;
    lossUnrealized: number;
    assetsMaximum: number | null;
    shares: { mptIssuanceId: string; outstandingRaw: string | null; scale: number | null; outstanding: number | null; assetsPerShare: number | null };
    private: boolean;
    domainId: string | null;
    domainIdEnv: string | null;
    acceptedCredentials: { issuer: string; type: string }[];
    withdrawalPolicy: number | null;
    data: string | null;
  } & VaultPhase;
  broker: {
    id: string;
    account: string;
    accountExplorerUrl: string;
    owner: string;
    ownerExplorerUrl: string;
    loanSequence: number;
    managementFeeRate: number;
    coverAvailable: number;
    debtTotal: number;
    debtMaximum: number | null;
    data: string | null;
  };
  loans: FundLoan[];
  history: FundTx[];
};

const errCode = (e: unknown) => String((e as any)?.data?.error ?? (e as Error)?.message ?? e);
async function rq(ctx: XrplCtx, req: Record<string, unknown>): Promise<any> {
  return (await ctx.client.request(req as any)).result as any;
}
async function entryOrUndefined(ctx: XrplCtx, req: Record<string, unknown>): Promise<Record<string, any> | undefined> {
  try {
    return (await rq(ctx, { command: "ledger_entry", ledger_index: "validated", ...req })).node;
  } catch (e) {
    if (/entryNotFound|objectNotFound|not found/i.test(errCode(e))) return undefined;
    throw e;
  }
}
function notOnLedger(what: string, id: string, env: string) {
  return Object.assign(new Error(`${what} ${id} is not on the ledger (devnet reset?) — re-run: npx tsx scripts/setup-xrpl.ts and update ${env}`), {
    statusCode: 404,
  });
}
async function readVault(ctx: XrplCtx, vaultId: string): Promise<Record<string, any>> {
  let r: any;
  try {
    r = await rq(ctx, { command: "vault_info", vault_id: vaultId, ledger_index: "validated" });
  } catch (e) {
    if (/entryNotFound|objectNotFound|not found/i.test(errCode(e))) throw notOnLedger("Vault", vaultId, "XRPL_VAULT_ID");
    throw e;
  }
  if (!r?.vault) throw notOnLedger("Vault", vaultId, "XRPL_VAULT_ID");
  return r.vault;
}

const txj = (t: any) => t.tx_json ?? t.tx ?? {};
function txView(network: string, t: any): FundTx {
  const j = txj(t);
  const amt = j.Amount;
  const amount = typeof amt === "object" && amt ? num(amt.value) : null; // IOU only; XRP drops are not fund money
  const date = typeof j.date === "number" ? j.date : typeof t.date === "number" ? t.date : undefined;
  const hash = String(t.hash ?? j.hash ?? "");
  return {
    type: String(j.TransactionType),
    hash,
    account: String(j.Account ?? ""),
    result: String(t.meta?.TransactionResult ?? "unknown"),
    at: rippleToIso(date) ?? (typeof t.close_time_iso === "string" ? t.close_time_iso : null),
    amount,
    explorerUrl: txExplorerFor(network, hash),
  };
}
async function accountTx(ctx: XrplCtx, account: string, limit = 200): Promise<any[]> {
  try {
    return (await rq(ctx, { command: "account_tx", account, limit, ledger_index_min: -1, ledger_index_max: -1, forward: false })).transactions ?? [];
  } catch (e) {
    if (/actNotFound/i.test(errCode(e))) return [];
    throw e;
  }
}
const createdIds = (t: any): string[] => (t.meta?.AffectedNodes ?? []).map((n: any) => n.CreatedNode?.LedgerIndex).filter(Boolean);
const createdLoanId = (t: any): string | undefined =>
  (t.meta?.AffectedNodes ?? []).find((n: any) => n.CreatedNode?.LedgerEntryType === "Loan")?.CreatedNode?.LedgerIndex;

/** Read the community fund (vault + broker + every loan + fund activity) from the validated ledger. */
export async function fundState(ctx: XrplCtx, ids: FundIds, opts: { maxLoans?: number } = {}): Promise<FundState> {
  const [v, brokerNode, ledger] = await Promise.all([
    readVault(ctx, ids.vaultId),
    entryOrUndefined(ctx, { index: ids.loanBrokerId }),
    rq(ctx, { command: "ledger", ledger_index: "validated" }),
  ]);
  if (!brokerNode) throw notOnLedger("LoanBroker", ids.loanBrokerId, "XRPL_LOAN_BROKER_ID");
  if (brokerNode.VaultID !== ids.vaultId) {
    throw Object.assign(new Error(`LoanBroker ${ids.loanBrokerId} belongs to vault ${brokerNode.VaultID}, not XRPL_VAULT_ID ${ids.vaultId}`), { statusCode: 409 });
  }
  const ledgerTime = Number(ledger?.ledger?.close_time);
  const shares = v.shares ?? {};
  // A private vault's DomainID lives on its share MPTokenIssuance (vault_info.shares), not on the Vault entry.
  const domainId: string | null = shares.DomainID ?? v.DomainID ?? null;
  const domain = domainId ? await entryOrUndefined(ctx, { index: domainId }) : undefined;
  const acceptedCredentials = ((domain?.AcceptedCredentials ?? []) as any[]).map((c) => ({
    issuer: String(c.Credential?.Issuer),
    type: hexText(c.Credential?.CredentialType) ?? String(c.Credential?.CredentialType),
  }));
  const assetsTotal = num(v.AssetsTotal) ?? 0;
  const assetsAvailable = num(v.AssetsAvailable) ?? 0;
  const scale = num(shares.AssetScale ?? v.Scale);
  const outstandingRaw: string | null = shares.OutstandingAmount ?? null;
  const outstanding = outstandingRaw != null && scale != null ? Number(outstandingRaw) / 10 ** scale : null;

  // Loans: LoanID = hash(LoanBrokerID, LoanSequence) for every sequence the broker has handed out (newest first).
  // A deleted loan (LoanDelete after payoff) is simply gone from the ledger and skipped.
  const nextSeq = Number(brokerNode.LoanSequence ?? 1);
  const count = Math.max(0, Math.min(nextSeq - 1, opts.maxLoans ?? 100));
  const seqs = Array.from({ length: count }, (_, i) => nextSeq - 1 - i);
  const loanNodes = (
    await Promise.all(
      seqs.map(async (seq) => {
        const id = hashes.hashLoan(ids.loanBrokerId, seq);
        return { seq, id, node: await entryOrUndefined(ctx, { index: id }) };
      }),
    )
  ).filter((l): l is { seq: number; id: string; node: Record<string, any> } => Boolean(l.node));

  // Origin LoanSet + LoanPay history: one account_tx per borrower.
  const borrowers = [...new Set(loanNodes.map((l) => String(l.node.Borrower)))];
  const histories = new Map(await Promise.all(borrowers.map(async (b) => [b, await accountTx(ctx, b)] as const)));
  const loans: FundLoan[] = loanNodes.map(({ seq, id, node: n }) => {
    const hist = histories.get(String(n.Borrower)) ?? [];
    const origin = hist.find((t) => txj(t).TransactionType === "LoanSet" && createdLoanId(t) === id);
    const oj = origin ? txj(origin) : {};
    const payments = hist
      .filter((t) => txj(t).TransactionType === "LoanPay" && txj(t).LoanID === id && t.meta?.TransactionResult === "tesSUCCESS")
      .map((t) => txView(ctx.network, t))
      .reverse();
    const paymentTotal = num(oj.PaymentTotal);
    const paymentRemaining = num(n.PaymentRemaining);
    const flags = Number(n.Flags ?? 0);
    const status: FundLoan["status"] =
      flags & LSF_LOAN_DEFAULT ? "defaulted" : flags & LSF_LOAN_IMPAIRED ? "impaired" : paymentRemaining === 0 ? "paid" : "active";
    return {
      id,
      loanSequence: Number(n.LoanSequence ?? seq),
      borrower: String(n.Borrower),
      borrowerExplorerUrl: accountExplorerFor(ctx.network, String(n.Borrower)),
      caseId: caseIdFromLoanData(oj.Data),
      status,
      interestRate: Number(n.InterestRate ?? 0),
      principalRequested: num(oj.PrincipalRequested),
      principalOutstanding: num(n.PrincipalOutstanding ?? 0),
      totalValueOutstanding: num(n.TotalValueOutstanding ?? 0),
      periodicPayment: num(n.PeriodicPayment),
      paymentTotal,
      paymentRemaining,
      paymentsMade: paymentTotal != null && paymentRemaining != null ? paymentTotal - paymentRemaining : null,
      nextPaymentDue: paymentRemaining === 0 ? null : rippleToIso(n.NextPaymentDueDate),
      previousPaymentDue: rippleToIso(n.PreviousPaymentDueDate),
      startDate: rippleToIso(n.StartDate),
      paymentIntervalSec: num(n.PaymentInterval),
      gracePeriodSec: num(n.GracePeriod),
      origin: origin ? txView(ctx.network, origin) : null,
      payments,
    };
  });

  // Fund activity: the owner's and the vault pseudo-account's history, filtered to fund transactions that
  // touch THIS vault / broker / domain / its loans / its accepted credential.
  const [ownerHist, vaultHist] = await Promise.all([accountTx(ctx, String(v.Owner)), accountTx(ctx, String(v.Account))]);
  const loanIds = new Set(loans.map((l) => l.id));
  const relevant = (t: any) => {
    const j = txj(t);
    if (!FUND_TX_TYPES.has(j.TransactionType)) return false;
    if (j.VaultID === ids.vaultId || j.LoanBrokerID === ids.loanBrokerId || (j.LoanID && loanIds.has(j.LoanID))) return true;
    const created = createdIds(t);
    if (created.includes(ids.vaultId) || created.includes(ids.loanBrokerId) || (domainId && created.includes(domainId))) return true;
    if (/^Credential/.test(j.TransactionType)) {
      return acceptedCredentials.some((c) => j.CredentialType === convertStringToHex(c.type) && (j.Account === c.issuer || j.Issuer === c.issuer));
    }
    return false;
  };
  const seen = new Set<string>();
  const history = [...ownerHist, ...vaultHist]
    .filter((t) => {
      const hash = String(t.hash ?? txj(t).hash);
      if (seen.has(hash)) return false;
      seen.add(hash);
      return relevant(t);
    })
    .map((t) => txView(ctx.network, t))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));

  return {
    network: ctx.network,
    ledgerIndex: num(ledger?.ledger_index ?? ledger?.ledger?.ledger_index),
    ledgerTime: rippleToIso(ledgerTime),
    vault: {
      id: ids.vaultId,
      account: String(v.Account),
      accountExplorerUrl: accountExplorerFor(ctx.network, String(v.Account)),
      owner: String(v.Owner),
      asset: { currency: String(v.Asset?.currency ?? "XRP"), issuer: v.Asset?.issuer },
      assetsTotal,
      assetsAvailable,
      assetsLent: Math.round((assetsTotal - assetsAvailable) * 1e6) / 1e6,
      lossUnrealized: num(v.LossUnrealized) ?? 0,
      assetsMaximum: num(v.AssetsMaximum),
      shares: {
        mptIssuanceId: String(v.ShareMPTID),
        outstandingRaw,
        scale,
        outstanding,
        assetsPerShare: outstanding ? assetsTotal / outstanding : null,
      },
      private: Boolean(Number(v.Flags ?? 0) & LSF_VAULT_PRIVATE),
      domainId,
      domainIdEnv: ids.domainId ?? null,
      acceptedCredentials,
      withdrawalPolicy: num(v.WithdrawalPolicy),
      data: hexText(v.Data),
      ...vaultPhase(v as any, ledgerTime),
    },
    broker: {
      id: ids.loanBrokerId,
      account: String(brokerNode.Account),
      accountExplorerUrl: accountExplorerFor(ctx.network, String(brokerNode.Account)),
      owner: String(brokerNode.Owner),
      ownerExplorerUrl: accountExplorerFor(ctx.network, String(brokerNode.Owner)),
      loanSequence: nextSeq,
      managementFeeRate: Number(brokerNode.ManagementFeeRate ?? 0),
      coverAvailable: num(brokerNode.CoverAvailable) ?? 0,
      debtTotal: num(brokerNode.DebtTotal) ?? 0,
      debtMaximum: num(brokerNode.DebtMaximum),
      data: hexText(brokerNode.Data),
    },
    loans,
    history,
  };
}

export type FundDonor = {
  address: string;
  explorerUrl: string;
  credential: { issuer: string; type: string; accepted: boolean; expiration: string | null } | null;
  isVaultOwner: boolean;
  sharesRaw: string;
  shares: number | null;
  claimUsd: number | null; // sharesRaw x AssetsTotal / OutstandingAmount: what those shares are worth now
  deposits: FundTx[]; // VaultDeposit / VaultWithdraw this account signed for this vault
};
export type FundDonors = { network: string; vaultId: string; domainId: string | null; private: boolean; method: string; donors: FundDonor[] };

/** Depositors of the vault. For a PRIVATE vault the set is closed: only members of its Permissioned Domain
 *  (subjects of an accepted credential, read from each credential issuer's owner directory) and the vault
 *  owner can deposit. Each gets their share-token balance and their deposit transactions. */
export async function fundDonors(ctx: XrplCtx, ids: FundIds): Promise<FundDonors> {
  const v = await readVault(ctx, ids.vaultId);
  const shares = v.shares ?? {};
  const domainId: string | null = shares.DomainID ?? v.DomainID ?? null;
  const isPrivate = Boolean(Number(v.Flags ?? 0) & LSF_VAULT_PRIVATE);
  const domain = domainId ? await entryOrUndefined(ctx, { index: domainId }) : undefined;
  const accepted = ((domain?.AcceptedCredentials ?? []) as any[]).map((c) => ({
    issuer: String(c.Credential?.Issuer),
    typeHex: String(c.Credential?.CredentialType),
  }));

  const creds = new Map<string, NonNullable<FundDonor["credential"]>>();
  for (const a of accepted) {
    let marker: unknown;
    let pages = 0;
    do {
      const r = await rq(ctx, {
        command: "account_objects",
        account: a.issuer,
        type: "credential",
        ledger_index: "validated",
        limit: 400,
        ...(marker ? { marker } : {}),
      });
      for (const o of r.account_objects ?? []) {
        if (o.LedgerEntryType !== "Credential" || o.Issuer !== a.issuer || o.CredentialType !== a.typeHex) continue;
        creds.set(String(o.Subject), {
          issuer: a.issuer,
          type: hexText(o.CredentialType) ?? String(o.CredentialType),
          accepted: Boolean(Number(o.Flags ?? 0) & LSF_CREDENTIAL_ACCEPTED),
          expiration: rippleToIso(o.Expiration),
        });
      }
      marker = r.marker;
    } while (marker && ++pages < 20);
  }

  const owner = String(v.Owner);
  const addresses = [...new Set([...creds.keys(), owner])];
  const assetsTotal = num(v.AssetsTotal) ?? 0;
  const outstanding = Number(shares.OutstandingAmount ?? 0);
  const scale = num(shares.AssetScale ?? v.Scale);
  const donors: FundDonor[] = [];
  for (const address of addresses) {
    const [mpt, hist] = await Promise.all([
      entryOrUndefined(ctx, { mptoken: { mpt_issuance_id: v.ShareMPTID, account: address } }),
      accountTx(ctx, address),
    ]);
    const sharesRaw = String(mpt?.MPTAmount ?? "0");
    const deposits = hist
      .filter((t) => ["VaultDeposit", "VaultWithdraw"].includes(txj(t).TransactionType) && txj(t).VaultID === ids.vaultId && txj(t).Account === address)
      .map((t) => txView(ctx.network, t))
      .reverse();
    const isOwner = address === owner;
    if (isOwner && sharesRaw === "0" && !deposits.length && !creds.has(address)) continue; // owner with no stake is not a depositor
    donors.push({
      address,
      explorerUrl: accountExplorerFor(ctx.network, address),
      credential: creds.get(address) ?? null,
      isVaultOwner: isOwner,
      sharesRaw,
      shares: scale != null ? Number(sharesRaw) / 10 ** scale : null,
      claimUsd: outstanding > 0 ? Math.round(((Number(sharesRaw) * assetsTotal) / outstanding) * 100) / 100 : null,
      deposits,
    });
  }
  return {
    network: ctx.network,
    vaultId: ids.vaultId,
    domainId,
    private: isPrivate,
    method: isPrivate
      ? "Private vault: the ledger only accepts deposits from members of its Permissioned Domain (holders of an accepted credential) and from the vault owner. Listed: every subject of an accepted credential in the issuer's owner directory, plus the owner if it holds shares. Shares = each account's MPToken balance of the vault's share token."
      : "Public vault: anyone can deposit and XRPL has no holder index for MPT shares, so only credential holders and the owner are checked here — other depositors may exist.",
    donors,
  };
}

/** Fund ids from env plus the optional XRPL_DONOR_DOMAIN_ID (the ledger's own DomainID wins in the view). */
export function fundIdsWithDomain(): FundIds {
  const ids = fundIdsFromEnv();
  const d = process.env.XRPL_DONOR_DOMAIN_ID;
  return d ? { ...ids, domainId: d } : ids;
}

/**
 * Case id a loan was opened for: the Loan entry's own Data memo if it carries one, otherwise the Data memo of
 * the LoanSet that created it (found in the borrower's account history). null when the loan names no case.
 */
export async function loanCaseId(ctx: XrplCtx, loanId: string, loan: Record<string, any>): Promise<string | null> {
  const own = caseIdFromLoanData(loan.Data);
  if (own) return own;
  const hist = await accountTx(ctx, String(loan.Borrower));
  const origin = hist.find((t) => txj(t).TransactionType === "LoanSet" && createdLoanId(t) === loanId);
  return origin ? caseIdFromLoanData(txj(origin).Data) : null;
}
