// Durable store: atomic JSON files under DATA_DIR (set to a per-file temp dir by test/setup-data-dir.ts).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zeroHash, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Wallet } from "xrpl";
import { claimDataDir, dataDir, persistedMap, writeJsonAtomic } from "../src/persist.js";

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

  it("resolves DATA_DIR and defaults to vellum/server/.data", () => {
    expect(dataDir()).toBe(dir);
    delete process.env.DATA_DIR;
    expect(dataDir()).toMatch(/vellum\/server\/\.data$/);
  });

  it("round-trips a map through disk", () => {
    const a = persistedMap<{ n: number; s: string[] }>("roundtrip");
    a.map.set("x", { n: 1, s: ["Vellum", "ok"] });
    a.map.set("y", { n: 2, s: [] });
    a.save();
    a.flush();
    a.close();
    const b = persistedMap<{ n: number; s: string[] }>("roundtrip");
    expect(Object.fromEntries(b.map)).toEqual({ x: { n: 1, s: ["Vellum", "ok"] }, y: { n: 2, s: [] } });
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

  it("every store is written 0600 (cases hold patient data), and loosened files are tightened on load", () => {
    const s = persistedMap<string>("secretstore", { secret: true });
    s.map.set("c", "fulfillment");
    s.save();
    s.flush();
    expect(mode(s.file())).toBe(0o600);
    s.close();
    const plain = persistedMap<string>("plainstore");
    plain.map.set("c", "Mrs. Lin");
    plain.save();
    plain.flush();
    expect(mode(plain.file())).toBe(0o600);
    plain.close();
    chmodSync(plain.file(), 0o644);
    const again = persistedMap<string>("plainstore");
    expect(again.map.get("c")).toBe("Mrs. Lin");
    expect(mode(again.file())).toBe(0o600);
    again.close();
  });

  it("strict stores re-throw write errors from flush(); non-strict ones only log", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeFileSync(join(dir, "notadir"), "x"); // a file where the data dir should be -> ENOTDIR/EEXIST
    process.env.DATA_DIR = join(dir, "notadir");
    const strict = persistedMap<string>("strictstore", { strict: true });
    strict.map.set("k", "v");
    strict.save();
    expect(() => strict.flush()).toThrow();
    const loose = persistedMap<string>("loosestore");
    loose.map.set("k", "v");
    loose.save();
    expect(() => loose.flush()).not.toThrow();
    // still dirty: once the directory is writable, the next flush lands the data
    process.env.DATA_DIR = dir;
    strict.flush();
    expect(JSON.parse(readFileSync(strict.file(), "utf8"))).toEqual({ k: "v" });
    strict.close();
    loose.close();
  });

  it("one server per DATA_DIR: a lock held by another live process blocks writes loudly", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFileSync(join(dir, ".lock"), String(process.ppid)); // the parent process is alive
    expect(() => claimDataDir(dir)).toThrow(/in use by another Vellum process \(pid \d+\)/);
    const s = persistedMap<string>("locked", { strict: true });
    s.map.set("k", "v");
    s.save();
    expect(() => s.flush()).toThrow(/one server per DATA_DIR/i);
    expect(existsSync(s.file())).toBe(false); // nothing clobbered
    expect(String(err.mock.calls[0][0])).toContain("locked.json");
    expect(() => s.close()).toThrow(/in use/); // strict even on close — but it is untracked afterwards
  });

  it("a lock left by a dead process is taken over; ours is idempotent", () => {
    writeFileSync(join(dir, ".lock"), "2147483646"); // no such pid
    claimDataDir(dir);
    expect(readFileSync(join(dir, ".lock"), "utf8")).toBe(String(process.pid));
    expect(mode(join(dir, ".lock"))).toBe(0o600);
    claimDataDir(dir);
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
    writeJsonAtomic(file, { case1: rec });
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

  it("settle: if the release key cannot be saved, /settle fails loudly and says the funds are locked", async () => {
    vi.resetModules();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const xrpl = await import("../src/chain/xrpl.js");
    const [patient, hospital, issuer, advocate] = [0, 1, 2, 3].map(() => Wallet.generate());
    const ctx = {
      network: "devnet",
      actors: { patient, hospital, issuer, advocate },
      client: {
        request: async () => ({ result: { lines: [{ currency: xrpl.USD, balance: "5000" }] } }),
        autofill: async (tx: object) => ({ ...tx, Sequence: 42, Fee: "12", LastLedgerSequence: 1000 }),
        submitAndWait: async () => {
          // the funds are locked on-chain now; make escrows.json unwritable before the key is saved
          rmSync(dir, { recursive: true, force: true });
          writeFileSync(dir, "not a directory");
          return { result: { hash: "ESCROWTXHASH", tx_json: { Sequence: 42 }, meta: { TransactionResult: "tesSUCCESS" } } };
        },
      },
    } as never;
    const err = await xrpl.createSettlementEscrow("caseZ", 1200, ctx).catch((e) => e);
    expect(err.statusCode).toBe(500);
    expect(err.message).toMatch(/1200 USD IS LOCKED on-chain in XRPL escrow ESCROWTXHASH/);
    expect(err.message).toMatch(/could not be saved to .*escrows\.json/);
    // still releasable from this process's memory
    expect(xrpl.escrowFor("caseZ")?.offerSequence).toBe(42);
    rmSync(dir, { force: true });
    mkdirSync(dir);
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
