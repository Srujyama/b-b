import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/llm.js", () => ({ llmJson: vi.fn(), llmText: vi.fn() }));
import { llmJson } from "../src/llm.js";
import { buildScrapeBody, buildSearchBody, mapUrls, scrape, search, answer, brand, CONTEXT_DEV_BASE } from "../src/research/contextdev.js";
import { lookupFairPrice, numberAppearsIn } from "../src/research/fairprice.js";
import { findCharityPolicy, fplPercent, povertyLine } from "../src/research/charity.js";
import { buildNegotiation } from "../src/research/facts.js";
import { createCase } from "../src/store.js";
import type { Bill, CasePacket, CharityPolicy, FairPrice, Patient } from "../src/types.js";

const llm = vi.mocked(llmJson);
type Req = { url: string; method: string; headers: Record<string, string>; body?: any };
let calls: Req[] = [];

function mockFetch(route: (r: Req) => unknown) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const r: Req = { url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(r);
      const out = route(r);
      const status = (out as any)?.__status ?? 200;
      return new Response(JSON.stringify(out), { status });
    }),
  );
}

const hit = (url: string, title: string, highlights: string[]) => ({ url, title, description: "", relevance: "high", markdown: { markdown: null, code: "NOT_REQUESTED" }, highlights: { highlights, code: "SUCCESS" } });

beforeEach(() => {
  process.env.CONTEXT_DEV_API_KEY = "test-key";
  llm.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CONTEXT_DEV_API_KEY;
});

// ---------------- client ----------------
describe("contextdev client", () => {
  it("builds search requests per the API (numResults clamped 10-100, highlights options)", async () => {
    expect(buildSearchBody("q", { numResults: 3, highlights: true })).toEqual({ query: "q", numResults: 10, country: "us", highlightsOptions: { enabled: true, maxCharacters: 4000 } });
    mockFetch(() => ({ results: [hit("https://a.org/x", "A", ["CPT 99285 pays $180.00"])], query: "q", request_id: "r" }));
    const hits = await search("CPT 99285", { highlights: { maxCharacters: 3000 } });
    expect(calls[0].url).toBe(`${CONTEXT_DEV_BASE}/web/search`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.Authorization).toBe("Bearer test-key");
    expect(calls[0].body.highlightsOptions).toEqual({ enabled: true, maxCharacters: 3000 });
    expect(hits[0].highlights).toEqual(["CPT 99285 pays $180.00"]);
    expect(hits[0].source).toMatchObject({ via: "context.dev", url: "https://a.org/x" });
  });

  it("builds scrape requests with formats + params and surfaces failed outputs", async () => {
    expect(buildScrapeBody("https://h.org/fap.pdf", { highlightsQuery: "fpl" })).toEqual({ url: "https://h.org/fap.pdf", formats: { highlights: true }, highlightsParams: { query: "fpl", maxCharacters: 6000 } });
    expect(buildScrapeBody("https://h.org")).toMatchObject({ formats: { markdown: true }, sharedParams: { mainContentOnly: true } });
    mockFetch(() => ({ url: "https://h.org/fap", markdown: { requested: true, success: false, data: null, error_code: "WEBSITE_BLOCKED" }, highlights: { requested: true, success: true, data: ["200% FPL"] } }));
    const r = await scrape("https://h.org/fap", { markdown: true, highlightsQuery: "fpl" });
    expect(calls[0].url).toBe(`${CONTEXT_DEV_BASE}/web/scrape`);
    expect(r.highlights).toEqual(["200% FPL"]);
    expect(r.errors[0]).toContain("WEBSITE_BLOCKED");
    expect(r.source.via).toBe("context.dev");
  });

  it("calls answers, brand and map endpoints", async () => {
    mockFetch((r) => {
      if (r.url.includes("/web/answers")) return { json_content: { source_url: "https://cms.gov/x" }, sources: ["https://cms.gov/x"] };
      if (r.url.includes("/brand/retrieve")) return { status: "ok", brand: { domain: "hospital.org", title: "Hospital" } };
      return { success: true, domain: "hospital.org", urls: [{ url: "https://hospital.org/financial-assistance" }] };
    });
    const a = await answer("task", { source_url: "" });
    expect(calls[0].body).toEqual({ task: "task", json_format: { source_url: "" }, mode: "fast" });
    expect(a.sources[0]).toMatchObject({ via: "context.dev", url: "https://cms.gov/x" });
    const b = await brand({ name: "Hospital" });
    expect(calls[1].body).toEqual({ type: "by_name", name: "Hospital" });
    expect(b.domain).toBe("hospital.org");
    const urls = await mapUrls("hospital.org", { search: "financial assistance" });
    expect(calls[2].method).toBe("GET");
    const u = new URL(calls[2].url);
    expect(u.pathname).toBe("/v1/web/urls");
    expect(u.searchParams.get("domain")).toBe("hospital.org");
    expect(u.searchParams.get("search")).toBe("financial assistance");
    expect(urls[0].url).toContain("financial-assistance");
  });

  it("fails loudly without a key and on HTTP errors", async () => {
    delete process.env.CONTEXT_DEV_API_KEY;
    await expect(search("x")).rejects.toThrow(/CONTEXT_DEV_API_KEY/);
    process.env.CONTEXT_DEV_API_KEY = "k";
    mockFetch(() => ({ __status: 401, message: "bad key", error_code: "UNAUTHORIZED" }));
    await expect(search("x")).rejects.toThrow(/401 UNAUTHORIZED/);
  });
});

// ---------------- fair price ----------------
describe("lookupFairPrice", () => {
  it("numberAppearsIn handles $ / commas / decimals and rejects partial matches", () => {
    expect(numberAppearsIn("pays $1,234.50 nationally", 1234.5)).toBe(true);
    expect(numberAppearsIn("rate 180.00", 180)).toBe(true);
    expect(numberAppearsIn("rate 1800", 180)).toBe(false);
    expect(numberAppearsIn("rate 180.5", 180)).toBe(false);
  });

  it("keeps only numbers printed in the cited scraped source", async () => {
    mockFetch((r) => {
      if (r.body?.query?.startsWith("CPT")) return { results: [hit("https://cms.example/pfs", "PFS", ["CPT 99285 national payment amount $176.17"])] };
      return { results: [hit("https://hosp.example/prices", "Prices", ["99285 ED visit discounted cash price $1,450.00"])] };
    });
    llm.mockResolvedValueOnce({ medicareRate: { amount: 176.17, sourceUrl: "https://cms.example/pfs", quote: "CPT 99285 national payment amount $176.17" } });
    // hospital: cash price is real; negotiatedMedian is hallucinated (not in text) -> must be dropped
    llm.mockResolvedValueOnce({ hospitalCashPrice: { amount: 1450, sourceUrl: "https://hosp.example/prices" }, negotiatedMedian: { amount: 999, sourceUrl: "https://hosp.example/prices" } });
    const fp = await lookupFairPrice("99285", "ED visit", "Mercy General");
    expect(fp.medicareRate).toBe(176.17);
    expect(fp.hospitalCashPrice).toBe(1450);
    expect(fp.negotiatedMedian).toBeUndefined();
    expect(fp.sources.map((s) => s.url)).toEqual(["https://cms.example/pfs", "https://hosp.example/prices"]);
    expect(fp.sources.every((s) => s.via === "context.dev")).toBe(true);
    // the LLM only ever saw scraped text
    expect(String(llm.mock.calls[0][1])).toContain("URL: https://cms.example/pfs");
  });

  it("falls back to Answers -> scrape, and leaves medicareRate undefined if still unverifiable", async () => {
    mockFetch((r) => {
      if (r.url.endsWith("/web/search")) return { results: [hit("https://blog.example/x", "Blog", ["ER visits are expensive"])] };
      if (r.url.endsWith("/web/answers")) return { json_content: { source_url: "https://cms.example/lookup", amount: 176.17 }, sources: [] };
      return { url: "https://cms.example/lookup", highlights: { requested: true, success: true, data: ["HCPCS 99285 ... see table"] } };
    });
    llm.mockResolvedValue({ medicareRate: { amount: 176.17, sourceUrl: "https://cms.example/lookup" } });
    const fp = await lookupFairPrice("99285", "ED visit");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/v1/web/search", "/v1/web/answers", "/v1/web/scrape"]);
    expect(fp.medicareRate).toBeUndefined(); // Answers claimed 176.17 but the scraped page doesn't print it
    expect(fp.sources).toEqual([]);
  });
});

// ---------------- charity ----------------
describe("charity", () => {
  it("fplPercent uses the 2026 HHS guidelines", () => {
    expect(povertyLine(1)).toBe(15960);
    expect(povertyLine(4)).toBe(33000);
    expect(povertyLine(8)).toBe(55720);
    expect(povertyLine(9)).toBe(61400);
    expect(povertyLine(2, "alaska")).toBe(27050);
    expect(fplPercent(27320, 3)).toBe(100);
    expect(fplPercent(30000, 3)).toBe(109.8);
    expect(() => fplPercent(1, 0)).toThrow();
  });

  it("finds the FAP via brand -> map -> scrape and verifies thresholds", async () => {
    mockFetch((r) => {
      if (r.url.includes("/brand/retrieve")) return { brand: { domain: "mercy.example", title: "Mercy General" } };
      if (r.url.includes("/web/urls")) return { urls: [{ url: "https://mercy.example/about" }, { url: "https://mercy.example/billing/financial-assistance-policy.pdf" }] };
      return { url: r.body.url, highlights: { requested: true, success: true, data: ["Patients with income at or below 200% of the FPL receive free care. 201%-400% FPL receive a 75% discount."] } };
    });
    llm.mockResolvedValue({ hasFap: true, freeCareBelowPctFpl: 200, discountBelowPctFpl: 400, discountPct: 80, applicationUrl: null, summary: "Free below 200% FPL.", sourceUrl: "https://mercy.example/billing/financial-assistance-policy.pdf" });
    const p = await findCharityPolicy("Mercy General");
    expect(calls.find((c) => c.url.includes("/web/scrape"))?.body.url).toBe("https://mercy.example/billing/financial-assistance-policy.pdf");
    expect(p).toMatchObject({ hasFap: true, freeCareBelowPctFpl: 200, discountBelowPctFpl: 400 });
    expect(p.discountPct).toBeUndefined(); // 80 is not printed in the policy text
    expect(p.sources.at(-1)?.url).toBe("https://mercy.example/billing/financial-assistance-policy.pdf");
  });

  it("reports hasFap:false when nothing is found", async () => {
    mockFetch((r) => (r.url.includes("/web/search") ? { results: [] } : { urls: [] }));
    const p = await findCharityPolicy("Nowhere Clinic", "https://nowhere.example");
    expect(p.hasFap).toBe(false);
    expect(llm).not.toHaveBeenCalled();
  });
});

// ---------------- facts / ladder ----------------
const bill: Bill = {
  provider: { name: "Mercy General" },
  lineItems: [
    { code: "99285", description: "ED visit level 5", qty: 1, charge: 4000 },
    { code: "74177", description: "CT abdomen/pelvis", qty: 1, charge: 6000 },
    { code: "74177", description: "CT abdomen/pelvis (duplicate)", qty: 1, charge: 4000 },
  ],
  totalCharges: 14000,
  patientBalance: 14000,
};
const flags: CasePacket["flags"] = [{ kind: "duplicate", lineIndex: 2, message: "CT abdomen/pelvis 74177 billed twice on the same date", amountAtStake: 4000 }];
const fps: FairPrice[] = [
  { code: "99285", medicareRate: 200, sources: [{ title: "Medicare rate for 99285", url: "https://cms.example/99285", via: "context.dev" }] },
  { code: "74177", medicareRate: 400, sources: [{ title: "Medicare rate for 74177", url: "https://cms.example/74177", via: "context.dev" }] },
];
const patient = (p: Partial<Patient> = {}): Patient => ({ name: "Lin", language: "zh", maxPay: 3000, consent: true, ...p });
const fap: CharityPolicy = { hospital: "Mercy General", hasFap: true, freeCareBelowPctFpl: 200, discountBelowPctFpl: 400, discountPct: 75, summary: "", sources: [{ title: "FAP", url: "https://mercy.example/fap.pdf", via: "context.dev" }] };

describe("buildNegotiation", () => {
  it("free care when income is under the free-care FPL threshold", () => {
    const n = buildNegotiation({ bill, flags, fairPrices: fps, charity: fap, patient: patient({ householdSize: 3, annualIncome: 30000 }) });
    expect(n).toMatchObject({ target: 0, opening: 0, walkaway: 3000, basis: "charity", fplPct: 109.8 });
    expect(n.facts.join("\n")).toContain("109.8% of the 2026 federal poverty guideline");
    expect(n.facts.join("\n")).toContain("qualifies for free care");
  });

  it("policy discount applied to the errors-removed balance", () => {
    const n = buildNegotiation({ bill, flags, fairPrices: [], charity: fap, patient: patient({ householdSize: 1, annualIncome: 50000, maxPay: 5000 }) });
    // 50000/15960 = 313.3% -> 75% off (14000-4000) = 2500
    expect(n.target).toBe(2500);
    expect(n.opening).toBe(1500);
    expect(n.basis).toBe("charity");
  });

  it("fair-price target = min(balance - errors, 2.5x Medicare) floored at 1x Medicare, clamped to walkaway", () => {
    // benchmark per line: min(4000, 500)=500 + min(6000,1000)=1000 + min(4000,1000)=1000 => 2500; afterErrors=10000
    const n = buildNegotiation({ bill, flags, fairPrices: fps, patient: patient({ maxPay: 3000 }) });
    expect(n.target).toBe(2500);
    expect(n.basis).toBe("fair_price");
    // opening anchors at 1x Medicare (200+400+400=1000) since that is below target
    expect(n.opening).toBe(1000);
    expect(n.walkaway).toBe(3000);
    expect(n.facts.some((f) => f.includes("Medicare pays $400") && f.includes("15.0x") && f.includes("https://cms.example/74177"))).toBe(true);
    expect(n.facts.some((f) => f.includes("billed twice") && f.includes("$4,000 in dispute"))).toBe(true);
    const low = buildNegotiation({ bill, flags, fairPrices: fps, patient: patient({ maxPay: 2000 }) });
    expect(low.target).toBe(2000);
    expect(low.opening).toBeLessThanOrEqual(low.target);
  });

  it("errors-only and no-research fallbacks", () => {
    const e = buildNegotiation({ bill, flags, fairPrices: [], patient: patient({ maxPay: 20000 }) });
    expect(e).toMatchObject({ target: 10000, opening: 6000, basis: "billing_errors" });
    const b = buildNegotiation({ bill, flags: [], fairPrices: [], patient: patient({ maxPay: 20000 }) });
    expect(b).toMatchObject({ target: 14000, basis: "balance" });
    expect(() => buildNegotiation({ bill, flags: [], fairPrices: [] } as any)).toThrow(/maxPay/);
  });

  it("never states a number it was not given", () => {
    const n = buildNegotiation({ bill, flags: [], fairPrices: [{ code: "99285", sources: [] }], patient: patient() });
    expect(n.facts.join(" ")).not.toMatch(/Medicare pays/);
  });
});

// ---------------- route ----------------
describe("POST /api/cases/:id/research", () => {
  it("503s loudly when Context.dev is not configured", async () => {
    delete process.env.CONTEXT_DEV_API_KEY;
    const { buildApp } = await import("../src/index.js");
    const app = await buildApp();
    const c = createCase({ mode: "patient", bill, patient: patient() });
    const res = await app.inject({ method: "POST", url: `/api/cases/${c.id}/research`, payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/CONTEXT_DEV_API_KEY/);
    await app.close();
  });

  it("researches, builds the ladder and marks the case researched", async () => {
    process.env.OPENAI_API_KEY ||= "test-openai";
    mockFetch((r) => {
      if (r.url.includes("/web/search")) {
        const code = r.body.query.includes("99285") ? "99285" : "74177";
        return { results: [hit(`https://cms.example/${code}`, "PFS", [`CPT ${code} national payment amount $${code === "99285" ? "200.00" : "400.00"}`])] };
      }
      if (r.url.includes("/brand/retrieve")) return { brand: { domain: "mercy.example" } };
      if (r.url.includes("/web/urls")) return { urls: [] };
      return {};
    });
    llm.mockImplementation(async (_s: string, user: string) => {
      if (user.includes("Medicare payment amount")) {
        const code = user.includes("Code: 99285") ? "99285" : "74177";
        return { medicareRate: { amount: code === "99285" ? 200 : 400, sourceUrl: `https://cms.example/${code}` } };
      }
      return { hospitalCashPrice: null, negotiatedMedian: null };
    });
    const { buildApp } = await import("../src/index.js");
    const app = await buildApp();
    const c = createCase({ mode: "patient", status: "audited", bill, flags, patient: patient() });
    const res = await app.inject({ method: "POST", url: `/api/cases/${c.id}/research`, payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json() as CasePacket;
    expect(body.status).toBe("researched");
    expect(body.fairPrices.map((f) => [f.code, f.medicareRate])).toEqual([
      ["74177", 400],
      ["99285", 200],
    ]);
    expect(body.target).toBe(2500);
    expect(body.walkaway).toBe(3000);
    expect(body.charity?.hasFap).toBe(false);
    await app.close();
  });
});
