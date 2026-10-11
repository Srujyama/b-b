// Proof bundle (GET /api/cases/:id/proof) + the browser verifier (web/verify-core.js).
// The browser module is imported as-is and fed node's keccak, then compared with chain/bnb.ts verifyChain,
// so the page and the server/contract can never drift apart silently. No keys, no network.
import { keccak_256 } from "@noble/hashes/sha3";
import { keccak256, stringToBytes, zeroHash, type Hex } from "viem";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson as tsCanonical, chainHead, consentHash, hashEntry as tsHashEntry, nextHead as tsNextHead, toCents, verifyChain, type LedgerEntry } from "../src/chain/bnb.js";
import { buildApp } from "../src/index.js";
import { buildLocalLog, buildProofBundle, previewLogFor, readChainHead, PROOF_FORMAT, type ProofBundle } from "../src/routes/proof.js";
import { seedPreview } from "../src/dev/preview.js";
import { createCase } from "../src/store.js";

// web/verify-core.js is plain browser JS (no .d.ts); this is the surface the tests use.
type Keccak = (b: Uint8Array) => Uint8Array;
type Row = { index: number; entryHash: string; hashOk: boolean | null; head: string; headOk: boolean | null; tampered: { byte: number; from: string; to: string } | null };
type Result = { ok: boolean; head: string; count: number; firstBadIndex?: number; reason?: string; onChainMatch: boolean | null; rows: Row[] };
type Core = {
  canonicalJson(v: unknown): string;
  bytesToHex(b: Uint8Array): string;
  hashEntry(k: Keccak, body: unknown): string;
  nextHead(k: Keccak, prev: string, entry: string): string;
  flipByte(b: Uint8Array, at: number): Uint8Array;
  verifyEntries(k: Keccak, entries: unknown[], opts?: { tamper?: { index: number; byte?: number }; onChain?: { head: string; count: number } | null }): Result;
  flattenEntries(bundle: unknown): unknown[];
  overall(res: Result, bundle: unknown): string;
  bundleProblems(b: unknown): string[];
};
let core: Core;
const keccak = (b: Uint8Array) => keccak_256(b);

beforeAll(async () => {
  core = (await import(/* @vite-ignore */ new URL("../../web/verify-core.js", import.meta.url).href)) as Core;
});

const sample = (): LedgerEntry[] =>
  buildLocalLog([
    { kind: "note", by: "system", text: "call opened", at: "2026-10-11T10:00:00.000Z" },
    { kind: "offer", by: "hospital", text: "Balance is $14,296.", amount: 14296, at: "2026-10-11T10:00:05.000Z" },
    { kind: "transcript", by: "advocate", text: "96374 is billed twice — 重复收费 — please remove it.", at: "2026-10-11T10:00:09.000Z" },
    { kind: "offer", by: "hospital", text: "We can settle at $600.", amount: 600.5, at: "2026-10-11T10:00:30.000Z" },
    { kind: "offer", by: "advocate", amount: 600, at: "2026-10-11T10:00:31.000Z" }, // no text: undefined must be dropped
  ]);

describe("browser verifier (web/verify-core.js) == chain/bnb.ts", () => {
  it("canonicalJson, entry hash and head step are byte-identical to the server", () => {
    for (const e of sample()) {
      const { entryHash: _h, head: _hd, txHash: _t, ...body } = e;
      expect(core.canonicalJson(body)).toBe(tsCanonical(body));
      expect(core.hashEntry(keccak, body)).toBe(tsHashEntry(body));
      expect(core.nextHead(keccak, zeroHash, e.entryHash)).toBe(tsNextHead(zeroHash, e.entryHash));
    }
    // noble keccak (what the page loads) agrees with viem keccak (what the server uses)
    expect(core.bytesToHex(keccak(stringToBytes("Vellum")))).toBe(keccak256(stringToBytes("Vellum")));
  });

  it("recomputes the same head and verdict as verifyChain on an intact log", () => {
    const entries = sample();
    const ts = verifyChain(entries);
    const js = core.verifyEntries(keccak, entries);
    expect(ts.ok).toBe(true);
    expect(js.ok).toBe(true);
    expect(js.head).toBe(ts.head);
    expect(js.head).toBe(chainHead(entries.map((e) => e.entryHash)));
    expect(js.count).toBe(entries.length);
    expect(js.rows.every((r) => r.hashOk && r.headOk)).toBe(true);
  });

  it("agrees with verifyChain on edited, dropped, reordered and on-chain-mismatch logs", () => {
    const base = sample();
    const edited = base.map((e, i) => (i === 2 ? { ...e, text: `${e.text}!` } : e));
    const amountEdited = base.map((e, i) => (i === 1 ? { ...e, amount: 1429.6 } : e));
    const dropped = base.filter((_, i) => i !== 1);
    const reordered = [base[0], base[2], base[1], base[3], base[4]];
    const cases: [string, typeof base, { head: Hex; count: number } | undefined][] = [
      ["edited", edited, undefined],
      ["amountEdited", amountEdited, undefined],
      ["dropped", dropped, undefined],
      ["reordered", reordered, undefined],
      ["onchain-ok", base, { head: base[4].head, count: 5 }],
      ["onchain-stale", base, { head: base[3].head, count: 4 }],
      ["onchain-other", base, { head: keccak256(stringToBytes("x")), count: 5 }],
      ["empty", [], { head: zeroHash, count: 0 }],
    ];
    for (const [name, entries, onChain] of cases) {
      const ts = verifyChain(entries, onChain);
      const js = core.verifyEntries(keccak, entries, { onChain });
      expect(js.ok, name).toBe(ts.ok);
      expect(js.firstBadIndex, name).toBe(ts.firstBadIndex);
      if (ts.ok) expect(js.head, name).toBe(ts.head);
    }
    expect(core.verifyEntries(keccak, edited).reason).toBe("entry-edited");
    expect(core.verifyEntries(keccak, dropped).reason).toBe("head-mismatch");
  });

  it("tamper test: flipping one byte breaks that entry and every head after it", () => {
    const entries = sample();
    const res = core.verifyEntries(keccak, entries, { tamper: { index: 2 } });
    expect(res.ok).toBe(false);
    expect(res.firstBadIndex).toBe(2);
    expect(res.rows[1].headOk).toBe(true);
    expect(res.rows[2].hashOk).toBe(false);
    expect(res.rows[2].tampered?.from).not.toBe(res.rows[2].tampered?.to);
    expect(res.rows.slice(2).every((r) => r.headOk === false)).toBe(true);
    // and it's local: the untampered run is still clean
    expect(core.verifyEntries(keccak, entries).ok).toBe(true);
    expect(core.flipByte(new Uint8Array([0x61]), 0)[0]).toBe(0x60);
  });
});

describe("proof bundle", () => {
  const saved = process.env.ADVOCATE_LEDGER_ADDRESS;
  afterEach(() => {
    if (saved === undefined) delete process.env.ADVOCATE_LEDGER_ADDRESS;
    else process.env.ADVOCATE_LEDGER_ADDRESS = saved;
    delete process.env.DEV_PREVIEW;
  });

  it("says 'contract not deployed' (not a fake head) when the AdvocateLedger has no address", async () => {
    delete process.env.ADVOCATE_LEDGER_ADDRESS;
    const r = await readChainHead("any");
    expect(r.onChain).toBeNull();
    expect(r.reason).toBe("contract not deployed");
    expect(r.detail).toMatch(/ADVOCATE_LEDGER_ADDRESS is not set/);
  });

  it("reads the on-chain head without BSC_PRIVATE_KEY (read-only view, public client only)", async () => {
    const savedKey = process.env.BSC_PRIVATE_KEY;
    const savedRpc = process.env.BSC_RPC_URL;
    try {
      delete process.env.BSC_PRIVATE_KEY;
      process.env.ADVOCATE_LEDGER_ADDRESS = "0x00000000000000000000000000000000000000a1";
      // injected reader: proves readChainHead itself never asks for a signing key
      const head = `0x${"ab".repeat(32)}` as const;
      const r = await readChainHead("case-1", async (id, address) => ({
        contract: address, chainId: 97, caseKey: keccak256(stringToBytes(id)), head, count: 3,
        contractUrl: `https://testnet.bscscan.com/address/${address}`, mandate: null, deal: null,
      }));
      expect(r.onChain?.head).toBe(head);
      expect(r.onChain?.contract).toBe("0x00000000000000000000000000000000000000a1");
      // default reader against an unreachable RPC: fails on the network, never on a missing key
      process.env.BSC_RPC_URL = "http://127.0.0.1:9";
      const f = await readChainHead("case-1");
      expect(f.onChain).toBeNull();
      expect(f.reason).toBe("on-chain read failed");
      expect(f.detail).not.toMatch(/BSC_PRIVATE_KEY/);
      // a malformed address is reported, not sent
      process.env.ADVOCATE_LEDGER_ADDRESS = "0xnope";
      const bad = await readChainHead("case-1");
      expect(bad.onChain).toBeNull();
      expect(bad.detail).toMatch(/not a valid address/);
    } finally {
      if (savedKey === undefined) delete process.env.BSC_PRIVATE_KEY;
      else process.env.BSC_PRIVATE_KEY = savedKey;
      if (savedRpc === undefined) delete process.env.BSC_RPC_URL;
      else process.env.BSC_RPC_URL = savedRpc;
    }
  });

  it("has the documented shape, and the browser verifier accepts it", async () => {
    const c = await seedPreview("receipts", 0);
    const entries = sample();
    const b: ProofBundle = buildProofBundle(c, entries, { onChain: null, reason: "contract not deployed" }, { now: new Date("2026-10-11T12:00:00Z") });
    expect(b.format).toBe(PROOF_FORMAT);
    expect(b.generatedAt).toBe("2026-10-11T12:00:00.000Z");
    expect(b.preview).toBe(true);
    expect(b.notice).toMatch(/^PREVIEW/);
    expect(b.case).toMatchObject({ id: c.id, mode: "patient", status: "settled", billedBalance: 14296, agreedAmount: 600 });
    expect(b.case.caseKey).toBe(keccak256(stringToBytes(c.id)));
    expect(b.entries).toHaveLength(5);
    expect(b.entries[0]).toEqual({ body: { seq: 0, kind: "note", by: "system", text: "call opened", at: "2026-10-11T10:00:00.000Z" }, entryHash: entries[0].entryHash, head: entries[0].head });
    expect(b.claimedHead).toEqual({ head: entries[4].head, count: 5 });
    expect(b.onChain).toBeNull();
    expect(b.onChainReason).toBe("contract not deployed");
    expect(b.serverCheck.ok).toBe(true);
    // mandate commitment is recomputed from the case, and honestly marked as not anchored
    const cents = toCents(c.patient!.maxPay);
    expect(b.mandate).toMatchObject({ maxAmountUsd: c.patient!.maxPay, maxAmountCents: cents.toString(), consentHash: consentHash(c, cents), anchored: false, onChain: null, consentHashMatchesOnChain: null });
    expect(b.receipts.xrpl.length).toBeGreaterThan(0);
    expect(b.receipts.xrpl.every((r) => r.chain === "xrpl")).toBe(true);
    expect(b.receipts.bsc.every((r) => r.chain === "bsc")).toBe(true);

    // round-trips through JSON (what a downloaded file is) and verifies in the browser code
    const file = JSON.parse(JSON.stringify(b));
    expect(core.bundleProblems(file)).toEqual([]);
    const res = core.verifyEntries(keccak, core.flattenEntries(file), { onChain: file.onChain });
    expect(res.ok).toBe(true);
    expect(res.head).toBe(b.claimedHead.head);
    expect(core.overall(res, file)).toBe("local");
    expect(core.bundleProblems({ hello: 1 }).length).toBeGreaterThan(0);
  });

  it("matches an on-chain head, and flags one that disagrees", () => {
    const c = createCase({ mode: "patient" });
    const entries = sample();
    const onChain = { contract: "0x0000000000000000000000000000000000000001", chainId: 97, caseKey: keccak256(stringToBytes(c.id)), head: entries[4].head, count: 5, contractUrl: "https://testnet.bscscan.com/address/0x1", mandate: null, deal: null };
    const good = JSON.parse(JSON.stringify(buildProofBundle(c, entries, { onChain })));
    expect(good.mandate).toBeNull();
    expect(good.mandateReason).toMatch(/no patient/);
    const r1 = core.verifyEntries(keccak, core.flattenEntries(good), { onChain: good.onChain });
    expect(core.overall(r1, good)).toBe("anchored");
    const bad = JSON.parse(JSON.stringify(buildProofBundle(c, entries, { onChain: { ...onChain, head: entries[3].head, count: 4 } })));
    expect(bad.serverCheck.ok).toBe(false);
    const r2 = core.verifyEntries(keccak, core.flattenEntries(bad), { onChain: bad.onChain });
    expect(core.overall(r2, bad)).toBe("mismatch");
    // an edited file is "broken" regardless of the chain
    bad.entries[1].body.amount = 1;
    expect(core.overall(core.verifyEntries(keccak, core.flattenEntries(bad), { onChain: bad.onChain }), bad)).toBe("broken");
  });

  it("GET /api/cases/:id/proof: empty log on a fresh case, 404 on an unknown case, download header", async () => {
    delete process.env.ADVOCATE_LEDGER_ADDRESS;
    const app = await buildApp();
    const c = createCase({ mode: "patient" });
    const res = await app.inject({ method: "GET", url: `/api/cases/${c.id}/proof` });
    expect(res.statusCode).toBe(200);
    const b = res.json() as ProofBundle;
    expect(b.entries).toEqual([]);
    expect(b.claimedHead).toEqual({ head: zeroHash, count: 0 });
    expect(b.onChain).toBeNull();
    expect(b.onChainReason).toBe("contract not deployed");
    expect(b.preview).toBe(false);
    const empty = core.verifyEntries(keccak, core.flattenEntries(b), { onChain: b.onChain });
    expect(core.overall(empty, b)).toBe("empty");

    const dl = await app.inject({ method: "GET", url: `/api/cases/${c.id}/proof?download=1` });
    expect(dl.headers["content-disposition"]).toMatch(/attachment; filename="vellum-proof-/);
    expect(JSON.parse(dl.body).format).toBe(PROOF_FORMAT);

    expect((await app.inject({ method: "GET", url: "/api/cases/nope/proof" })).statusCode).toBe(404);
    // the preview log route is not mounted in a normal run
    expect((await app.inject({ method: "GET", url: "/dev/preview/proof" })).statusCode).toBe(404);
    await app.close();
  });

  it("DEV_PREVIEW=1: /dev/preview/proof seeds a PREVIEW-labelled local log that verifies", async () => {
    process.env.DEV_PREVIEW = "1";
    delete process.env.ADVOCATE_LEDGER_ADDRESS;
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/dev/preview/proof" });
    expect(res.statusCode).toBe(302);
    const id = String(res.headers.location).match(/^\/verify\.html#case=(.+)$/)?.[1];
    expect(id).toBeTruthy();
    const b = (await app.inject({ method: "GET", url: `/api/cases/${id}/proof` })).json() as ProofBundle;
    expect(b.preview).toBe(true);
    expect(b.entriesSource).toMatch(/^PREVIEW/);
    expect(b.entries[0].body.text).toMatch(/^PREVIEW/);
    expect(b.entries.some((e) => e.body.kind === "offer" && e.body.amount === 600)).toBe(true);
    expect(b.entries.every((e) => !e.txHash)).toBe(true); // never claims an on-chain tx
    expect(b.serverCheck.ok).toBe(true);
    expect(core.verifyEntries(keccak, core.flattenEntries(b)).head).toBe(b.claimedHead.head);
    await app.close();
  });

  it("previewLogFor hashes the transcript with the server's own helpers", async () => {
    const c = await seedPreview("receipts", 0);
    const log = previewLogFor(c);
    expect(log).toHaveLength(c.transcript.length + c.offers.length + 1);
    expect(log.filter((e) => e.kind === "offer").map((e) => e.amount)).toEqual(c.offers.map((o) => o.amount));
    expect(verifyChain(log).ok).toBe(true);
  });
});

describe("web: verify page", () => {
  it("serves verify.html, verify.js (pinned keccak from the CDN) and verify.css", async () => {
    const app = await buildApp();
    const html = (await app.inject({ method: "GET", url: "/verify.html" })).body;
    expect(html).toContain('src="/verify.js"');
    expect(html).toContain('href="/verify.css"');
    for (const id of ["vf-verdict", "vf-tamper-on", "vf-entries", "vf-file", "vf-download", "vf-mandate", "vf-receipts"]) expect(html).toContain(`id="${id}"`);
    const js = (await app.inject({ method: "GET", url: "/verify.js" })).body;
    expect(js).toContain('from "./app.js"');
    expect(js).toContain('from "./verify-core.js"');
    expect(js).toMatch(/@noble\/hashes@\d+\.\d+\.\d+\//); // exact version, never a floating tag
    expect(js).toContain("/api/cases/");
    expect((await app.inject({ method: "GET", url: "/verify-core.js" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/verify.css" })).statusCode).toBe(200);
    await app.close();
  });

  it("has zh + en for every verify string, including every data-i18n key in verify.html", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../web/verify.js", import.meta.url), "utf8");
    const html = readFileSync(new URL("../../web/verify.html", import.meta.url), "utf8");
    // evaluate the STRINGS literal alone (the module itself touches the DOM at import time)
    const lit = src.slice(src.indexOf("const STRINGS = {") + "const STRINGS = ".length, src.indexOf("Object.assign(I18N.zh"));
    const S = new Function(`return ${lit.trim().replace(/;$/, "")}`)() as { zh: Record<string, unknown>; en: Record<string, unknown> };
    expect(Object.keys(S.zh).sort()).toEqual(Object.keys(S.en).sort());
    const g = globalThis as Record<string, unknown>;
    g.location ??= { pathname: "/", href: "http://localhost:8787/", protocol: "http:", host: "localhost:8787", hash: "" };
    g.document ??= { body: undefined, getElementById: () => null, querySelectorAll: () => [] };
    const { I18N } = (await import(/* @vite-ignore */ new URL("../../web/app.js", import.meta.url).href)) as { I18N: Record<string, Record<string, unknown>> };
    for (const m of html.matchAll(/data-i18n="(\w+)"/g)) {
      expect(S.zh[m[1]] ?? I18N.zh[m[1]], m[1]).toBeDefined();
      expect(S.en[m[1]] ?? I18N.en[m[1]], m[1]).toBeDefined();
    }
    // every overall() state has copy in both languages
    for (const st of ["anchored", "local", "empty", "broken", "mismatch"]) {
      expect((S.zh.vfStates as Record<string, unknown>)[st], st).toBeDefined();
      expect((S.en.vfStates as Record<string, unknown>)[st], st).toBeDefined();
    }
    expect((S.en.vfStates as Record<string, [string]>).local[0]).toBe("Locally consistent; not yet anchored on BNB");
    // before the hashing library loads there is no verdict: the card must not wear the red "broken" style
    expect(src).not.toMatch(/"vf-verdict broken"/);
    expect(src).toMatch(/"nolib" : "loading"/);
    const css = readFileSync(new URL("../../web/verify.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.vf-verdict\.loading\b/);
    expect(css).toMatch(/\.vf-verdict\.nolib\b/);
  });
});
