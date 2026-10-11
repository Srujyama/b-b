// Research cache + background research route. No API keys and no network: Context.dev is a stubbed fetch, Claude is
// mocked. The seed cache (data/research-cache.json) is the real committed file.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/llm.js", () => ({ llmJson: vi.fn(), llmText: vi.fn() }));
vi.mock("../src/store.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../src/store.js")>();
  return { ...m, emit: vi.fn(m.emit) };
});

import { llmJson } from "../src/llm.js";
import { createCase, emit } from "../src/store.js";
import { flushAll } from "../src/persist.js";
import { CACHED_VIA, SEED_FILE, cachedCharity, cachedFairPrice, clearRuntimeResearchCache, hospitalKey } from "../src/research/cache.js";
import { MAX_CODES, topCodes } from "../src/routes/research.js";
import type { Bill, CasePacket } from "../src/types.js";

const llm = vi.mocked(llmJson);
let fetchUrls: string[] = [];
type Route = (url: string, body: any) => { status?: number; json: unknown };

function stubContextDev(route: Route) {
  fetchUrls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      fetchUrls.push(String(url));
      const r = route(String(url), init.body ? JSON.parse(String(init.body)) : undefined);
      return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
    }),
  );
}
const OUT_OF_CREDITS: Route = () => ({
  status: 401,
  json: { message: "Insufficient credits: this request needs 2 credits and 0 remain.", error_code: "USAGE_EXCEEDED" },
});

type R = CasePacket & { research?: { state: string; ms?: number; error?: string } };
let app: any;

async function post(url: string, payload: unknown = {}) {
  return app.inject({ method: "POST", url, payload });
}
async function waitFor(id: string, done: (c: R) => boolean, timeoutMs = 5000): Promise<R> {
  const t0 = Date.now();
  for (;;) {
    const c = (await app.inject({ method: "GET", url: `/api/cases/${id}` })).json() as R;
    if (done(c) || Date.now() - t0 > timeoutMs) return c;
    await new Promise((r) => setTimeout(r, 10));
  }
}
const logsFor = (id: string) =>
  vi
    .mocked(emit)
    .mock.calls.filter(([cid, ev]) => cid === id && (ev.type === "log" || ev.type === "error"))
    .map(([, ev]) => (ev as { message: string }).message);

beforeAll(async () => {
  const { buildApp } = await import("../src/index.js");
  app = await buildApp();
});
afterAll(async () => {
  await app?.close();
});
beforeEach(() => {
  clearRuntimeResearchCache();
  llm.mockReset();
  vi.mocked(emit).mockClear();
  vi.stubEnv("CONTEXT_DEV_API_KEY", "test-key");
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("seed cache (data/research-cache.json)", () => {
  const seed = JSON.parse(readFileSync(SEED_FILE, "utf8"));

  it("holds real captured results: every number has a source, and the file says where it came from", () => {
    expect(seed.fetchedAt).toBe("2026-10-11");
    expect(seed.via).toBe(CACHED_VIA);
    for (const e of seed.fairPrices) {
      expect(e.capturedFrom).toMatch(/production case|live run/);
      const fp = e.fairPrice;
      const priced = fp.medicareRate !== undefined || fp.hospitalCashPrice !== undefined || fp.negotiatedMedian !== undefined;
      if (priced) {
        expect(fp.sources.length).toBeGreaterThan(0);
        // the number is printed in the snippet it was read from
        expect(fp.sources.some((s: { snippet?: string }) => s.snippet?.includes(String(fp.medicareRate)))).toBe(true);
      } else expect(e.note).toMatch(/no verifiable published price/);
    }
    const c = seed.charity[0].policy;
    expect(c).toMatchObject({ hospital: "Stanford Health Care", hasFap: true, freeCareBelowPctFpl: 400 });
    expect(c.sources.map((s: { url: string }) => s.url)).toContain("https://stanfordhealthcare.org/for-patients-visitors/financial-assistance.html");
  });

  it("is keyed by a normalized hospital name, labels what it serves, and hands out copies", () => {
    expect(hospitalKey("STANFORD HEALTH CARE")).toBe(hospitalKey("Stanford Health Care, Inc."));
    const fp = cachedFairPrice("STANFORD HEALTH CARE", "74177")!;
    expect(fp).toMatchObject({ code: "74177", medicareRate: 356, cache: { via: "context.dev (cached)", fetchedAt: "2026-10-11" } });
    expect(fp.sources[0].url).toBe("https://www.medicare.gov/procedure-price-lookup/cost/74177/");
    expect(cachedFairPrice("Stanford Health Care", "99285")).toMatchObject({ medicareRate: 608.43 });
    expect(cachedCharity("stanford health care")).toMatchObject({ freeCareBelowPctFpl: 400, cache: { via: CACHED_VIA } });
    fp.billed = 1;
    expect(cachedFairPrice("STANFORD HEALTH CARE", "74177")!.billed).toBeUndefined();
    expect(cachedFairPrice("Mercy General", "74177")).toBeUndefined();
  });
});

describe("demo bill: POST /api/cases/demo then POST /research", () => {
  it("demo intake answers in under 2s; research answers 202 at once and finishes from the cache in under 5s with no Context.dev call", async () => {
    stubContextDev(() => {
      throw new Error("Context.dev must not be called when the cache has the answer");
    });
    let t0 = Date.now();
    const demo = await post("/api/cases/demo");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(demo.statusCode).toBe(200);
    const id = demo.json().id as string;

    t0 = Date.now();
    const res = await post(`/api/cases/${id}/research`);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ id, status: "audited", research: { state: "running" } });
    const c = await waitFor(id, (x) => x.status === "researched");
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(c.status).toBe("researched");
    expect(c.research?.state).toBe("done");
    expect(fetchUrls).toEqual([]);
    expect(llm).not.toHaveBeenCalled();

    // only the top 4 codes by charge (96374 is billed twice: $1,684)
    expect(c.fairPrices.map((f) => [f.code, f.billed, f.medicareRate])).toEqual([
      ["74177", 6245, 356],
      ["99285", 3412, 608.43],
      ["96374", 1684, undefined],
      ["Q9967", 780, undefined],
    ]);
    expect(c.fairPrices.every((f) => (f as { cache?: { via: string } }).cache?.via === CACHED_VIA)).toBe(true);
    expect(c.charity).toMatchObject({ hasFap: true, freeCareBelowPctFpl: 400 });
    expect(c.facts.join("\n")).toMatch(/Medicare pays \$356/);
    expect(typeof c.target).toBe("number"); // the ladder is built (its value depends on the fixture's income)
    expect(c.walkaway).toBe(c.patient!.maxPay);
    expect(logsFor(id)).toEqual(expect.arrayContaining([expect.stringMatching(/^74177: billed \$6,245, Medicare \$356 .*cached Context\.dev result from 2026-10-11/)]));
  });

  it("with no keys at all, the demo bill still researches from the cache", async () => {
    vi.stubEnv("CONTEXT_DEV_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    stubContextDev(() => {
      throw new Error("no network");
    });
    const id = (await post("/api/cases/demo")).json().id;
    expect((await post(`/api/cases/${id}/research`)).statusCode).toBe(202);
    const c = await waitFor(id, (x) => x.status === "researched");
    expect(c.status).toBe("researched");
    expect(fetchUrls).toEqual([]);
    expect(logsFor(id)).toEqual(expect.arrayContaining([expect.stringMatching(/Live research is off \(Context\.dev is not configured.*using cached Context\.dev results/)]));
  });

  it("fresh:true goes live first; when Context.dev is out of credits (401 USAGE_EXCEEDED) it falls back to the cache and says so", async () => {
    stubContextDev(OUT_OF_CREDITS);
    const id = (await post("/api/cases/demo")).json().id;
    const t0 = Date.now();
    expect((await post(`/api/cases/${id}/research`, { fresh: true })).statusCode).toBe(202);
    const c = await waitFor(id, (x) => x.status === "researched");
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(c.status).toBe("researched");
    expect(fetchUrls.length).toBeGreaterThan(0); // it really tried
    expect(c.fairPrices.find((f) => f.code === "74177")?.medicareRate).toBe(356);
    expect(c.charity?.freeCareBelowPctFpl).toBe(400);
    const logs = logsFor(id);
    expect(logs).toEqual(expect.arrayContaining([expect.stringMatching(/^74177: Context\.dev failed \(.*HTTP 401 USAGE_EXCEEDED.*\); using the cached Context\.dev result from 2026-10-11/)]));
    expect(logs).toEqual(expect.arrayContaining([expect.stringMatching(/^charity policy: Context\.dev failed .*using the cached/)]));
  });
});

describe("hospitals with no cached research", () => {
  const bill = (name: string): Bill => ({
    provider: { name },
    lineItems: [
      { code: "99285", description: "ED visit level 5", qty: 1, charge: 4000 },
      { code: "74177", description: "CT abdomen/pelvis", qty: 1, charge: 6000 },
    ],
    totalCharges: 10000,
    patientBalance: 10000,
  });
  const patient = { name: "Lin", language: "en" as const, maxPay: 3000, consent: true };

  it("Context.dev out of credits and nothing cached: 202, then the run fails cleanly and the case stays audited", async () => {
    stubContextDev(OUT_OF_CREDITS);
    const c = createCase({ mode: "patient", status: "audited", bill: bill("Nowhere Regional"), patient });
    expect((await post(`/api/cases/${c.id}/research`)).statusCode).toBe(202);
    const after = await waitFor(c.id, (x) => x.research?.state === "failed");
    expect(after.research?.state).toBe("failed");
    expect(after.research?.error).toMatch(/fair-price research failed for every code: .*USAGE_EXCEEDED.*no cached result to fall back on/);
    expect(after.status).toBe("audited");
    expect(logsFor(c.id)).toEqual(expect.arrayContaining([expect.stringMatching(/^research failed: /)]));
  });

  it("a live result is written to the runtime cache in DATA_DIR and reused, so a second case makes no Context.dev call", async () => {
    stubContextDev((url, body) => {
      if (url.includes("/web/search")) {
        const code = String(body.query).includes("99285") ? "99285" : "74177";
        return { json: { results: [{ url: `https://www.cms.gov/${code}`, title: "PFS", description: "", highlights: { code: "SUCCESS", highlights: [`CPT ${code} national payment amount $${code === "99285" ? "200.00" : "400.00"}`] } }] } };
      }
      if (url.includes("/brand/retrieve")) return { json: { brand: { domain: "lakeside.example" } } };
      if (url.includes("/web/urls")) return { json: { urls: [] } };
      return { json: {} };
    });
    llm.mockImplementation(async (_s: string, user: string) => {
      if (user.includes("Medicare payment amount")) {
        const code = user.includes("Code: 99285") ? "99285" : "74177";
        return { medicareRate: { amount: code === "99285" ? 200 : 400, sourceUrl: `https://www.cms.gov/${code}` } } as never;
      }
      return { hospitalCashPrice: null, negotiatedMedian: null } as never;
    });
    const first = createCase({ mode: "patient", status: "audited", bill: bill("Lakeside Hospital"), patient });
    await post(`/api/cases/${first.id}/research`);
    const a = await waitFor(first.id, (x) => x.status === "researched");
    expect(a.fairPrices.map((f) => [f.code, f.medicareRate])).toEqual([
      ["74177", 400],
      ["99285", 200],
    ]);
    flushAll();
    const file = join(process.env.DATA_DIR!, "research-cache.json");
    expect(existsSync(file)).toBe(true);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    expect(stored["price|lakeside hospital|74177"].value).toMatchObject({ code: "74177", medicareRate: 400 });
    expect(stored["price|lakeside hospital|74177"].value.billed).toBeUndefined();

    // "no financial assistance policy found" is deliberately not cached (a flaky scrape must not stick), so only the
    // charity lookup may go out again; every fair price must come from the cache.
    const bodies: string[] = [];
    stubContextDev((url, body) => {
      bodies.push(JSON.stringify(body ?? {}));
      return { status: 401, json: { message: "out of credits", error_code: "USAGE_EXCEEDED" } };
    });
    const second = createCase({ mode: "patient", status: "audited", bill: bill("LAKESIDE HOSPITAL"), patient });
    await post(`/api/cases/${second.id}/research`);
    const b = await waitFor(second.id, (x) => x.status === "researched");
    expect(b.status).toBe("researched");
    expect(b.fairPrices.map((f) => f.medicareRate)).toEqual([400, 200]);
    expect(b.fairPrices.every((f) => (f as { cache?: { via: string } }).cache?.via === CACHED_VIA)).toBe(true);
    expect(bodies.filter((x) => /CPT|procedure-price-lookup|Medicare/.test(x))).toEqual([]);
    expect(fetchUrls.some((u) => u.includes("medicare.gov"))).toBe(false);
  });

  it("a second POST while research is running does not start another run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    stubContextDev(() => ({ status: 401, json: { message: "out of credits", error_code: "USAGE_EXCEEDED" } }));
    vi.mocked(fetch).mockImplementation(async (u) => {
      fetchUrls.push(String(u));
      await gate;
      return new Response(JSON.stringify({ message: "out of credits", error_code: "USAGE_EXCEEDED" }), { status: 401 });
    });
    const c = createCase({ mode: "patient", status: "audited", bill: bill("Gate Memorial"), patient });
    expect((await post(`/api/cases/${c.id}/research`)).statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    const callsAfterFirst = fetchUrls.length;
    expect((await post(`/api/cases/${c.id}/research`)).statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchUrls.length).toBe(callsAfterFirst);
    release();
    expect((await waitFor(c.id, (x) => x.research?.state === "failed")).research?.state).toBe("failed");
  });
});

describe("topCodes", () => {
  it("merges repeated codes, sorts by total charge and keeps the top MAX_CODES", () => {
    expect(MAX_CODES).toBe(4);
    const b = {
      lineItems: [
        { code: "A", description: "a", qty: 1, charge: 10 },
        { code: "B", description: "b", qty: 1, charge: 50 },
        { code: "A", description: "a again", qty: 1, charge: 45 },
        { description: "no code", qty: 1, charge: 999 },
        { code: "C", description: "c", qty: 1, charge: 30 },
        { code: "D", description: "d", qty: 1, charge: 20 },
        { code: "E", description: "e", qty: 1, charge: 5 },
      ],
    } as Bill;
    expect(topCodes(b).map((c) => [c.code, c.charge, c.description])).toEqual([
      ["A", 55, "a"],
      ["B", 50, "b"],
      ["C", 30, "c"],
      ["D", 20, "d"],
    ]);
  });
});
