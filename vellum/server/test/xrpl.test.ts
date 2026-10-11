// Pure-logic tests for the XRPL settlement module. No network, no keys.
import { createHash } from "node:crypto";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Wallet, validate, type TxResponse } from "xrpl";
import {
  advocateFee,
  actorsFromEnv,
  assertSuccess,
  assertTestNetwork,
  buildCredentialCreate,
  buildEscrowCreate,
  buildReleaseBatch,
  explorerFor,
  preimageCondition,
  receiptFor,
  usdValue,
} from "../src/chain/xrpl.js";
import { buildDonorCredential, buildDonorDomain, buildLoanBrokerSet, buildVaultCreate, buildZeroInterestLoan, DONOR_CREDENTIAL, fundIdsFromEnv } from "../src/chain/xrplFund.js";
import { upsertEnv } from "../scripts/setup-xrpl.js";
import xrplRoutes from "../src/routes/xrpl.js";
import { createCase, updateCase } from "../src/store.js";

const W = {
  issuer: Wallet.generate(),
  patient: Wallet.generate(),
  hospital: Wallet.generate(),
  advocate: Wallet.generate(),
};

describe("PREIMAGE-SHA-256 crypto-condition", () => {
  it("matches the RFC/five-bells vector for an empty preimage", () => {
    const { condition, fulfillment } = preimageCondition(Buffer.alloc(0));
    expect(fulfillment).toBe("A0028000");
    expect(condition).toBe("A0258020E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855810100");
  });

  it("encodes a 32-byte preimage the way XRPL expects", () => {
    const pre = Buffer.alloc(32, 7);
    const { condition, fulfillment } = preimageCondition(pre);
    expect(fulfillment).toBe(("A0228020" + pre.toString("hex")).toUpperCase());
    const fp = createHash("sha256").update(pre).digest("hex").toUpperCase();
    expect(condition).toBe(`A0258020${fp}810120`);
  });

  it("is random by default", () => {
    expect(preimageCondition().fulfillment).not.toBe(preimageCondition().fulfillment);
  });
});

describe("amounts and fees", () => {
  it("formats USD values to cents", () => {
    expect(usdValue(2140.5)).toBe("2140.5");
    expect(usdValue(100)).toBe("100");
    expect(usdValue(0.129)).toBe("0.13");
    expect(() => usdValue(0)).toThrow();
    expect(() => usdValue(NaN)).toThrow();
  });
  it("advocate fee defaults to 1% with a $1 floor", () => {
    expect(advocateFee(2140.5, 1)).toBe(21.41);
    expect(advocateFee(50, 1)).toBe(1);
    expect(() => advocateFee(100, 50)).toThrow(/0-10/);
  });
});

describe("network safety + config", () => {
  it("refuses mainnet", () => {
    expect(() => assertTestNetwork("wss://xrplcluster.com")).toThrow(/not a test network/);
    expect(assertTestNetwork("wss://s.devnet.rippletest.net:51233")).toMatch(/devnet/);
  });
  it("devnet explorer links", () => {
    expect(explorerFor("wss://s.devnet.rippletest.net:51233", "AB")).toBe("https://devnet.xrpl.org/transactions/AB");
    expect(explorerFor("wss://s.altnet.rippletest.net:51233", "AB")).toBe("https://testnet.xrpl.org/transactions/AB");
    const r = receiptFor("wss://s.devnet.rippletest.net:51233", "EscrowCreate", "AB", { amount: 1 });
    expect(r).toMatchObject({ chain: "xrpl", kind: "EscrowCreate", txHash: "AB" });
  });
  it("missing seeds / fund ids fail loudly", () => {
    const saved = { ...process.env };
    for (const k of Object.keys(process.env)) if (k.startsWith("XRPL_")) delete process.env[k];
    expect(() => actorsFromEnv()).toThrow(/XRPL is not configured — set XRPL_FUND_ISSUER_SEED/);
    expect(() => fundIdsFromEnv()).toThrow(/not configured — set XRPL_VAULT_ID/);
    process.env = saved;
  });
  it("assertSuccess throws on tec results", () => {
    const res = { result: { hash: "H", meta: { TransactionResult: "tecNO_PERMISSION" } } } as unknown as TxResponse;
    expect(() => assertSuccess(res, "LoanSet")).toThrow(/LoanSet failed: tecNO_PERMISSION/);
    const ok = { result: { hash: "H", meta: { TransactionResult: "tesSUCCESS" } } } as unknown as TxResponse;
    expect(() => assertSuccess(ok, "x")).not.toThrow();
  });
});

describe("transaction builders pass xrpl.js validation", () => {
  it("CredentialCreate carries no PII", () => {
    const tx = buildCredentialCreate(W.issuer.address, W.patient.address, "case-1");
    validate(tx as any);
    expect(Buffer.from(tx.CredentialType, "hex").toString()).toBe("FinancialHardship");
    expect(Buffer.from(tx.URI!, "hex").toString()).toBe("vellum:case:case-1");
  });
  it("EscrowCreate: token amount + condition + cancelAfter", () => {
    const { condition } = preimageCondition();
    const tx = buildEscrowCreate({ patient: W.patient.address, hospital: W.hospital.address, issuer: W.issuer.address, amount: 2140.5, condition, cancelAfter: 900000000 });
    validate(tx as any);
    expect(tx.Amount).toEqual({ currency: "USD", issuer: W.issuer.address, value: "2140.5" });
    expect(tx.Condition).toBe(condition);
  });
  it("release Batch: AllOrNothing, inner flags, two accounts", () => {
    const { condition, fulfillment } = preimageCondition();
    const b = buildReleaseBatch({
      hospital: W.hospital.address,
      patient: W.patient.address,
      advocate: W.advocate.address,
      issuer: W.issuer.address,
      offerSequence: 42,
      condition,
      fulfillment,
      fee: 21.41,
    });
    validate(b as any);
    expect(b.Flags).toBe(0x00010000);
    expect(b.RawTransactions.map((r) => r.RawTransaction.TransactionType)).toEqual(["EscrowFinish", "Payment"]);
    for (const r of b.RawTransactions) expect(r.RawTransaction.Flags).toBe(0x40000000);
    expect(b.RawTransactions[0].RawTransaction.Account).toBe(W.hospital.address);
    expect(b.RawTransactions[1].RawTransaction.Account).toBe(W.patient.address);
  });
  it("donor-only Permissioned Domain + PRIVATE vault bound to it", () => {
    const hex = Buffer.from(DONOR_CREDENTIAL, "utf8").toString("hex").toUpperCase();
    const d = buildDonorDomain(W.issuer.address);
    validate(d as any);
    expect(d.AcceptedCredentials).toEqual([{ Credential: { Issuer: W.issuer.address, CredentialType: hex } }]);
    const cc = buildDonorCredential(W.issuer.address, W.patient.address);
    validate(cc as any);
    expect([cc.Subject, cc.CredentialType]).toEqual([W.patient.address, hex]);
    const domainId = "B".repeat(64);
    const priv = buildVaultCreate(W.issuer.address, W.issuer.address, 800000000, 900000000, domainId);
    validate(priv as any);
    expect(priv.DomainID).toBe(domainId);
    expect(priv.Flags).toBe(0x00010000); // tfVaultPrivate: the ledger rejects non-members (tecNO_AUTH, proven in live-xrpl)
    const open = buildVaultCreate(W.issuer.address, W.issuer.address, 800000000, 900000000);
    expect(open.DomainID).toBeUndefined();
    expect(open.Flags).toBeUndefined();
  });
  it("closed-ended vault, zero-fee broker, 0% loan", () => {
    const v = buildVaultCreate(W.issuer.address, W.issuer.address, 800000000, 900000000);
    validate(v as any);
    expect(v.VaultKind).toBe(1);
    expect(() => buildVaultCreate(W.issuer.address, W.issuer.address, 100, 200)).toThrow(/180/);
    const id = "A".repeat(64);
    const lb = buildLoanBrokerSet(W.issuer.address, id);
    validate(lb as any);
    expect([lb.CoverRateMinimum, lb.CoverRateLiquidation, lb.ManagementFeeRate]).toEqual([0, 0, 0]);
    const loan = buildZeroInterestLoan({ brokerOwner: W.issuer.address, borrower: W.patient.address, loanBrokerId: id, principal: 2140.5, months: 12, caseId: "c" });
    expect(loan).toMatchObject({ InterestRate: 0, PaymentTotal: 12, PaymentInterval: 2592000, PrincipalRequested: "2140.5", Counterparty: W.patient.address });
    expect(() => buildZeroInterestLoan({ brokerOwner: "r", borrower: "r", loanBrokerId: id, principal: 1, months: 0, caseId: "c" })).toThrow(/months/);
  });
});

describe("setup-xrpl .env upsert", () => {
  it("replaces only XRPL lines and appends missing keys", () => {
    const before = "OPENAI_API_KEY=sk-1\nXRPL_PATIENT_SEED=\nBSC_PRIVATE_KEY=0xabc\n";
    const after = upsertEnv(before, { XRPL_PATIENT_SEED: "sEdP", XRPL_VAULT_ID: "V" });
    expect(after).toBe("OPENAI_API_KEY=sk-1\nXRPL_PATIENT_SEED=sEdP\nBSC_PRIVATE_KEY=0xabc\nXRPL_VAULT_ID=V\n");
    expect(upsertEnv("", { A: "1" })).toBe("A=1\n");
  });
});

describe("routes (no keys)", () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
    for (const k of Object.keys(process.env)) if (k.startsWith("XRPL_")) delete process.env[k];
  });
  afterEach(() => {
    process.env = saved;
  });

  async function app() {
    const a = Fastify();
    await a.register(xrplRoutes);
    return a;
  }

  it("credential -> 503 with a clear message when XRPL isn't configured", async () => {
    const a = await app();
    const c = createCase({ mode: "patient" });
    const res = await a.inject({ method: "POST", url: `/api/cases/${c.id}/credential`, payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/XRPL is not configured — set XRPL_/);
    await a.close();
  });

  it("settle without an agreed amount -> 409; unknown case -> 404", async () => {
    const a = await app();
    const c = createCase({ mode: "patient" });
    expect((await a.inject({ method: "POST", url: `/api/cases/${c.id}/settle`, payload: {} })).statusCode).toBe(409);
    expect((await a.inject({ method: "POST", url: `/api/cases/nope/settle`, payload: {} })).statusCode).toBe(404);
    await a.close();
  });

  it("confirm-zero-balance without an escrow -> 409", async () => {
    const a = await app();
    const c = createCase({ mode: "patient" });
    const res = await a.inject({ method: "POST", url: `/api/cases/${c.id}/confirm-zero-balance`, payload: {} });
    expect(res.statusCode).toBe(409);
    await a.close();
  });

  it("loan validates months, then fails loudly without fund config", async () => {
    const a = await app();
    const c = createCase({ mode: "patient" });
    updateCase(c.id, { agreedAmount: 2140.5 });
    expect((await a.inject({ method: "POST", url: `/api/cases/${c.id}/loan`, payload: { months: 0 } })).statusCode).toBe(400);
    const res = await a.inject({ method: "POST", url: `/api/cases/${c.id}/loan`, payload: { months: 12 } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/XRPL_VAULT_ID/);
    await a.close();
  });
});
