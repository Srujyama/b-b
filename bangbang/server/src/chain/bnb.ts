// BNB Chain (BSC testnet, chainId 97) — AdvocateLedger: patient mandate, hash-chained negotiation log, deal record.
// YZi Labs track: identity + authorization + tamper-evident audit log for an agent acting with someone's money.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  BaseError,
  ContractFunctionRevertedError,
  concatHex,
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseAbi,
  stringToBytes,
  zeroHash,
  type Abi,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { need, opt } from "../env.js";
import { requireCase, addReceipt, emit } from "../store.js";
import type { CasePacket, Receipt, TranscriptLine } from "../types.js";
import { explorer } from "./explorers.js";

export const BSC_CHAIN_ID = 97;
export const DEFAULT_BSC_RPC = "https://bsc-testnet-dataseed.bnbchain.org";
export const CONTRACT_PATH = new URL("../../../contracts/AdvocateLedger.sol", import.meta.url);

// Hand-written ABI (fast to load, typed). test/bnb.test.ts asserts it matches what solc emits.
export const LEDGER_ABI = parseAbi([
  "struct Mandate { address patient; address agent; uint256 maxAmountCents; bytes32 consentHash; uint64 openedAt; bool patientSigned; bool revoked; }",
  "struct Deal { uint256 amountCents; bytes32 transcriptRoot; bytes32 logHead; uint256 logCount; string settlementRef; uint64 recordedAt; }",
  "function openMandate(bytes32 caseId, address agent, uint256 maxAmountCents, bytes32 consentHash)",
  "function openMandateWithSig(bytes32 caseId, address patient, address agent, uint256 maxAmountCents, bytes32 consentHash, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function revokeMandate(bytes32 caseId)",
  "function appendLog(bytes32 caseId, bytes32 entryHash) returns (bytes32 head)",
  "function recordDeal(bytes32 caseId, uint256 amountCents, bytes32 transcriptRoot, string settlementRef)",
  "function domainSeparator() view returns (bytes32)",
  "function getMandate(bytes32 caseId) view returns (Mandate)",
  "function getDeal(bytes32 caseId) view returns (Deal)",
  "function getHead(bytes32 caseId) view returns (bytes32 head, uint256 count)",
  "function heads(bytes32) view returns (bytes32)",
  "function logCounts(bytes32) view returns (uint256)",
  "function nonces(address) view returns (uint256)",
  "function MANDATE_TYPEHASH() view returns (bytes32)",
  "event MandateOpened(bytes32 indexed caseId, address indexed patient, address indexed agent, uint256 maxAmountCents, bytes32 consentHash, bool patientSigned)",
  "event MandateRevoked(bytes32 indexed caseId)",
  "event LogAppended(bytes32 indexed caseId, uint256 indexed index, bytes32 entryHash, bytes32 head)",
  "event DealRecorded(bytes32 indexed caseId, uint256 amountCents, bytes32 transcriptRoot, bytes32 logHead, string settlementRef)",
  "error MandateExists()",
  "error NoMandate()",
  "error MandateIsRevoked()",
  "error NotAuthorized()",
  "error OverMandate(uint256 amountCents, uint256 maxAmountCents)",
  "error DealExists()",
  "error BadSignature()",
  "error Expired()",
  "error ZeroAgent()",
]);

// ---------------------------------------------------------------- compile (solc npm, at runtime)

export type CompiledLedger = { abi: Abi; bytecode: Hex; deployedBytecode: Hex; solcVersion: string };
let compiled: CompiledLedger | undefined;

/** Compile contracts/AdvocateLedger.sol with the installed solc. evmVersion "paris" (no PUSH0) is safe on any BSC fork. */
export function compileLedger(): CompiledLedger {
  if (compiled) return compiled;
  const solc = createRequire(import.meta.url)("solc") as { compile(input: string): string; version(): string };
  const input = {
    language: "Solidity",
    sources: { "AdvocateLedger.sol": { content: readFileSync(CONTRACT_PATH, "utf8") } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length) throw new Error(`AdvocateLedger.sol failed to compile:\n${errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n")}`);
  const c = out.contracts["AdvocateLedger.sol"].AdvocateLedger;
  compiled = {
    abi: c.abi,
    bytecode: `0x${c.evm.bytecode.object}`,
    deployedBytecode: `0x${c.evm.deployedBytecode.object}`,
    solcVersion: solc.version(),
  };
  return compiled;
}

// ---------------------------------------------------------------- pure helpers (unit-tested, no keys)

/** Case ids are UUID strings; on-chain key = keccak256(utf8(id)). */
export const caseKey = (caseId: string): Hex => keccak256(stringToBytes(caseId));
export const toCents = (usd: number): bigint => {
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`invalid USD amount ${usd}`);
  return BigInt(Math.round(usd * 100));
};

/** JSON with sorted keys and no undefined — the byte string we hash. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export type LedgerEntryBody = {
  seq: number;
  kind: "offer" | "transcript" | "note";
  by: string; // advocate | hospital | insurer | patient | system
  text?: string;
  amount?: number; // USD, for offers
  at: string;
};
export type LedgerEntry = LedgerEntryBody & { entryHash: Hex; head: Hex; txHash?: Hex };

export const hashEntry = (e: LedgerEntryBody): Hex => keccak256(stringToBytes(canonicalJson(e)));
/** Same as Solidity: keccak256(abi.encodePacked(prevHead, entryHash)). */
export const nextHead = (prev: Hex, entryHash: Hex): Hex => keccak256(concatHex([prev, entryHash]));
export const chainHead = (hashes: Hex[]): Hex => hashes.reduce<Hex>((h, e) => nextHead(h, e), zeroHash);

export type ChainVerification = { ok: boolean; head: Hex; count: number; expectedHead?: Hex; expectedCount?: number; firstBadIndex?: number; reason?: string };

/** Recompute the head from off-chain entries; compare to each entry's recorded head and (optionally) the on-chain head. */
export function verifyChain(entries: (LedgerEntryBody & { entryHash?: Hex; head?: Hex })[], onchain?: { head: Hex; count: number }): ChainVerification {
  let head: Hex = zeroHash;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const { entryHash: _h, head: _hd, txHash: _t, ...body } = e as LedgerEntry;
    const h = hashEntry(body);
    if (e.entryHash && e.entryHash !== h) return { ok: false, head, count: i, firstBadIndex: i, reason: `entry ${i} content does not match its recorded hash (edited)` };
    head = nextHead(head, h);
    if (e.head && e.head !== head) return { ok: false, head, count: i + 1, firstBadIndex: i, reason: `head after entry ${i} does not match (dropped/reordered)` };
  }
  const res: ChainVerification = { ok: true, head, count: entries.length };
  if (onchain) {
    res.expectedHead = onchain.head;
    res.expectedCount = onchain.count;
    if (onchain.count !== entries.length || onchain.head !== head) {
      res.ok = false;
      res.reason = `recomputed head ${head} (${entries.length} entries) != on-chain head ${onchain.head} (${onchain.count} entries)`;
    }
  }
  return res;
}

/** Hash of the consent record — PII stays off-chain, only this commitment is published. */
export function consentHash(c: Pick<CasePacket, "id" | "patient">, maxAmountCents: bigint): Hex {
  const p = c.patient;
  return keccak256(
    stringToBytes(
      canonicalJson({ caseId: c.id, patient: p?.name, language: p?.language, consent: p?.consent, maxAmountCents: maxAmountCents.toString(), scope: "negotiate-and-settle-medical-bill" }),
    ),
  );
}

/** Root over the negotiation transcript: same hash chain, one entry per line. */
export const transcriptRoot = (lines: TranscriptLine[]): Hex => chainHead(lines.map((l) => keccak256(stringToBytes(canonicalJson({ role: l.role, text: l.text, at: l.at })))));

export const MANDATE_TYPES = {
  Mandate: [
    { name: "caseId", type: "bytes32" },
    { name: "agent", type: "address" },
    { name: "maxAmountCents", type: "uint256" },
    { name: "consentHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;
export const mandateDomain = (chainId: number, verifyingContract: Address) => ({ name: "AdvocateLedger", version: "1", chainId, verifyingContract }) as const;

export type MandateMessage = { caseId: Hex; agent: Address; maxAmountCents: bigint; consentHash: Hex; nonce: bigint; deadline: bigint };
/** Patient signs the mandate off-chain (EIP-712); the contract verifies it with ecrecover. */
export async function signMandate(patient: PrivateKeyAccount, chainId: number, contract: Address, message: MandateMessage) {
  const sig = await patient.signTypedData({ domain: mandateDomain(chainId, contract), types: MANDATE_TYPES, primaryType: "Mandate", message });
  const r = `0x${sig.slice(2, 66)}` as Hex;
  const s = `0x${sig.slice(66, 130)}` as Hex;
  const v = parseInt(sig.slice(130, 132), 16);
  return { signature: sig, r, s, v: v < 27 ? v + 27 : v };
}

// ---------------------------------------------------------------- chain I/O (needs BSC_PRIVATE_KEY + ADVOCATE_LEDGER_ADDRESS)

export function bscKey(name = "BSC_PRIVATE_KEY"): Hex {
  const k = need(name);
  return (k.startsWith("0x") ? k : `0x${k}`) as Hex;
}

function clients() {
  const address = need("ADVOCATE_LEDGER_ADDRESS") as Address;
  const account = privateKeyToAccount(bscKey());
  const transport = http(opt("BSC_RPC_URL", DEFAULT_BSC_RPC));
  return {
    address,
    account,
    pub: createPublicClient({ chain: bscTestnet, transport }),
    wallet: createWalletClient({ chain: bscTestnet, transport, account }),
  };
}

// one server key => serialize sends so concurrent log appends never race on the nonce
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn, fn);
  queue = p.catch(() => undefined);
  return p;
}

/** Simulate first (decodes custom-error reverts like OverMandate), then send and wait. Not serialized — use send(). */
async function sendNow(functionName: string, args: readonly unknown[]): Promise<Hex> {
  const { address, account, pub, wallet } = clients();
  try {
    const { request } = await pub.simulateContract({ address, abi: LEDGER_ABI, functionName: functionName as never, args: args as never, account });
    const hash = await wallet.writeContract(request as never);
    const rcpt = await pub.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") throw new Error(`reverted in tx ${hash}`);
    return hash;
  } catch (err) {
    throw new Error(`AdvocateLedger.${functionName} failed: ${describeRevert(err)}`);
  }
}
const send = (functionName: string, args: readonly unknown[]) => {
  clients(); // fail fast + loud on missing config, outside the queue
  return serial(() => sendNow(functionName, args));
};

export function describeRevert(err: unknown): string {
  if (err instanceof BaseError) {
    const rev = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (rev instanceof ContractFunctionRevertedError && rev.data) {
      const a = rev.data.args?.map((x) => String(x)).join(", ") ?? "";
      return `${rev.data.errorName}(${a})`;
    }
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

function receipt(kind: string, txHash: Hex, detail: Record<string, unknown>): Receipt {
  return { chain: "bsc", kind, txHash, explorerUrl: explorer.bscTestnet(txHash), detail, at: new Date().toISOString() };
}

const jsonable = (o: Record<string, unknown>) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

/** Open the case's mandate. The cap is the patient's maxPay (walkaway). If PATIENT_EVM_PRIVATE_KEY is set the patient
 *  signs it (EIP-712, verified on-chain) and the server relays; otherwise the server key signs as her guardian. */
export async function openMandate(caseId: string): Promise<Receipt> {
  const c = requireCase(caseId);
  if (!c.patient) throw Object.assign(new Error("case has no patient — cannot open a mandate"), { statusCode: 400 });
  if (!c.patient.consent) throw Object.assign(new Error("patient has not consented — refusing to open a mandate"), { statusCode: 400 });
  const maxUsd = c.patient.maxPay ?? c.walkaway;
  if (!(maxUsd > 0)) throw Object.assign(new Error("patient.maxPay must be > 0"), { statusCode: 400 });
  const { address, account, pub } = clients();
  const key = caseKey(caseId);
  const max = toCents(maxUsd);
  const consent = consentHash(c, max);
  const patientKey = opt("PATIENT_EVM_PRIVATE_KEY");
  let hash: Hex;
  let patientAddr: Address;
  if (patientKey) {
    const patient = privateKeyToAccount((patientKey.startsWith("0x") ? patientKey : `0x${patientKey}`) as Hex);
    patientAddr = patient.address;
    const nonce = (await pub.readContract({ address, abi: LEDGER_ABI, functionName: "nonces", args: [patient.address] })) as bigint;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const sig = await signMandate(patient, BSC_CHAIN_ID, address, { caseId: key, agent: account.address, maxAmountCents: max, consentHash: consent, nonce, deadline });
    hash = await send("openMandateWithSig", [key, patient.address, account.address, max, consent, deadline, sig.v, sig.r, sig.s]);
  } else {
    patientAddr = account.address;
    hash = await send("openMandate", [key, account.address, max, consent]);
  }
  const r = receipt("openMandate", hash, {
    contract: address, caseKey: key, patient: patientAddr, agent: account.address, maxAmountCents: max.toString(), consentHash: consent,
    patientSigned: Boolean(patientKey), signer: patientKey ? "patient (EIP-712)" : "server key as guardian (PATIENT_EVM_PRIVATE_KEY not set)",
  });
  addReceipt(caseId, r);
  logs.set(caseId, logs.get(caseId) ?? []);
  return r;
}

// off-chain entry bodies per case (the chain stores only hashes + head)
const logs = new Map<string, LedgerEntry[]>();
export const getEntries = (caseId: string): LedgerEntry[] => logs.get(caseId) ?? [];

/** Hash one offer/transcript turn and append it to the on-chain chain. */
export async function appendLog(caseId: string, body: Omit<LedgerEntryBody, "seq" | "at"> & { at?: string }): Promise<Receipt> {
  clients(); // loud config error before anything is recorded
  const list = logs.get(caseId) ?? [];
  logs.set(caseId, list);
  const at = body.at ?? new Date().toISOString();
  // compute seq/head inside the send queue so the local chain always mirrors what landed on-chain
  const stored = await serial(async () => {
    const entry: LedgerEntryBody = { seq: list.length, kind: body.kind, by: body.by, text: body.text, amount: body.amount, at };
    const entryHash = hashEntry(entry);
    const head = nextHead(list.length ? list[list.length - 1].head : zeroHash, entryHash);
    const txHash = await sendNow("appendLog", [caseKey(caseId), entryHash]);
    const e: LedgerEntry = { ...entry, entryHash, head, txHash };
    list.push(e);
    return e;
  });
  const entry = stored;
  const entryHash = stored.entryHash;
  const head = stored.head;
  const r = receipt("logEntry", stored.txHash!, { seq: entry.seq, kind: entry.kind, by: entry.by, entryHash, head });
  addReceipt(caseId, r);
  return r;
}

/** Record the agreed deal. The contract reverts with OverMandate if amount > the patient's cap. */
export async function recordDeal(caseId: string, amountUsd: number, settlementRef: string): Promise<Receipt> {
  const c = requireCase(caseId);
  const cents = toCents(amountUsd);
  const root = transcriptRoot(c.transcript);
  const hash = await send("recordDeal", [caseKey(caseId), cents, root, settlementRef]);
  const r = receipt("recordDeal", hash, { amountCents: cents.toString(), transcriptRoot: root, settlementRef });
  addReceipt(caseId, r);
  emit(caseId, { type: "log", message: `Deal $${amountUsd} recorded on BNB Chain within the patient's mandate`, messageZh: `协议金额 $${amountUsd} 已记录在 BNB 链上（未超出您的授权上限）` });
  return r;
}

export type LedgerView = {
  contract: Address;
  chainId: number;
  caseKey: Hex;
  mandate: { patient: Address; agent: Address; maxAmountCents: string; consentHash: Hex; openedAt: number; patientSigned: boolean; revoked: boolean } | null;
  head: Hex;
  count: number;
  deal: { amountCents: string; transcriptRoot: Hex; logHead: Hex; logCount: number; settlementRef: string; recordedAt: number } | null;
  entries: LedgerEntry[];
  verification: ChainVerification;
};

/** Read mandate/head/deal from chain, then recompute the head from our off-chain entries. */
export async function readLedger(caseId: string): Promise<LedgerView> {
  const { address, pub } = clients();
  const key = caseKey(caseId);
  const [m, [head, count], d] = await Promise.all([
    pub.readContract({ address, abi: LEDGER_ABI, functionName: "getMandate", args: [key] }),
    pub.readContract({ address, abi: LEDGER_ABI, functionName: "getHead", args: [key] }),
    pub.readContract({ address, abi: LEDGER_ABI, functionName: "getDeal", args: [key] }),
  ]);
  const entries = getEntries(caseId);
  return jsonable({
    contract: address,
    chainId: BSC_CHAIN_ID,
    caseKey: key,
    mandate: m.patient === "0x0000000000000000000000000000000000000000" ? null : { ...m, openedAt: Number(m.openedAt) },
    head,
    count: Number(count),
    deal: d.recordedAt === 0n ? null : { ...d, logCount: Number(d.logCount), recordedAt: Number(d.recordedAt) },
    entries,
    verification: verifyChain(entries, { head, count: Number(count) }),
  }) as LedgerView;
}
