// Durable store: atomic JSON files under DATA_DIR (set to a per-file temp dir by test/setup-data-dir.ts).
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zeroHash, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dataDir, persistedMap, writeJsonAtomic } from "../src/persist.js";

const mode = (f: string) => statSync(f).mode & 0o777;

describe("persist", () => {
  let dir: string;
  const prev = process.env.DATA_DIR;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bb-persist-"));
    process.env.DATA_DIR = dir;
  });
  afterEach(() => {
    process.env.DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("resolves DATA_DIR and defaults to bangbang/server/.data", () => {
    expect(dataDir()).toBe(dir);
    delete process.env.DATA_DIR;
    expect(dataDir()).toMatch(/bangbang\/server\/\.data$/);
  });

  it("round-trips a map through disk", () => {
    const a = persistedMap<{ n: number; s: string[] }>("roundtrip");
    a.map.set("x", { n: 1, s: ["帮帮", "ok"] });
    a.map.set("y", { n: 2, s: [] });
    a.save();
    a.flush();
    a.close();
    const b = persistedMap<{ n: number; s: string[] }>("roundtrip");
    expect(Object.fromEntries(b.map)).toEqual({ x: { n: 1, s: ["帮帮", "ok"] }, y: { n: 2, s: [] } });
    b.close();
  });

  it("debounces: many saves, nothing on disk until the window passes, then one write", async () => {
    const s = persistedMap<number>("debounced", { debounceMs: 30 });
    for (let i = 0; i < 50; i++) {
      s.map.set(`k${i}`, i);
      s.save();
    }
    expect(existsSync(s.file())).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(JSON.parse(readFileSync(s.file(), "utf8")).k49).toBe(49);
    s.close();
  });

  it("writes atomically (no temp files left behind)", () => {
    writeJsonAtomic(join(dir, "a.json"), { ok: true });
    writeJsonAtomic(join(dir, "a.json"), { ok: false });
    expect(readdirSync(dir)).toEqual(["a.json"]);
    expect(JSON.parse(readFileSync(join(dir, "a.json"), "utf8"))).toEqual({ ok: false });
  });

  it("survives a corrupt file: logs without contents, starts empty, moves the file aside", () => {
    const file = join(dir, "broken.json");
    writeFileSync(file, '{"x": "A0228020SECRETFULFILLMENT", oops');
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = persistedMap<string>("broken", { secret: true });
    expect(s.map.size).toBe(0);
    expect(err).toHaveBeenCalledTimes(1);
    const msg = String(err.mock.calls[0][0]);
    expect(msg).toContain("broken.json is unreadable");
    expect(msg).not.toContain("SECRET");
    expect(existsSync(file)).toBe(false);
    const aside = readdirSync(dir).filter((f) => f.startsWith("broken.json.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(mode(join(dir, aside[0]))).toBe(0o600);
    // and the store still works afterwards
    s.map.set("k", "v");
    s.save();
    s.flush();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ k: "v" });
    s.close();
  });

  it("treats a non-object JSON file as corrupt", () => {
    writeFileSync(join(dir, "arr.json"), "[1,2,3]");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const s = persistedMap<number>("arr");
    expect(s.map.size).toBe(0);
    s.close();
  });

  it("secret stores are written 0600 (and loosened files are tightened on load)", () => {
    const s = persistedMap<string>("secretstore", { secret: true });
    s.map.set("c", "fulfillment");
    s.save();
    s.flush();
    expect(mode(s.file())).toBe(0o600);
    s.close();
    const plain = persistedMap<string>("plainstore");
    plain.map.set("c", "x");
    plain.save();
    plain.flush();
    expect(mode(plain.file()) & 0o077).not.toBe(0); // non-secret files are not forced private
    plain.close();
  });

  it("restart: cases written by one module instance are loaded by a fresh one", async () => {
    vi.resetModules();
    const store1 = await import("../src/store.js");
    const c = store1.createCase({ mode: "patient" });
    store1.updateCase(c.id, { status: "negotiating" });
    store1.addReceipt(c.id, { chain: "xrpl", kind: "Test", txHash: "ABC", explorerUrl: "https://example.invalid" } as never);
    // an in-place mutation followed by emit (the pattern many routes use) is persisted too
    store1.requireCase(c.id).facts.push({ label: "x" } as never);
    store1.emit(c.id, { type: "log", message: "m", messageZh: "m" } as never);
    store1.flushCases();
    expect(existsSync(join(dir, "cases.json"))).toBe(true);

    vi.resetModules(); // simulate a process restart: new module graph, same DATA_DIR
    const store2 = await import("../src/store.js");
    const back = store2.getCase(c.id)!;
    expect(back).toBeDefined();
    expect(back.status).toBe("negotiating");
    expect(back.receipts.map((r) => r.txHash)).toEqual(["ABC"]);
    expect(back.facts).toHaveLength(1);
    vi.resetModules();
  });

  it("restart: an open XRPL escrow survives, fulfillment stays private, file is 0600", async () => {
    vi.resetModules();
    const xrpl = await import("../src/chain/xrpl.js");
    xrpl._resetEscrows(); // writes the (empty) escrow file
    const file = join(dir, "escrows.json");
    expect(mode(file)).toBe(0o600);
    // what createSettlementEscrow would have written before the restart
    const rec = { owner: "rOwner", destination: "rDest", offerSequence: 7, condition: "A025", fulfillment: "A022SECRET", amount: 1200, cancelAfter: 1, txHash: "TX" };
    writeJsonAtomic(file, { case1: rec }, true);
    xrpl._reloadEscrows();
    const pub = xrpl.escrowFor("case1")!;
    expect(pub.offerSequence).toBe(7);
    expect(pub).not.toHaveProperty("fulfillment");
    // release clears it on disk too
    xrpl._resetEscrows();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
    expect(mode(file)).toBe(0o600);
    vi.resetModules();
  });

  it("restart: BNB off-chain log bodies reload and still verify against the head", async () => {
    vi.resetModules();
    const bnb = await import("../src/chain/bnb.js");
    const bodies = [
      { seq: 0, kind: "offer", by: "hospital", text: "$14,296", amount: 14296, at: "2026-01-01T00:00:00Z" },
      { seq: 1, kind: "offer", by: "advocate", text: "$4,000", amount: 4000, at: "2026-01-01T00:01:00Z" },
    ];
    let head: Hex = zeroHash;
    const entries = bodies.map((b) => {
      const entryHash = bnb.hashEntry(b as never);
      head = bnb.nextHead(head, entryHash);
      return { ...b, entryHash, head };
    });
    writeJsonAtomic(join(dir, "bnb-logs.json"), { caseA: entries });
    bnb._reloadLogs();
    const got = bnb.getEntries("caseA");
    expect(got).toHaveLength(2);
    expect(bnb.verifyChain(got, { head, count: 2 }).ok).toBe(true);
    vi.resetModules();
  });
});
