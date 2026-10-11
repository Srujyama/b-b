// Community fund dashboard: read helpers + routes against a MOCKED XRPL client (no network, no keys).
// Fixture shapes are copied from real devnet responses (vault_info, ledger_entry, account_tx) for the env fund.
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Wallet, convertStringToHex, hashes } from "xrpl";
import type { XrplCtx } from "../src/chain/xrpl.js";
import { caseIdFromLoanData, fundDonors, fundState, rippleToIso, vaultPhase, RIPPLE_EPOCH } from "../src/chain/xrplFund.js";
import fundRoutes from "../src/routes/fund.js";
import { createCase, getCase } from "../src/store.js";

const NET = "wss://s.devnet.rippletest.net:51233";
const W = { issuer: Wallet.generate(), patient: Wallet.generate(), hospital: Wallet.generate(), clinic: Wallet.generate(), advocate: Wallet.generate() };
const OWNER = W.issuer.address;
const DONOR = Wallet.generate().address;
const STRANGER = Wallet.generate().address;
const VAULT_ACCT = Wallet.generate().address;
const BROKER_ACCT = Wallet.generate().address;
const VAULT_ID = "3C05F9AF9297DCBF8A54F00CC370D1810C36E755F299B16FEE4FDAAE5A09F5A6";
const BROKER_ID = "A3490322505861108D4E51CBA22B559F3627751893C918F88ADCD60B907DB6B7";
const DOMAIN_ID = "4B562D5354A3B834B4F765220F147BFD5B4BF37A8B4DC4B3CD902C2351E606A8";
const SHARE_MPT = "00000001F8FB6E2D8D33F8B486FE64793749C1D53E30BD1E";
const LOAN_ID = hashes.hashLoan(BROKER_ID, 1);
const DELETED_LOAN = hashes.hashLoan(BROKER_ID, 2);
const DONOR_HEX = convertStringToHex("VerifiedDonor");
const SUB = 845066555; // 2026-10-11T20:42:35Z
const RED = 1034282535;
const NOW = SUB + 600;

const tx = (hash: string, json: Record<string, unknown>, meta: Record<string, unknown> = {}) => ({
  hash,
  tx_json: { date: NOW - 100, ...json },
  meta: { TransactionResult: "tesSUCCESS", AffectedNodes: [], ...meta },
});
const H = (c: string) => c.repeat(64);

function makeClient(over: { vaultMissing?: boolean; borrower?: string } = {}) {
  const borrower = over.borrower ?? W.patient.address;
  const submitted: any[] = [];
  const entries: Record<string, any> = {
    [BROKER_ID]: { LedgerEntryType: "LoanBroker", Account: BROKER_ACCT, Owner: OWNER, VaultID: VAULT_ID, LoanSequence: 3, ManagementFeeRate: 0, DebtTotal: "1100", Data: convertStringToHex("Vellum 0% medical payment plans") },
    [DOMAIN_ID]: { LedgerEntryType: "PermissionedDomain", Owner: OWNER, AcceptedCredentials: [{ Credential: { Issuer: OWNER, CredentialType: DONOR_HEX } }] },
    [LOAN_ID]: {
      LedgerEntryType: "Loan", Borrower: borrower, LoanBrokerID: BROKER_ID, LoanSequence: 1, Flags: 0, InterestRate: 0,
      PrincipalOutstanding: "1100", TotalValueOutstanding: "1100", PeriodicPayment: "100", PaymentRemaining: 11,
      NextPaymentDueDate: NOW + 30 * 86400, PreviousPaymentDueDate: NOW, StartDate: NOW - 60, PaymentInterval: 2592000, GracePeriod: 604800,
    },
  };
  const histories: Record<string, any[]> = {
    [OWNER]: [
      tx(H("B"), { TransactionType: "LoanBrokerSet", Account: OWNER, VaultID: VAULT_ID }, { AffectedNodes: [{ CreatedNode: { LedgerEntryType: "LoanBroker", LedgerIndex: BROKER_ID } }] }),
      tx(H("D"), { TransactionType: "VaultDeposit", Account: DONOR, VaultID: VAULT_ID, Amount: { currency: "USD", issuer: OWNER, value: "50000" } }),
      tx(H("C"), { TransactionType: "VaultCreate", Account: OWNER }, { AffectedNodes: [{ CreatedNode: { LedgerEntryType: "Vault", LedgerIndex: VAULT_ID } }] }),
      tx(H("E"), { TransactionType: "CredentialCreate", Account: OWNER, Subject: DONOR, CredentialType: DONOR_HEX }),
      tx(H("F"), { TransactionType: "PermissionedDomainSet", Account: OWNER }, { AffectedNodes: [{ CreatedNode: { LedgerEntryType: "PermissionedDomain", LedgerIndex: DOMAIN_ID } }] }),
      tx(H("0"), { TransactionType: "Payment", Account: OWNER, Destination: STRANGER, Amount: { currency: "USD", issuer: OWNER, value: "20000" } }), // not a fund tx
      tx(H("1"), { TransactionType: "VaultDeposit", Account: STRANGER, VaultID: H("9") }), // another vault
    ],
    [borrower]: [
      tx(H("4"), { TransactionType: "LoanPay", Account: borrower, LoanID: LOAN_ID, Amount: { currency: "USD", issuer: OWNER, value: "100" } }),
      tx(H("5"), { TransactionType: "LoanPay", Account: borrower, LoanID: LOAN_ID }, { TransactionResult: "tecINSUFFICIENT_FUNDS" }),
      tx(H("3"), { TransactionType: "LoanSet", Account: OWNER, Counterparty: borrower, LoanBrokerID: BROKER_ID, PrincipalRequested: "1200", PaymentTotal: 12, Data: convertStringToHex("vellum:case:c42:0pct") }, { AffectedNodes: [{ CreatedNode: { LedgerEntryType: "Loan", LedgerIndex: LOAN_ID } }] }),
    ],
    [DONOR]: [tx(H("D"), { TransactionType: "VaultDeposit", Account: DONOR, VaultID: VAULT_ID, Amount: { currency: "USD", issuer: OWNER, value: "50000" } })],
  };
  const notFound = () => Object.assign(new Error("entryNotFound"), { data: { error: "entryNotFound" } });
  const client = {
    submitted,
    isConnected: () => true,
    async request(r: any) {
      switch (r.command) {
        case "vault_info":
          if (over.vaultMissing || r.vault_id !== VAULT_ID) throw notFound();
          return {
            result: {
              vault: {
                Account: VAULT_ACCT, Owner: OWNER, Asset: { currency: "USD", issuer: OWNER }, AssetsAvailable: "48900", AssetsTotal: "50000",
                Flags: 65536, VaultKind: 1, SubscriptionDate: SUB, RedemptionDate: RED, ShareMPTID: SHARE_MPT, WithdrawalPolicy: 1, Scale: 6,
                Data: convertStringToHex("Vellum community medical-debt fund"),
                shares: { AssetScale: 6, DomainID: DOMAIN_ID, OutstandingAmount: "50000000000" },
              },
            },
          };
        case "ledger":
          return { result: { ledger_index: 6044710, ledger: { close_time: NOW } } };
        case "ledger_entry": {
          if (r.mptoken) {
            if (r.mptoken.account === DONOR) return { result: { node: { MPTAmount: "50000000000" } } };
            throw notFound();
          }
          const n = entries[r.index];
          if (!n) throw notFound();
          return { result: { node: n } };
        }
        case "account_tx":
          return { result: { transactions: histories[r.account] ?? [] } };
        case "account_objects":
          return {
            result: {
              account_objects:
                r.account === OWNER
                  ? [
                      { LedgerEntryType: "Credential", Issuer: OWNER, Subject: DONOR, CredentialType: DONOR_HEX, Flags: 65536 },
                      { LedgerEntryType: "Credential", Issuer: OWNER, Subject: STRANGER, CredentialType: convertStringToHex("Other"), Flags: 65536 },
                    ]
                  : [],
            },
          };
        default:
          throw new Error(`unexpected command ${r.command}`);
      }
    },
    async autofill(t: any) {
      return { ...t, Fee: "12", Sequence: 7, LastLedgerSequence: 6044800 };
    },
    async submitAndWait(blob: string) {
      submitted.push(blob);
      return { result: { hash: H("A"), meta: { TransactionResult: "tesSUCCESS" } } };
    },
  };
  return client;
}
const ctxOf = (client: any): XrplCtx => ({ client, actors: W, network: NET }) as any;
const IDS = { vaultId: VAULT_ID, loanBrokerId: BROKER_ID, domainId: DOMAIN_ID };

describe("pure helpers", () => {
  it("converts ripple time and decodes the case memo", () => {
    expect(rippleToIso(SUB)).toBe("2026-10-11T20:42:35.000Z");
    expect(rippleToIso(undefined)).toBeNull();
    expect(RIPPLE_EPOCH).toBe(946684800);
    expect(caseIdFromLoanData(convertStringToHex("vellum:case:abc-1:0pct"))).toBe("abc-1");
    // loans written on-ledger before the Vellum rename keep the old prefix
    expect(caseIdFromLoanData(convertStringToHex("bangbang:case:old-2:0pct"))).toBe("old-2");
    expect(caseIdFromLoanData(convertStringToHex("something else"))).toBeNull();
    expect(caseIdFromLoanData(undefined)).toBeNull();
  });
  it("vault phase follows the ledger clock", () => {
    const v = { VaultKind: 1, SubscriptionDate: SUB, RedemptionDate: RED };
    expect(vaultPhase(v, SUB - 1)).toMatchObject({ phase: "subscription", depositsOpen: true, loansCanOriginate: false });
    expect(vaultPhase(v, SUB)).toMatchObject({ phase: "investment", depositsOpen: false, loansCanOriginate: true });
    expect(vaultPhase(v, RED + 1)).toMatchObject({ phase: "redemption", depositsOpen: false, loansCanOriginate: false });
    expect(vaultPhase({}, NOW)).toMatchObject({ kind: "open", phase: "open", depositsOpen: true });
  });
});

describe("fundState / fundDonors (mocked ledger)", () => {
  it("reads vault, broker, loans and only this fund's history", async () => {
    const s = await fundState(ctxOf(makeClient()), IDS);
    expect(s.ledgerIndex).toBe(6044710);
    expect(s.vault).toMatchObject({
      assetsTotal: 50000, assetsAvailable: 48900, assetsLent: 1100, private: true, domainId: DOMAIN_ID, kind: "closed",
      phase: "investment", depositsOpen: false, data: "Vellum community medical-debt fund",
      acceptedCredentials: [{ issuer: OWNER, type: "VerifiedDonor" }],
    });
    expect(s.vault.shares).toMatchObject({ outstanding: 50000, assetsPerShare: 1, scale: 6 });
    expect(s.vault.accountExplorerUrl).toBe(`https://devnet.xrpl.org/accounts/${VAULT_ACCT}`);
    expect(s.broker).toMatchObject({ account: BROKER_ACCT, loanSequence: 3, managementFeeRate: 0, debtTotal: 1100, data: "Vellum 0% medical payment plans" });
    // loan seq 2 is gone from the ledger (deleted) and must simply be skipped
    expect(s.loans).toHaveLength(1);
    expect(s.loans.map((l) => l.id)).not.toContain(DELETED_LOAN);
    const l = s.loans[0];
    expect(l).toMatchObject({
      id: LOAN_ID, borrower: W.patient.address, caseId: "c42", status: "active", principalRequested: 1200, paymentTotal: 12,
      paymentRemaining: 11, paymentsMade: 1, periodicPayment: 100, totalValueOutstanding: 1100,
    });
    expect(l.nextPaymentDue).toBe(rippleToIso(NOW + 30 * 86400));
    expect(l.origin?.hash).toBe(H("3"));
    expect(l.payments.map((p) => p.hash)).toEqual([H("4")]); // failed LoanPay excluded
    const types = s.history.map((h) => h.type);
    expect(types).toEqual(expect.arrayContaining(["PermissionedDomainSet", "CredentialCreate", "VaultCreate", "VaultDeposit", "LoanBrokerSet"]));
    expect(types).not.toContain("Payment");
    expect(s.history.find((h) => h.type === "VaultDeposit")).toMatchObject({ amount: 50000, explorerUrl: `https://devnet.xrpl.org/transactions/${H("D")}` });
    expect(s.history.some((h) => h.hash === H("1"))).toBe(false); // another vault's deposit
  });

  it("vault gone from the ledger -> 404 that says what to re-run", async () => {
    await expect(fundState(ctxOf(makeClient({ vaultMissing: true })), IDS)).rejects.toMatchObject({ statusCode: 404, message: expect.stringMatching(/setup-xrpl/) });
  });

  it("lists credentialed depositors with shares and deposits", async () => {
    const d = await fundDonors(ctxOf(makeClient()), IDS);
    expect(d.private).toBe(true);
    expect(d.donors).toHaveLength(1); // stranger holds a different credential; owner has no stake
    expect(d.donors[0]).toMatchObject({ address: DONOR, shares: 50000, claimUsd: 50000, credential: { type: "VerifiedDonor", accepted: true } });
    expect(d.donors[0].deposits.map((x) => x.amount)).toEqual([50000]);
  });
});

describe("fund routes", () => {
  let app: FastifyInstance;
  let client: ReturnType<typeof makeClient>;
  beforeAll(async () => {
    client = makeClient();
    app = Fastify();
    await app.register(fundRoutes, { ctx: async () => ctxOf(client), ids: () => IDS });
    await app.register(
      async (a) => {
        await fundRoutes(a, {
          ctx: async () => ctxOf(client),
          ids: () => {
            throw new Error("XRPL community fund is not configured — set XRPL_VAULT_ID (run: npx tsx scripts/setup-xrpl.ts)");
          },
        });
      },
      { prefix: "/unconfigured" },
    );
  });
  afterAll(() => app.close());

  it("GET /api/fund returns the ledger view plus the server's signer", async () => {
    const res = await app.inject({ method: "GET", url: "/api/fund" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.vault.assetsTotal).toBe(50000);
    expect(body.loans).toHaveLength(1);
    expect(body.signer).toEqual({ patient: W.patient.address });
  });

  it("GET /api/fund/donors", async () => {
    const res = await app.inject({ method: "GET", url: "/api/fund/donors" });
    expect(res.statusCode).toBe(200);
    expect(res.json().donors[0].address).toBe(DONOR);
  });

  it("missing config -> 503 naming the variable", async () => {
    const res = await app.inject({ method: "GET", url: "/unconfigured/api/fund" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/XRPL_VAULT_ID/);
  });

  it("pay: rejects a malformed or unknown loan id", async () => {
    const c = createCase({ mode: "patient" });
    expect((await app.inject({ method: "POST", url: "/api/fund/loans/xyz/pay", payload: { caseId: c.id } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/fund/loans/${H("7")}/pay`, payload: { caseId: c.id } })).statusCode).toBe(404);
  });

  it("pay: the case id is the capability (required, must exist, must match the loan's memo)", async () => {
    const url = `/api/fund/loans/${LOAN_ID}/pay`;
    const missing = await app.inject({ method: "POST", url });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toMatch(/caseId is required/);
    expect((await app.inject({ method: "POST", url, payload: { caseId: "no-such-case" } })).statusCode).toBe(404);
    const wrong = createCase({ mode: "patient" }); // exists, but the loan was opened for c42
    const res = await app.inject({ method: "POST", url, payload: { caseId: wrong.id } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/opened for case c42/);
    expect(client.submitted).toHaveLength(0); // nothing signed
  });

  it("pay: submits LoanPay for one PeriodicPayment and records it on the case", async () => {
    const c = getCase("c42") ?? createCase({ mode: "patient", id: "c42" });
    const res = await app.inject({ method: "POST", url: `/api/fund/loans/${LOAN_ID}/pay`, payload: { caseId: c.id } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ chain: "xrpl", kind: "LoanPay", txHash: H("A"), detail: { loanId: LOAN_ID, amount: 100 } });
    expect(client.submitted).toHaveLength(1);
    expect(getCase(c.id)!.receipts.map((r) => r.kind)).toContain("LoanPay");
  });

  it("pay: refuses a loan whose borrower this server cannot sign for", async () => {
    const other = Fastify();
    await other.register(fundRoutes, { ctx: async () => ctxOf(makeClient({ borrower: STRANGER })), ids: () => IDS });
    const c = getCase("c42") ?? createCase({ mode: "patient", id: "c42" });
    const res = await other.inject({ method: "POST", url: `/api/fund/loans/${LOAN_ID}/pay`, payload: { caseId: c.id } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/only sign for the patient wallet/);
    await other.close();
  });
});

describe("web: fund page", () => {
  it("serves fund.html/js/css with the role sections and no hard-coded amounts", async () => {
    const { buildApp } = await import("../src/index.js");
    const app = await buildApp();
    try {
      const html = (await app.inject({ method: "GET", url: "/fund.html" })).body;
      for (const id of ["fund-app", "error", "stats", "role-broker", "role-depositor", "role-borrower", "vault-card", "deposit-note", "loans", "history", "refresh-btn"]) {
        expect(html, id).toContain(`id="${id}"`);
      }
      expect(html).toContain('href="/fund.css"');
      expect(html).toContain('src="/fund.js"');
      const js = (await app.inject({ method: "GET", url: "/fund.js" })).body;
      expect(js).toContain('api("/api/fund")');
      expect(js).not.toMatch(/\$\s?\d{1,3},\d{3}/); // no literal dollar figures
      // broker terms and loan rates are read from the ledger, not written into the copy
      expect(js).not.toMatch(/0% interest|0% management|No management fee|不收管理费/);
      expect(js).toMatch(/managementFeeRate/);
      expect(js).toMatch(/interestRate/);
      expect((await app.inject({ method: "GET", url: "/fund.css" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
