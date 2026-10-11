// x402 v2 ("exact" scheme, EIP-3009) over AUSD on Base Sepolia.
//  - Server: requirePayment() preHandler answers 402 + PAYMENT-REQUIRED, verifies PAYMENT-SIGNATURE;
//    settlePayment() then submits transferWithAuthorization ITSELF (self-facilitator — no third-party
//    facilitator is known to support AUSD) and sets PAYMENT-RESPONSE. The paid work runs BEFORE settlement,
//    so a failing handler never charges the payer (verify -> work -> settle, as the x402 spec orders it).
//  - Client: paidFetch() is how OUR advocate agent pays for its own research/tools.
// Wire format (headers = base64 JSON) comes from @x402/core so we stay spec-compliant.
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { need, opt } from "../env.js";
import { explorer } from "./explorers.js";
import {
  AUSD_DOMAIN_NAME,
  AUSD_DOMAIN_VERSION,
  BASE_SEPOLIA_NETWORK,
  ausdAddress,
  fromAtomic,
  randomNonce,
  recoverAuthorizationSigner,
  settleAuthorization,
  signTransferAuthorization,
  toAtomic,
  type TransferAuthorization,
} from "./ausd.js";
import { addReceipt, getCase } from "../store.js";
import type { Receipt } from "../types.js";

export const X402_VERSION = 2;
export const HDR_REQUIRED = "PAYMENT-REQUIRED";
export const HDR_SIGNATURE = "PAYMENT-SIGNATURE";
export const HDR_RESPONSE = "PAYMENT-RESPONSE";
export const MAX_TIMEOUT_SECONDS = 300;

// ---------- settlement (injectable for tests) ----------
export type Settler = (authorization: TransferAuthorization, signature: Hex) => Promise<Hex>;
let settler: Settler = (a, s) => settleAuthorization(a, s);
export function setSettler(fn: Settler | null) {
  settler = fn ?? ((a, s) => settleAuthorization(a, s));
}

// ---------- receipts ----------
const payments: Receipt[] = [];
export const listPayments = () => [...payments];
const usedNonces = new Set<string>();

export function payeeAddress(): Address {
  const explicit = opt("PAYEE_EVM_ADDRESS");
  if (explicit) return explicit as Address;
  return privateKeyToAccount(need("PAYEE_EVM_PRIVATE_KEY") as Hex).address;
}

export function buildPaymentRequired(price: string, description: string, url: string, error?: string): PaymentRequired {
  const accepts: PaymentRequirements = {
    scheme: "exact",
    network: BASE_SEPOLIA_NETWORK,
    asset: ausdAddress(),
    amount: toAtomic(price).toString(),
    payTo: payeeAddress(),
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { name: AUSD_DOMAIN_NAME, version: AUSD_DOMAIN_VERSION, assetTransferMethod: "eip3009" },
  };
  return {
    x402Version: X402_VERSION,
    ...(error ? { error } : {}),
    resource: { url, description, mimeType: "application/json", serviceName: "BangBang advocate APIs" },
    accepts: [accepts],
  };
}

type Verified = { payload: PaymentPayload; authorization: TransferAuthorization; signature: Hex; requirements: PaymentRequirements };
declare module "fastify" {
  interface FastifyRequest {
    x402?: Verified;
  }
}

/** Pure check of a decoded payment against requirements. Returns an error reason or the authorization. */
export async function verifyPayment(
  payload: PaymentPayload,
  req: PaymentRequirements,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<{ ok: true; authorization: TransferAuthorization; signature: Hex } | { ok: false; reason: string }> {
  if (payload.x402Version !== X402_VERSION) return { ok: false, reason: "invalid_x402_version" };
  const acc = payload.accepted;
  if (!acc || acc.scheme !== "exact") return { ok: false, reason: "unsupported_scheme" };
  if (acc.network !== req.network) return { ok: false, reason: "invalid_network" };
  if (String(acc.asset).toLowerCase() !== req.asset.toLowerCase()) return { ok: false, reason: "invalid_asset" };
  const p = payload.payload as { authorization?: TransferAuthorization; signature?: Hex };
  const a = p?.authorization;
  if (!a || !p.signature) return { ok: false, reason: "invalid_exact_evm_payload" };
  if (a.to.toLowerCase() !== req.payTo.toLowerCase()) return { ok: false, reason: "invalid_exact_evm_payload_recipient_mismatch" };
  if (BigInt(a.value) < BigInt(req.amount)) return { ok: false, reason: "invalid_exact_evm_payload_authorization_value" };
  if (BigInt(a.validBefore) <= BigInt(nowSec + 6)) return { ok: false, reason: "invalid_exact_evm_payload_authorization_valid_before" };
  if (BigInt(a.validAfter) > BigInt(nowSec)) return { ok: false, reason: "invalid_exact_evm_payload_authorization_valid_after" };
  if (usedNonces.has(`${a.from.toLowerCase()}:${a.nonce}`)) return { ok: false, reason: "nonce_already_used" };
  let signer: string;
  try {
    // Always verify under the REAL domain from requirements — a signature made for "AUSD" will not recover.
    signer = await recoverAuthorizationSigner(a, p.signature, {
      name: String(req.extra.name),
      version: String(req.extra.version),
    });
  } catch {
    return { ok: false, reason: "invalid_exact_evm_payload_signature" };
  }
  if (signer.toLowerCase() !== a.from.toLowerCase()) return { ok: false, reason: "invalid_exact_evm_payload_signature" };
  return { ok: true, authorization: a, signature: p.signature };
}

function send402(reply: FastifyReply, pr: PaymentRequired) {
  return reply
    .code(402)
    .header(HDR_REQUIRED, encodePaymentRequiredHeader(pr))
    .header("Cache-Control", "no-store, private")
    .send(pr);
}

/** Fastify preHandler: 402 unless a valid PAYMENT-SIGNATURE for `price` AUSD is attached. */
export function requirePayment(price: string, description: string): preHandlerAsyncHookHandler {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    let pr: PaymentRequired;
    try {
      pr = buildPaymentRequired(price, description, req.url);
    } catch (e) {
      return reply.code(503).send({ error: `x402 payee not configured — set PAYEE_EVM_PRIVATE_KEY (${(e as Error).message})` });
    }
    const header = req.headers[HDR_SIGNATURE.toLowerCase()];
    if (!header || Array.isArray(header)) return send402(reply, pr);
    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(header);
    } catch {
      return send402(reply, { ...pr, error: "invalid_payment_signature_header" });
    }
    const v = await verifyPayment(payload, pr.accepts[0]);
    if (!v.ok) return send402(reply, { ...pr, error: v.reason });
    req.x402 = { payload, authorization: v.authorization, signature: v.signature, requirements: pr.accepts[0] };
  };
}

/**
 * Call AFTER the paid work succeeded: submits the transfer, sets PAYMENT-RESPONSE, records a Receipt
 * (also on the case, if ?case=<id> was passed). Throws (-> 402 with error) if settlement fails.
 */
export async function settlePayment(req: FastifyRequest, reply: FastifyReply, caseId?: string): Promise<Receipt> {
  const v = req.x402;
  if (!v) throw new Error("settlePayment called without a verified payment (missing requirePayment preHandler)");
  const nonceKey = `${v.authorization.from.toLowerCase()}:${v.authorization.nonce}`;
  if (usedNonces.has(nonceKey)) throw Object.assign(new Error("nonce_already_used"), { statusCode: 402 });
  usedNonces.add(nonceKey);
  let tx: Hex;
  try {
    tx = await settler(v.authorization, v.signature);
  } catch (e) {
    usedNonces.delete(nonceKey);
    const sr: SettleResponse = {
      success: false,
      errorReason: "settle_failed",
      errorMessage: (e as Error).message,
      transaction: "",
      network: v.requirements.network,
      payer: v.authorization.from,
    };
    reply.header(HDR_RESPONSE, encodePaymentResponseHeader(sr));
    throw Object.assign(new Error(`x402 settlement failed: ${(e as Error).message}`), { statusCode: 402 });
  }
  const sr: SettleResponse = {
    success: true,
    transaction: tx,
    network: v.requirements.network,
    payer: v.authorization.from,
    amount: v.authorization.value,
  };
  reply.header(HDR_RESPONSE, encodePaymentResponseHeader(sr));
  reply.header("Access-Control-Expose-Headers", HDR_RESPONSE);
  const receipt: Receipt = {
    chain: "base",
    kind: "x402-payment",
    txHash: tx,
    explorerUrl: explorer.baseSepolia(tx),
    detail: {
      resource: req.url,
      payer: v.authorization.from,
      payTo: v.authorization.to,
      amountAUSD: fromAtomic(v.authorization.value),
      asset: v.requirements.asset,
      network: v.requirements.network,
      nonce: v.authorization.nonce,
    },
    at: new Date().toISOString(),
  };
  payments.push(receipt);
  if (caseId && getCase(caseId)) addReceipt(caseId, receipt);
  return receipt;
}

// ---------- client side: our advocate agent pays ----------
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type PaidFetchOptions = {
  privateKey?: Hex; // default AGENT_EVM_PRIVATE_KEY
  maxAmount?: string; // AUSD, refuse to pay more than this per call (default 1.00)
  fetchImpl?: FetchLike;
  domainName?: string; // override ONLY for tests (wrong-domain rejection)
};
export type PaidResponse = { response: Response; paid?: SettleResponse; requirements?: PaymentRequirements };

export async function paidFetch(url: string, init: RequestInit = {}, opts: PaidFetchOptions = {}): Promise<PaidResponse> {
  const f = opts.fetchImpl ?? fetch;
  const first = await f(url, init);
  if (first.status !== 402) return { response: first };

  const hdr = first.headers.get(HDR_REQUIRED);
  const pr: PaymentRequired = hdr ? decodePaymentRequiredHeader(hdr) : ((await first.json()) as PaymentRequired);
  const req = pr.accepts?.find(
    (a) => a.scheme === "exact" && a.network === BASE_SEPOLIA_NETWORK && a.asset.toLowerCase() === ausdAddress().toLowerCase(),
  );
  if (!req) throw new Error(`x402: ${url} accepts no AUSD/exact/${BASE_SEPOLIA_NETWORK} payment option`);
  const max = toAtomic(opts.maxAmount ?? "1.00");
  if (BigInt(req.amount) > max) throw new Error(`x402: ${url} wants ${fromAtomic(req.amount)} AUSD, above cap ${fromAtomic(max)}`);

  const key = opts.privateKey ?? (need("AGENT_EVM_PRIVATE_KEY") as Hex);
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + (req.maxTimeoutSeconds || MAX_TIMEOUT_SECONDS));
  const { authorization, signature } = await signTransferAuthorization(key, req.payTo as Address, BigInt(req.amount), validBefore, randomNonce(), {
    domain: {
      name: opts.domainName ?? String(req.extra?.name ?? AUSD_DOMAIN_NAME),
      version: String(req.extra?.version ?? AUSD_DOMAIN_VERSION),
    },
  });
  const payload: PaymentPayload = {
    x402Version: X402_VERSION,
    resource: pr.resource,
    accepted: req,
    payload: { authorization, signature },
  };
  const headers = new Headers(init.headers);
  headers.set(HDR_SIGNATURE, encodePaymentSignatureHeader(payload));
  const response = await f(url, { ...init, headers });
  const resHdr = response.headers.get(HDR_RESPONSE);
  return { response, paid: resHdr ? decodePaymentResponseHeader(resHdr) : undefined, requirements: req };
}
