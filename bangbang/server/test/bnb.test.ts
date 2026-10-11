// AdvocateLedger: compile with solc, EXECUTE the bytecode in a tiny in-process EVM (no EVM package is installed,
// so a minimal paris-fork interpreter lives below), and check TS <-> Solidity agreement. No keys, no network.
import { describe, it, expect, beforeAll } from "vitest";
import {
  bytesToHex,
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  hashDomain,
  hexToBytes,
  keccak256,
  recoverAddress,
  toFunctionSelector,
  zeroHash,
  type AbiParameter,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  BSC_CHAIN_ID,
  LEDGER_ABI,
  MANDATE_TYPES,
  caseKey,
  chainHead,
  compileLedger,
  consentHash,
  hashEntry,
  mandateDomain,
  nextHead,
  signMandate,
  toCents,
  transcriptRoot,
  verifyChain,
  type LedgerEntry,
  type LedgerEntryBody,
} from "../src/chain/bnb.js";

// ------------------------------------------------------------------ mini EVM (paris; enough for solc 0.8 output)
const U256 = 1n << 256n;
const MASK = U256 - 1n;
const signed = (x: bigint) => (x >= 1n << 255n ? x - U256 : x);
const unsigned = (x: bigint) => ((x % U256) + U256) % U256;
const toBig = (b: Uint8Array) => (b.length ? BigInt(bytesToHex(b)) : 0n);
const word = (x: bigint) => hexToBytes(`0x${x.toString(16).padStart(64, "0")}` as Hex);
const addrBig = (a: Address) => BigInt(a);

type Log = { address: Address; topics: Hex[]; data: Hex };
type Result = { success: boolean; returnData: Hex; logs: Log[] };

class MiniEvm {
  storage = new Map<string, Map<bigint, bigint>>();
  code = new Map<string, Uint8Array>();
  timestamp = 1_800_000_000n;
  chainId = BigInt(BSC_CHAIN_ID);

  async deploy(initcode: Hex, address: Address, from: Address): Promise<void> {
    this.storage.set(address.toLowerCase(), new Map());
    const r = await this.exec(hexToBytes(initcode), new Uint8Array(), address, from);
    if (!r.success) throw new Error(`deploy reverted ${r.returnData}`);
    this.code.set(address.toLowerCase(), hexToBytes(r.returnData));
  }

  async call(to: Address, from: Address, data: Hex): Promise<Result> {
    const key = to.toLowerCase();
    const snapshot = new Map(this.storage.get(key));
    const r = await this.exec(this.code.get(key)!, hexToBytes(data), to, from);
    if (!r.success) this.storage.set(key, snapshot); // revert discards state
    return r;
  }

  private async exec(code: Uint8Array, calldata: Uint8Array, address: Address, caller: Address): Promise<Result> {
    const store = this.storage.get(address.toLowerCase())!;
    const jumpdests = new Set<number>();
    for (let i = 0; i < code.length; i++) {
      if (code[i] === 0x5b) jumpdests.add(i);
      if (code[i] >= 0x60 && code[i] <= 0x7f) i += code[i] - 0x5f;
    }
    const stack: bigint[] = [];
    let mem = new Uint8Array(1024);
    let msize = 0;
    let returnData: Uint8Array = new Uint8Array();
    const logs: Log[] = [];
    const pop = () => {
      const v = stack.pop();
      if (v === undefined) throw new Error("stack underflow");
      return v;
    };
    const ensure = (off: number, len: number) => {
      if (len === 0) return;
      const end = off + len;
      if (end > mem.length) {
        const n = new Uint8Array(Math.max(end, mem.length * 2));
        n.set(mem);
        mem = n;
      }
      msize = Math.max(msize, Math.ceil(end / 32) * 32);
    };
    const mread = (off: number, len: number) => {
      ensure(off, len);
      return mem.slice(off, off + len);
    };
    const copyIn = (src: Uint8Array, memOff: number, srcOff: number, len: number) => {
      ensure(memOff, len);
      for (let i = 0; i < len; i++) mem[memOff + i] = srcOff + i < src.length ? src[srcOff + i] : 0;
    };
    let pc = 0;
    for (let steps = 0; steps < 5_000_000; steps++) {
      const op = pc < code.length ? code[pc] : 0x00;
      pc++;
      if (op >= 0x60 && op <= 0x7f) {
        const n = op - 0x5f;
        let v = 0n;
        for (let i = 0; i < n; i++) v = (v << 8n) | BigInt(pc + i < code.length ? code[pc + i] : 0);
        stack.push(v);
        pc += n;
        continue;
      }
      if (op >= 0x80 && op <= 0x8f) {
        stack.push(stack[stack.length - 1 - (op - 0x80)]);
        continue;
      }
      if (op >= 0x90 && op <= 0x9f) {
        const a = stack.length - 1, b = a - (op - 0x8f);
        [stack[a], stack[b]] = [stack[b], stack[a]];
        continue;
      }
      if (op >= 0xa0 && op <= 0xa4) {
        const off = Number(pop()), len = Number(pop());
        const topics: Hex[] = [];
        for (let i = 0; i < op - 0xa0; i++) topics.push(bytesToHex(word(pop())));
        logs.push({ address, topics, data: bytesToHex(mread(off, len)) });
        continue;
      }
      switch (op) {
        case 0x00: return { success: true, returnData: "0x", logs };
        case 0x01: stack.push((pop() + pop()) & MASK); break;
        case 0x02: stack.push((pop() * pop()) & MASK); break;
        case 0x03: { const a = pop(), b = pop(); stack.push(unsigned(a - b)); break; }
        case 0x04: { const a = pop(), b = pop(); stack.push(b === 0n ? 0n : a / b); break; }
        case 0x05: { const a = signed(pop()), b = signed(pop()); stack.push(b === 0n ? 0n : unsigned(a / b)); break; }
        case 0x06: { const a = pop(), b = pop(); stack.push(b === 0n ? 0n : a % b); break; }
        case 0x07: { const a = signed(pop()), b = signed(pop()); stack.push(b === 0n ? 0n : unsigned(a % b)); break; }
        case 0x08: { const a = pop(), b = pop(), n = pop(); stack.push(n === 0n ? 0n : (a + b) % n); break; }
        case 0x09: { const a = pop(), b = pop(), n = pop(); stack.push(n === 0n ? 0n : (a * b) % n); break; }
        case 0x0a: {
          let base = pop(), e = pop(), r = 1n;
          while (e > 0n) { if (e & 1n) r = (r * base) & MASK; base = (base * base) & MASK; e >>= 1n; }
          stack.push(r); break;
        }
        case 0x0b: {
          const b = pop(), x = pop();
          if (b >= 31n) { stack.push(x); break; }
          const bit = b * 8n + 7n, m = (1n << bit) - 1n;
          stack.push((x >> bit) & 1n ? x | (MASK ^ m) : x & m); break;
        }
        case 0x10: { const a = pop(), b = pop(); stack.push(a < b ? 1n : 0n); break; }
        case 0x11: { const a = pop(), b = pop(); stack.push(a > b ? 1n : 0n); break; }
        case 0x12: { const a = signed(pop()), b = signed(pop()); stack.push(a < b ? 1n : 0n); break; }
        case 0x13: { const a = signed(pop()), b = signed(pop()); stack.push(a > b ? 1n : 0n); break; }
        case 0x14: stack.push(pop() === pop() ? 1n : 0n); break;
        case 0x15: stack.push(pop() === 0n ? 1n : 0n); break;
        case 0x16: stack.push(pop() & pop()); break;
        case 0x17: stack.push(pop() | pop()); break;
        case 0x18: stack.push(pop() ^ pop()); break;
        case 0x19: stack.push(MASK ^ pop()); break;
        case 0x1a: { const i = pop(), x = pop(); stack.push(i >= 32n ? 0n : (x >> (8n * (31n - i))) & 0xffn); break; }
        case 0x1b: { const s = pop(), x = pop(); stack.push(s >= 256n ? 0n : (x << s) & MASK); break; }
        case 0x1c: { const s = pop(), x = pop(); stack.push(s >= 256n ? 0n : x >> s); break; }
        case 0x1d: { const s = pop(), x = signed(pop()); stack.push(unsigned(s >= 256n ? (x < 0n ? -1n : 0n) : x >> s)); break; }
        case 0x20: { const off = Number(pop()), len = Number(pop()); stack.push(BigInt(keccak256(mread(off, len)))); break; }
        case 0x30: stack.push(addrBig(address)); break;
        case 0x31: pop(); stack.push(0n); break; // BALANCE
        case 0x34: case 0x3a: case 0x47: stack.push(0n); break; // CALLVALUE, GASPRICE, SELFBALANCE
        case 0x32: case 0x33: stack.push(addrBig(caller)); break;
        case 0x35: { const off = Number(pop()); const b = new Uint8Array(32); for (let i = 0; i < 32; i++) b[i] = calldata[off + i] ?? 0; stack.push(toBig(b)); break; }
        case 0x36: stack.push(BigInt(calldata.length)); break;
        case 0x37: { const m = Number(pop()), s = Number(pop()), l = Number(pop()); copyIn(calldata, m, s, l); break; }
        case 0x38: stack.push(BigInt(code.length)); break;
        case 0x39: { const m = Number(pop()), s = Number(pop()), l = Number(pop()); copyIn(code, m, s, l); break; }
        case 0x3b: pop(); stack.push(0n); break;
        case 0x3d: stack.push(BigInt(returnData.length)); break;
        case 0x3e: {
          const m = Number(pop()), s = Number(pop()), l = Number(pop());
          if (s + l > returnData.length) return { success: false, returnData: "0x", logs: [] };
          copyIn(returnData, m, s, l); break;
        }
        case 0x42: stack.push(this.timestamp); break;
        case 0x43: stack.push(1n); break;
        case 0x46: stack.push(this.chainId); break;
        case 0x50: pop(); break;
        case 0x51: stack.push(toBig(mread(Number(pop()), 32))); break;
        case 0x52: { const off = Number(pop()), v = pop(); ensure(off, 32); mem.set(word(v), off); break; }
        case 0x53: { const off = Number(pop()), v = pop(); ensure(off, 1); mem[off] = Number(v & 0xffn); break; }
        case 0x54: stack.push(store.get(pop()) ?? 0n); break;
        case 0x55: { const k = pop(), v = pop(); store.set(k, v); break; }
        case 0x56: { const d = Number(pop()); if (!jumpdests.has(d)) throw new Error(`bad jump ${d}`); pc = d; break; }
        case 0x57: { const d = Number(pop()), c = pop(); if (c !== 0n) { if (!jumpdests.has(d)) throw new Error(`bad jump ${d}`); pc = d; } break; }
        case 0x58: stack.push(BigInt(pc - 1)); break;
        case 0x59: stack.push(BigInt(msize)); break;
        case 0x5a: stack.push(10_000_000n); break;
        case 0x5b: break;
        case 0xfa: { // STATICCALL — only the ecrecover precompile is needed
          pop(); const to = pop(), ao = Number(pop()), al = Number(pop()), ro = Number(pop()), rl = Number(pop());
          const input = mread(ao, al);
          returnData = new Uint8Array();
          if (to === 1n) {
            const pad = new Uint8Array(128); pad.set(input.slice(0, 128));
            const hash = bytesToHex(pad.slice(0, 32)), v = toBig(pad.slice(32, 64));
            if (v === 27n || v === 28n) {
              try {
                const sig = `0x${bytesToHex(pad.slice(64, 128)).slice(2)}${v === 27n ? "1b" : "1c"}` as Hex;
                returnData = word(BigInt(await recoverAddress({ hash, signature: sig })));
              } catch { /* invalid sig => empty output */ }
            }
          }
          copyIn(returnData, ro, 0, Math.min(rl, returnData.length));
          stack.push(1n); break;
        }
        case 0xf3: { const off = Number(pop()), len = Number(pop()); return { success: true, returnData: bytesToHex(mread(off, len)), logs }; }
        case 0xfd: { const off = Number(pop()), len = Number(pop()); return { success: false, returnData: bytesToHex(mread(off, len)), logs: [] }; }
        case 0xfe: return { success: false, returnData: "0x", logs: [] };
        default: throw new Error(`mini EVM: unsupported opcode 0x${op.toString(16)} at ${pc - 1}`);
      }
    }
    throw new Error("step limit");
  }
}

// ------------------------------------------------------------------ helpers
const CONTRACT = "0x00000000000000000000000000000000000ad0c8" as Address;
const DEPLOYER = "0x000000000000000000000000000000000000dEaD" as Address;
const patient = privateKeyToAccount(generatePrivateKey());
const agent = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

let evm: MiniEvm;
type Fn = Parameters<typeof encodeFunctionData<typeof LEDGER_ABI>>[0]["functionName"];
async function tx(from: Address, functionName: Fn, args: readonly unknown[]) {
  return evm.call(CONTRACT, from, encodeFunctionData({ abi: LEDGER_ABI, functionName, args } as never));
}
async function view<T>(functionName: Fn, args: readonly unknown[] = []): Promise<T> {
  const r = await tx(DEPLOYER, functionName, args);
  expect(r.success).toBe(true);
  return decodeFunctionResult({ abi: LEDGER_ABI, functionName, data: r.returnData } as never) as T;
}
const revertName = (r: Result) => (r.success ? "ok" : decodeErrorResult({ abi: LEDGER_ABI, data: r.returnData }).errorName);

function sig(p: { type: string; components?: readonly AbiParameter[] }): string {
  if (p.type.startsWith("tuple")) return `(${(p.components ?? []).map(sig).join(",")})${p.type.slice(5)}`;
  return p.type;
}
function signatures(abi: readonly unknown[]): string[] {
  return (abi as { type: string; name?: string; inputs?: AbiParameter[]; outputs?: AbiParameter[]; stateMutability?: string }[])
    .map((i) => `${i.type} ${i.name}(${(i.inputs ?? []).map((p) => sig(p) + ((p as { indexed?: boolean }).indexed ? " indexed" : "")).join(",")})${i.outputs ? `->(${i.outputs.map(sig).join(",")})` : ""} ${i.stateMutability ?? ""}`)
    .sort();
}

const entry = (seq: number, kind: LedgerEntryBody["kind"], by: string, text: string, amount?: number): LedgerEntryBody => ({ seq, kind, by, text, amount, at: `2026-10-11T10:0${seq}:00.000Z` });

// ------------------------------------------------------------------ tests
describe("AdvocateLedger.sol compiles", () => {
  it("compiles with the installed solc and the hand-written ABI matches solc's", () => {
    const c = compileLedger();
    expect(c.bytecode.length).toBeGreaterThan(1000);
    expect(signatures(c.abi)).toEqual(signatures(LEDGER_ABI));
  });
});

describe("hash chain (pure TS)", () => {
  const entries = [entry(0, "offer", "hospital", "Balance is $14,212", 14212), entry(1, "offer", "advocate", "We offer $1,900", 1900), entry(2, "transcript", "hospital", "Let me check with my supervisor")];
  const stored: LedgerEntry[] = [];
  let h: Hex = zeroHash;
  for (const e of entries) { const eh = hashEntry(e); h = nextHead(h, eh); stored.push({ ...e, entryHash: eh, head: h }); }

  it("hashing is canonical (key order independent) and the chain verifies", () => {
    const e = entries[1];
    const reordered = { at: e.at, text: e.text, amount: e.amount, by: e.by, kind: e.kind, seq: e.seq } as LedgerEntryBody;
    expect(hashEntry(reordered)).toBe(hashEntry(e));
    expect(chainHead(entries.map(hashEntry))).toBe(h);
    expect(verifyChain(stored, { head: h, count: 3 })).toMatchObject({ ok: true, head: h, count: 3 });
    expect(verifyChain([])).toMatchObject({ ok: true, head: zeroHash, count: 0 });
  });
  it("detects edited, dropped and reordered entries and an on-chain mismatch", () => {
    const edited = stored.map((e) => ({ ...e }));
    edited[1].amount = 9000;
    expect(verifyChain(edited)).toMatchObject({ ok: false, firstBadIndex: 1 });
    expect(verifyChain([stored[0], stored[2]]).ok).toBe(false);
    expect(verifyChain([stored[1], stored[0], stored[2]]).ok).toBe(false);
    const bare = entries.map((e) => ({ ...e }));
    expect(verifyChain(bare, { head: h, count: 3 }).ok).toBe(true);
    expect(verifyChain(bare.slice(0, 2), { head: h, count: 3 }).ok).toBe(false);
  });
  it("cents, case keys and consent/transcript commitments", () => {
    expect(toCents(1899.995)).toBe(190000n);
    expect(toCents(14212.5)).toBe(1421250n);
    expect(() => toCents(-1)).toThrow();
    expect(caseKey("abc")).toBe(keccak256(new TextEncoder().encode("abc")));
    const c = { id: "case-1", patient: { name: "Lin", language: "zh" as const, maxPay: 2500, consent: true } };
    expect(consentHash(c, 250000n)).toBe(consentHash(c, 250000n));
    expect(consentHash(c, 250000n)).not.toBe(consentHash(c, 250001n));
    expect(transcriptRoot([])).toBe(zeroHash);
  });
});

describe("AdvocateLedger executed in an in-process EVM", () => {
  const caseId = caseKey("case-lin-001");
  const consent = keccak256(new TextEncoder().encode("consent"));
  beforeAll(async () => {
    evm = new MiniEvm();
    await evm.deploy(compileLedger().bytecode, CONTRACT, DEPLOYER);
  });

  it("calldata encoding: selectors match the Solidity signatures", () => {
    const data = encodeFunctionData({ abi: LEDGER_ABI, functionName: "appendLog", args: [caseId, consent] });
    expect(data.slice(0, 10)).toBe(toFunctionSelector("appendLog(bytes32,bytes32)"));
    expect(data.length).toBe(2 + 8 + 128);
    expect(encodeFunctionData({ abi: LEDGER_ABI, functionName: "recordDeal", args: [caseId, 1n, zeroHash, "x"] }).slice(0, 10)).toBe(
      toFunctionSelector("recordDeal(bytes32,uint256,bytes32,string)"),
    );
  });

  it("patient opens a mandate; only one per case; log before mandate is refused", async () => {
    expect(revertName(await tx(agent.address, "appendLog", [caseKey("other"), consent]))).toBe("NoMandate");
    const r = await tx(patient.address, "openMandate", [caseId, agent.address, 250000n, consent]);
    expect(r.success).toBe(true);
    const ev = decodeEventLog({ abi: LEDGER_ABI, ...r.logs[0] } as never) as unknown as { eventName: string; args: Record<string, unknown> };
    expect(ev.eventName).toBe("MandateOpened");
    expect(ev.args).toMatchObject({ patient: patient.address, agent: agent.address, maxAmountCents: 250000n, patientSigned: false });
    expect(revertName(await tx(patient.address, "openMandate", [caseId, agent.address, 1n, consent]))).toBe("MandateExists");
    const m = await view<{ patient: Address; maxAmountCents: bigint; openedAt: bigint }>("getMandate", [caseId]);
    expect(m.patient).toBe(patient.address);
    expect(m.maxAmountCents).toBe(250000n);
    expect(m.openedAt).toBe(evm.timestamp);
  });

  it("appendLog head = keccak(prevHead, entryHash), identical to the TS chain", async () => {
    const hashes = [entry(0, "offer", "hospital", "$14,212", 14212), entry(1, "offer", "advocate", "$1,900", 1900), entry(2, "transcript", "hospital", "ok")].map(hashEntry);
    for (let i = 0; i < hashes.length; i++) {
      const r = await tx(agent.address, "appendLog", [caseId, hashes[i]]);
      expect(r.success).toBe(true);
      const ev = decodeEventLog({ abi: LEDGER_ABI, ...r.logs[0] } as never) as unknown as { eventName: string; args: { index: bigint; head: Hex } };
      expect(ev.eventName).toBe("LogAppended");
      expect(ev.args.index).toBe(BigInt(i));
      expect(ev.args.head).toBe(chainHead(hashes.slice(0, i + 1)));
    }
    const [head, count] = await view<[Hex, bigint]>("getHead", [caseId]);
    expect(head).toBe(chainHead(hashes));
    expect(count).toBe(3n);
    expect(revertName(await tx(stranger.address, "appendLog", [caseId, hashes[0]]))).toBe("NotAuthorized");
  });

  it("recordDeal REVERTS above the mandate, only the agent may record, and a deal is final", async () => {
    const over = await tx(agent.address, "recordDeal", [caseId, 250001n, zeroHash, "XRPL:ABC"]);
    expect(over.success).toBe(false);
    const err = decodeErrorResult({ abi: LEDGER_ABI, data: over.returnData });
    expect(err.errorName).toBe("OverMandate");
    expect(err.args).toEqual([250001n, 250000n]);
    expect(revertName(await tx(patient.address, "recordDeal", [caseId, 1n, zeroHash, "x"]))).toBe("NotAuthorized");

    const root = keccak256(new TextEncoder().encode("transcript"));
    const ok = await tx(agent.address, "recordDeal", [caseId, 190000n, root, "XRPL:E5C0FFEE"]);
    expect(ok.success).toBe(true);
    const d = await view<{ amountCents: bigint; transcriptRoot: Hex; logHead: Hex; logCount: bigint; settlementRef: string }>("getDeal", [caseId]);
    const [head] = await view<[Hex, bigint]>("getHead", [caseId]);
    expect(d).toMatchObject({ amountCents: 190000n, transcriptRoot: root, logHead: head, logCount: 3n, settlementRef: "XRPL:E5C0FFEE" });
    expect(revertName(await tx(agent.address, "recordDeal", [caseId, 1n, root, "again"]))).toBe("DealExists");
  });

  it("EIP-712 patient-signed mandate is verified on-chain (ecrecover); tampering fails", async () => {
    const id = caseKey("case-signed");
    const sep = await view<Hex>("domainSeparator");
    expect(sep).toBe(hashDomain({ domain: { ...mandateDomain(BSC_CHAIN_ID, CONTRACT), chainId: BigInt(BSC_CHAIN_ID) }, types: { EIP712Domain: [
      { name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
    ] } }));
    expect(MANDATE_TYPES.Mandate.length).toBe(6);
    const deadline = evm.timestamp + 3600n;
    const msg = { caseId: id, agent: agent.address, maxAmountCents: 300000n, consentHash: consent, nonce: 0n, deadline };
    const s = await signMandate(patient, BSC_CHAIN_ID, CONTRACT, msg);
    // tampered cap -> recovered signer differs
    expect(revertName(await tx(stranger.address, "openMandateWithSig", [id, patient.address, agent.address, 999999n, consent, deadline, s.v, s.r, s.s]))).toBe("BadSignature");
    // someone else's key claiming to be the patient
    const forged = await signMandate(stranger, BSC_CHAIN_ID, CONTRACT, msg);
    expect(revertName(await tx(stranger.address, "openMandateWithSig", [id, patient.address, agent.address, 300000n, consent, deadline, forged.v, forged.r, forged.s]))).toBe("BadSignature");
    // relayed by the server (stranger) — signer is the patient
    const ok = await tx(stranger.address, "openMandateWithSig", [id, patient.address, agent.address, 300000n, consent, deadline, s.v, s.r, s.s]);
    expect(ok.success).toBe(true);
    const m = await view<{ patient: Address; agent: Address; patientSigned: boolean }>("getMandate", [id]);
    expect(m).toMatchObject({ patient: patient.address, agent: agent.address, patientSigned: true });
    expect(await view<bigint>("nonces", [patient.address])).toBe(1n);
    // replay on a new case with the old nonce fails
    expect(revertName(await tx(stranger.address, "openMandateWithSig", [caseKey("case-replay"), patient.address, agent.address, 300000n, consent, deadline, s.v, s.r, s.s]))).toBe("BadSignature");
  });

  it("revoked mandate blocks recordDeal", async () => {
    const id = caseKey("case-revoke");
    await tx(patient.address, "openMandate", [id, agent.address, 100n, consent]);
    expect(revertName(await tx(agent.address, "revokeMandate", [id]))).toBe("NotAuthorized");
    expect((await tx(patient.address, "revokeMandate", [id])).success).toBe(true);
    expect(revertName(await tx(agent.address, "recordDeal", [id, 50n, zeroHash, "x"]))).toBe("MandateIsRevoked");
  });
});

describe("routes degrade loudly", () => {
  it("mandate without consent is 400; without BSC config is 503; ledger without config is 503", async () => {
    const { buildApp } = await import("../src/index.js");
    const { createCase } = await import("../src/store.js");
    for (const k of ["BSC_PRIVATE_KEY", "ADVOCATE_LEDGER_ADDRESS", "PATIENT_EVM_PRIVATE_KEY"]) delete process.env[k];
    const app = await buildApp();
    const noConsent = createCase({ mode: "patient", patient: { name: "Lin", language: "zh", maxPay: 2500, consent: false } });
    let res = await app.inject({ method: "POST", url: `/api/cases/${noConsent.id}/mandate`, payload: {} });
    expect(res.statusCode).toBe(400);
    const c = createCase({ mode: "patient", patient: { name: "Lin", language: "zh", maxPay: 2500, consent: true } });
    res = await app.inject({ method: "POST", url: `/api/cases/${c.id}/mandate`, payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/is not configured/);
    res = await app.inject({ method: "GET", url: `/api/cases/${c.id}/ledger` });
    expect(res.statusCode).toBe(503);
    res = await app.inject({ method: "GET", url: `/api/cases/nope/ledger` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
