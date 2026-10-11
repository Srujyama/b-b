// Pure proof-bundle verification, shared by the browser (verify.js) and the server tests (test/proof.test.ts).
// No DOM, no network, no imports: the keccak-256 function is passed in, so the browser can use a pinned CDN build
// and the tests can use node's copy and compare the result against server/src/chain/bnb.ts verifyChain().
//
// Semantics, matching chain/bnb.ts and contracts/AdvocateLedger.sol EXACTLY:
//   entryHash = keccak256(utf8(canonicalJson(body)))        body = the entry minus entryHash / head / txHash
//   head_0    = 0x00…00 (32 zero bytes)                     the contract's empty heads[caseId]
//   head_i    = keccak256(abi.encodePacked(head_{i-1}, entryHash_i))   i.e. keccak over the 64 raw bytes
// canonicalJson = JSON with object keys sorted, undefined fields dropped, arrays in order.

export const ZERO_HEAD = `0x${"0".repeat(64)}`;

/** Same function as bnb.ts canonicalJson. */
export function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
    .join(",")}}`;
}

export function bytesToHex(b) {
  let s = "0x";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
export function hexToBytes(hex) {
  const s = String(hex).replace(/^0x/i, "");
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error(`not a hex string: ${hex}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const utf8 = (s) => new TextEncoder().encode(s);
const sameHex = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/** The bytes that get hashed for one entry. */
export function entryBytes(body) {
  return utf8(canonicalJson(body));
}
/** Strip the bookkeeping fields so only the hashed body remains (same destructuring as verifyChain). */
export function bodyOf(entry) {
  const { entryHash: _h, head: _hd, txHash: _t, ...body } = entry ?? {};
  return body;
}
export const hashBytes = (keccak, bytes) => bytesToHex(keccak(bytes));
export const hashEntry = (keccak, body) => hashBytes(keccak, entryBytes(body));
export function nextHead(keccak, prevHex, entryHex) {
  const buf = new Uint8Array(64);
  buf.set(hexToBytes(prevHex), 0);
  buf.set(hexToBytes(entryHex), 32);
  return hashBytes(keccak, buf);
}

/** Flip the lowest bit of one byte, the smallest possible edit. Returns a copy. */
export function flipByte(bytes, at) {
  const out = Uint8Array.from(bytes);
  if (!out.length) return out;
  const i = Math.min(Math.max(0, at | 0), out.length - 1);
  out[i] ^= 0x01;
  return out;
}

/**
 * Recompute every entry hash and the running head.
 * entries: [{ ...body, entryHash?, head?, txHash? }] (the bundle's entries, flattened)
 * opts.tamper: { index, byte } flips one byte of that entry's canonical bytes before hashing (local demo only)
 * opts.onChain: { head, count } | null to compare the final head with
 * Returns per-entry rows plus a verdict with the same ok / firstBadIndex semantics as bnb.ts verifyChain().
 */
export function verifyEntries(keccak, entries, opts = {}) {
  const { tamper, onChain } = opts;
  const rows = [];
  let head = ZERO_HEAD;
  let firstBadIndex;
  let reason;
  (entries ?? []).forEach((e, i) => {
    const body = bodyOf(e);
    let bytes = entryBytes(body);
    let tampered = null;
    if (tamper && tamper.index === i) {
      const at = tamper.byte ?? Math.floor(bytes.length / 2);
      const before = bytes;
      bytes = flipByte(bytes, at);
      const pos = Math.min(Math.max(0, at | 0), before.length - 1);
      tampered = { byte: pos, from: String.fromCharCode(before[pos]), to: String.fromCharCode(bytes[pos]) };
    }
    const entryHash = hashBytes(keccak, bytes);
    const hashOk = e.entryHash ? sameHex(e.entryHash, entryHash) : null; // null = nothing recorded to compare
    head = nextHead(keccak, head, entryHash);
    const headOk = e.head ? sameHex(e.head, head) : null;
    if (firstBadIndex === undefined) {
      if (hashOk === false) {
        firstBadIndex = i;
        reason = "entry-edited";
      } else if (headOk === false) {
        firstBadIndex = i;
        reason = "head-mismatch";
      }
    }
    rows.push({ index: i, body, entryHash, recordedEntryHash: e.entryHash ?? null, hashOk, head, recordedHead: e.head ?? null, headOk, tampered });
  });
  const count = rows.length;
  let ok = firstBadIndex === undefined;
  let onChainMatch = null;
  if (onChain && typeof onChain.head === "string") {
    onChainMatch = sameHex(onChain.head, head) && Number(onChain.count) === count;
    if (ok && !onChainMatch) {
      ok = false;
      reason = "onchain-mismatch";
    }
  }
  return { ok, head, count, firstBadIndex, reason, onChainMatch, rows };
}

/** Flatten a bundle's entries ({ body, entryHash, head, txHash }) into the shape verifyChain takes. */
export function flattenEntries(bundle) {
  return (bundle?.entries ?? []).map((e) => ({ ...(e.body ?? {}), entryHash: e.entryHash, head: e.head, ...(e.txHash ? { txHash: e.txHash } : {}) }));
}

/**
 * One-word state for the page header.
 *  broken        an entry or recorded head does not recompute
 *  mismatch      entries are consistent but the on-chain head differs
 *  anchored      consistent and equal to the AdvocateLedger head on BNB testnet
 *  local         consistent, but nothing on-chain to compare with
 *  empty         no log entries yet
 */
export function overall(result, bundle) {
  if (!result.ok && result.reason !== "onchain-mismatch") return "broken";
  if (result.reason === "onchain-mismatch") return "mismatch";
  if (result.count === 0 && !(bundle?.onChain && Number(bundle.onChain.count) > 0)) return "empty";
  if (result.onChainMatch === true) return "anchored";
  return "local";
}

/** Loose structural check on a loaded file; returns a list of problems (empty = looks like a bundle). */
export function bundleProblems(b) {
  const p = [];
  if (!b || typeof b !== "object") return ["not a JSON object"];
  if (typeof b.format !== "string" || !b.format.startsWith("bangbang-proof/")) p.push('missing "format": "bangbang-proof/v1"');
  if (!Array.isArray(b.entries)) p.push('missing "entries" array');
  else
    b.entries.forEach((e, i) => {
      if (!e || typeof e.body !== "object") p.push(`entries[${i}] has no "body"`);
    });
  if (!b.case || typeof b.case.id !== "string") p.push('missing "case.id"');
  return p;
}
