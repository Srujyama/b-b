import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import type { FetchLike } from "../src/chain/x402.js";

// No network: research + appeal are mocked at the boundary, settlement is injected.
vi.mock("../src/research/fairprice.js", () => ({
  lookupFairPrice: vi.fn(async (code: string, description: string) => ({
    code,
    description,
    medicareRate: 180.12,
    sources: [{ title: "CMS PFS", url: "https://www.cms.gov/", via: "cms" }],
  })),
}));
vi.mock("../src/claims/appeal.js", () => ({
  draftAppeal: vi.fn(async (claim: Record<string, unknown>) => ({ ...claim, appealLetter: "Dear Medical Director, ..." })),
}));

const payeeKey = generatePrivateKey();
const agentKey = generatePrivateKey();
const payee = privateKeyToAccount(payeeKey).address;
const agent = privateKeyToAccount(agentKey).address;

const ausd = await import("../src/chain/ausd.js");
const x402 = await import("../src/chain/x402.js");
const routes = (await import("../src/routes/x402.js")).default;

let app: FastifyInstance;
const settled: { from: string; to: string; value: string }[] = [];

// adapt app.inject to a fetch-like function so the REAL paidFetch client drives the round trip
const injectFetch: FetchLike = async (url, init) => {
  const u = new URL(url, "http://local");
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
  const r = await app.inject({
    method: (init?.method ?? "GET") as "GET",
    url: u.pathname + u.search,
    headers,
    payload: init?.body as string | undefined,
  });
  const h = new Headers();
  for (const [k, v] of Object.entries(r.headers)) if (v !== undefined) h.set(k, String(v));
  return new Response(r.statusCode === 204 ? null : r.body, { status: r.statusCode, headers: h });
};

beforeAll(async () => {
  process.env.PAYEE_EVM_PRIVATE_KEY = payeeKey;
  delete process.env.PAYEE_EVM_ADDRESS;
  app = Fastify();
  await app.register(routes);
  await app.ready();
});
afterAll(async () => {
  x402.setSettler(null);
  await app.close();
});
beforeEach(() => {
  x402.setSettler(async (a) => {
    settled.push({ from: a.from, to: a.to, value: a.value });
    return ("0x" + "ab".repeat(32)) as Hex;
  });
});

describe("AUSD ERC-3009 signing", () => {
  it("uses the on-chain domain (Agora Dollar / 1 / 84532), 6 decimals", () => {
    const d = ausd.ausdDomain();
    expect(d.name).toBe("Agora Dollar");
    expect(d.version).toBe("1");
    expect(d.chainId).toBe(84532);
    expect(d.verifyingContract.toLowerCase()).toBe("0xa9012a055bd4e0edff8ce09f960291c09d5322dc");
    expect(ausd.toAtomic("0.05")).toBe(50_000n);
    expect(ausd.fromAtomic(500_000n)).toBe("0.5");
  });

  it("signs and recovers TransferWithAuthorization with a random key", async () => {
    const vb = BigInt(Math.floor(Date.now() / 1000) + 300);
    const { authorization, signature } = await ausd.signTransferAuthorization(agentKey, payee, 50_000n, vb);
    expect(authorization.from).toBe(agent);
    expect(authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await ausd.recoverAuthorizationSigner(authorization, signature)).toBe(agent);
    expect(await ausd.verifyTransferAuthorization(authorization, signature)).toBe(true);
    // tampering with the amount breaks it
    expect(await ausd.verifyTransferAuthorization({ ...authorization, value: "1" }, signature)).toBe(false);
  });

  it("a signature under the symbol name 'AUSD' does not verify", async () => {
    const vb = BigInt(Math.floor(Date.now() / 1000) + 300);
    const { authorization, signature } = await ausd.signTransferAuthorization(agentKey, payee, 50_000n, vb, undefined, {
      domain: { name: "AUSD" },
    });
    expect(await ausd.verifyTransferAuthorization(authorization, signature)).toBe(false);
  });
});

describe("x402 paywall", () => {
  it("answers 402 with a spec-shaped PAYMENT-REQUIRED header", async () => {
    const r = await app.inject({ method: "GET", url: "/x402/fair-price?code=99285&description=ER%20visit" });
    expect(r.statusCode).toBe(402);
    const pr: PaymentRequired = decodePaymentRequiredHeader(String(r.headers["payment-required"]));
    expect(pr.x402Version).toBe(2);
    expect(pr.resource.url).toContain("/x402/fair-price");
    expect(pr.accepts).toHaveLength(1);
    const a = pr.accepts[0];
    expect(a.scheme).toBe("exact");
    expect(a.network).toBe("eip155:84532");
    expect(a.asset.toLowerCase()).toBe("0xa9012a055bd4e0edff8ce09f960291c09d5322dc");
    expect(a.amount).toBe("50000");
    expect(a.payTo).toBe(payee);
    expect(a.extra).toMatchObject({ name: "Agora Dollar", version: "1" });
    expect(r.json()).toEqual(pr); // body mirrors header
  });

  it("validates input before asking for money", async () => {
    const r = await app.inject({ method: "GET", url: "/x402/fair-price" });
    expect(r.statusCode).toBe(400);
  });

  it("402 -> sign -> retry round trip settles, returns data, records a receipt", async () => {
    const before = settled.length;
    const { response, paid } = await x402.paidFetch(
      "http://local/x402/fair-price?code=99285&description=ER%20visit",
      {},
      { privateKey: agentKey, fetchImpl: injectFetch },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ code: "99285", medicareRate: 180.12 });
    expect(paid).toMatchObject({ success: true, network: "eip155:84532", payer: agent, amount: "50000" });
    expect(settled.length).toBe(before + 1);
    expect(settled.at(-1)).toEqual({ from: agent, to: payee, value: "50000" });

    const list = (await app.inject({ method: "GET", url: "/api/x402/payments" })).json();
    const last = list.at(-1);
    expect(last).toMatchObject({ chain: "base", kind: "x402-payment", txHash: "0x" + "ab".repeat(32) });
    expect(last.explorerUrl).toBe("https://sepolia.basescan.org/tx/0x" + "ab".repeat(32));
    expect(last.detail).toMatchObject({ payer: agent, amountAUSD: "0.05" });
  });

  it("POST /x402/appeal charges 0.50 AUSD and returns the appeal", async () => {
    const claim = {
      payer: "Aetna",
      denialReason: "not medically necessary",
      procedure: { code: "72148", description: "MRI lumbar spine" },
      diagnoses: [{ code: "M54.16", description: "Radiculopathy, lumbar" }],
      clinicalNotes: "6 weeks of failed PT",
    };
    const { response, paid } = await x402.paidFetch(
      "http://local/x402/appeal",
      { method: "POST", body: JSON.stringify({ claim }), headers: { "content-type": "application/json" } },
      { privateKey: agentKey, fetchImpl: injectFetch },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).appealLetter).toContain("Dear");
    expect(paid?.amount).toBe("500000");
  });

  it("rejects a signature made with the wrong EIP-712 domain name and does not settle", async () => {
    const before = settled.length;
    const { response } = await x402.paidFetch(
      "http://local/x402/fair-price?code=99285",
      {},
      { privateKey: agentKey, fetchImpl: injectFetch, domainName: "AUSD" },
    );
    expect(response.status).toBe(402);
    expect((await response.json()).error).toBe("invalid_exact_evm_payload_signature");
    expect(settled.length).toBe(before);
  });

  it("rejects underpayment, wrong recipient and replayed nonces", async () => {
    const first = await app.inject({ method: "GET", url: "/x402/fair-price?code=1" });
    const pr = decodePaymentRequiredHeader(String(first.headers["payment-required"]));
    const req = pr.accepts[0];
    const vb = BigInt(Math.floor(Date.now() / 1000) + 300);
    const send = async (to: `0x${string}`, amount: bigint, nonce?: Hex) => {
      const { authorization, signature } = await ausd.signTransferAuthorization(agentKey, to, amount, vb, nonce);
      const hdr = encodePaymentSignatureHeader({ x402Version: 2, accepted: req, payload: { authorization, signature } });
      return app.inject({ method: "GET", url: "/x402/fair-price?code=1", headers: { "payment-signature": hdr } });
    };
    expect((await send(payee, 1n)).json().error).toBe("invalid_exact_evm_payload_authorization_value");
    expect((await send(agent, 50_000n)).json().error).toBe("invalid_exact_evm_payload_recipient_mismatch");
    const nonce = ausd.randomNonce();
    expect((await send(payee, 50_000n, nonce)).statusCode).toBe(200);
    const replay = await send(payee, 50_000n, nonce);
    expect(replay.statusCode).toBe(402);
    expect(replay.json().error).toBe("nonce_already_used");
  });

  it("does not charge when the paid work fails", async () => {
    const { lookupFairPrice } = await import("../src/research/fairprice.js");
    vi.mocked(lookupFairPrice).mockRejectedValueOnce(new Error("Context.dev down"));
    const before = settled.length;
    const { response } = await x402.paidFetch("http://local/x402/fair-price?code=2", {}, { privateKey: agentKey, fetchImpl: injectFetch });
    expect(response.status).toBe(502);
    expect(settled.length).toBe(before);
  });

  it("client refuses to pay above its cap", async () => {
    const body = JSON.stringify({ payer: "Aetna", procedure: { code: "72148", description: "MRI" } });
    const before = settled.length;
    await expect(
      x402.paidFetch(
        "http://local/x402/appeal",
        { method: "POST", body, headers: { "content-type": "application/json" } },
        { privateKey: agentKey, fetchImpl: injectFetch, maxAmount: "0.10" },
      ),
    ).rejects.toThrow(/above cap/);
    expect(settled.length).toBe(before);
  });

  it("loudly 503s when no payee is configured", async () => {
    const saved = process.env.PAYEE_EVM_PRIVATE_KEY;
    delete process.env.PAYEE_EVM_PRIVATE_KEY;
    try {
      const r = await app.inject({ method: "GET", url: "/x402/fair-price?code=3" });
      expect(r.statusCode).toBe(503);
      expect(r.json().error).toMatch(/PAYEE_EVM_PRIVATE_KEY/);
    } finally {
      process.env.PAYEE_EVM_PRIVATE_KEY = saved;
    }
  });
});
