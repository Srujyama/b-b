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
    Data: convertStringToHex("BangBang community medical-debt fund"),
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
    Data: convertStringToHex("BangBang 0% medical payment plans"),
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
    Data: convertStringToHex(`bangbang:case:${p.caseId}:0pct`),
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
