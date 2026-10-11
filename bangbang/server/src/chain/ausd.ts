// AUSD (Agora Dollar) on Base Sepolia: ERC-3009 gasless transfers.
// The PAYER only signs EIP-712 typed data (no gas); the PAYEE submits transferWithAuthorization and pays gas.
// Domain verified on-chain 2026-10-11: DOMAIN_SEPARATOR matches name "Agora Dollar", version "1",
// chainId 84532 — NOT the token symbol "AUSD" (signatures with that name do not recover).
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseSignature,
  parseUnits,
  formatUnits,
  recoverTypedDataAddress,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { randomBytes } from "node:crypto";
import { need, opt } from "../env.js";

export const AUSD_DECIMALS = 6;
export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_SEPOLIA_NETWORK = "eip155:84532" as const; // CAIP-2, as x402 v2 uses
export const AUSD_DOMAIN_NAME = "Agora Dollar";
export const AUSD_DOMAIN_VERSION = "1";

export function ausdAddress(): Address {
  return (opt("AUSD_ADDRESS", "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC") as Address);
}

export function rpcUrl(): string {
  return opt("BASE_SEPOLIA_RPC_URL", "https://sepolia.base.org")!;
}

export const AUSD_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** Same wire shape as @x402/evm ExactEIP3009Payload.authorization (decimal strings). */
export type TransferAuthorization = {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
};

export type DomainOverride = { name?: string; version?: string; chainId?: number; verifyingContract?: Address };

export function ausdDomain(o: DomainOverride = {}) {
  return {
    name: o.name ?? AUSD_DOMAIN_NAME,
    version: o.version ?? AUSD_DOMAIN_VERSION,
    chainId: o.chainId ?? BASE_SEPOLIA_CHAIN_ID,
    verifyingContract: o.verifyingContract ?? ausdAddress(),
  } as const;
}

export const toAtomic = (amount: string | number) => parseUnits(String(amount), AUSD_DECIMALS);
export const fromAtomic = (atomic: bigint | string) => formatUnits(BigInt(atomic), AUSD_DECIMALS);
export const randomNonce = (): Hex => toHex(randomBytes(32));

function message(a: TransferAuthorization) {
  return {
    from: a.from,
    to: a.to,
    value: BigInt(a.value),
    validAfter: BigInt(a.validAfter),
    validBefore: BigInt(a.validBefore),
    nonce: a.nonce,
  };
}

/** Payer side: sign an ERC-3009 TransferWithAuthorization. amount is atomic units (6 decimals). */
export async function signTransferAuthorization(
  agentKey: Hex,
  to: Address,
  amount: bigint,
  validBefore: bigint,
  nonce: Hex = randomNonce(),
  opts: { validAfter?: bigint; domain?: DomainOverride } = {},
): Promise<{ authorization: TransferAuthorization; signature: Hex }> {
  const account = privateKeyToAccount(agentKey);
  const authorization: TransferAuthorization = {
    from: account.address,
    to,
    value: amount.toString(),
    validAfter: (opts.validAfter ?? 0n).toString(),
    validBefore: validBefore.toString(),
    nonce,
  };
  const signature = await account.signTypedData({
    domain: ausdDomain(opts.domain),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: message(authorization),
  });
  return { authorization, signature };
}

/** Recover the signer of an authorization under the AUSD domain. */
export async function recoverAuthorizationSigner(
  authorization: TransferAuthorization,
  signature: Hex,
  domain?: DomainOverride,
): Promise<Address> {
  return recoverTypedDataAddress({
    domain: ausdDomain(domain),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: message(authorization),
    signature,
  });
}

/** True iff the signature was produced by authorization.from under the real AUSD domain. */
export async function verifyTransferAuthorization(authorization: TransferAuthorization, signature: Hex): Promise<boolean> {
  try {
    const signer = await recoverAuthorizationSigner(authorization, signature);
    return signer.toLowerCase() === authorization.from.toLowerCase();
  } catch {
    return false;
  }
}

export function publicClient() {
  return createPublicClient({ chain: baseSepolia, transport: http(rpcUrl()) });
}

export function payeeAccount() {
  return privateKeyToAccount(need("PAYEE_EVM_PRIVATE_KEY") as Hex);
}

export function agentAccount() {
  return privateKeyToAccount(need("AGENT_EVM_PRIVATE_KEY") as Hex);
}

/** Payee side: submit transferWithAuthorization on Base Sepolia and wait for the receipt. Returns tx hash. */
export async function settleAuthorization(
  authorization: TransferAuthorization,
  signature: Hex,
  payeeKey: Hex = need("PAYEE_EVM_PRIVATE_KEY") as Hex,
): Promise<Hex> {
  const account = privateKeyToAccount(payeeKey);
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl()) });
  const pub = publicClient();
  const { v, r, s, yParity } = parseSignature(signature);
  const vv = Number(v ?? BigInt(yParity + 27));
  const a = message(authorization);
  const { request } = await pub.simulateContract({
    account,
    address: ausdAddress(),
    abi: AUSD_ABI,
    functionName: "transferWithAuthorization",
    args: [a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, vv, r, s],
  });
  const hash = await wallet.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`AUSD transferWithAuthorization reverted: ${hash}`);
  return hash;
}

export async function balanceOf(address: Address): Promise<bigint> {
  return publicClient().readContract({ address: ausdAddress(), abi: AUSD_ABI, functionName: "balanceOf", args: [address] });
}

export async function authorizationUsed(authorizer: Address, nonce: Hex): Promise<boolean> {
  return publicClient().readContract({
    address: ausdAddress(),
    abi: AUSD_ABI,
    functionName: "authorizationState",
    args: [authorizer, nonce],
  });
}
