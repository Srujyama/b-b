import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/llm.js", () => ({ llmJson: vi.fn(), llmText: vi.fn() }));
import { llmJson } from "../src/llm.js";
import { buildScrapeBody, buildSearchBody, mapUrls, scrape, search, answer, brand, CONTEXT_DEV_BASE, CONTEXT_DEV_BUSY, parseRetryAfter } from "../src/research/contextdev.js";
import { lookupFairPrice, numberAppearsIn } from "../src/research/fairprice.js";
import { MEDICARE_SOURCE_DOMAINS, trustOf } from "../src/research/trust.js";
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

  it("runs one request at a time and retries a rate-limit response", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        // the first call is rate-limited once, then succeeds on retry
        return ++n === 1 ? new Response(JSON.stringify({ error_code: "RATE_LIMITED" }), { status: 429, headers: { "retry-after": "0.01" } }) : new Response(JSON.stringify({ results: [] }));
      }),
    );
    const out = await Promise.all([search("a"), search("b"), search("c")]);
    expect(out).toEqual([[], [], []]);
    expect(maxInFlight).toBe(1);
    expect(n).toBe(4); // 3 searches + 1 retry
  });

  // Context.dev allows one in-flight request per ORGANISATION, so other processes sharing the key
  // cause 429s that can last as long as a slow scrape. These run on fake timers.
  describe("backoff on 429 / 5xx", () => {
    const rateLimited = (headers: Record<string, string> = {}) =>
      new Response(JSON.stringify({ error_code: "RATE_LIMITED", message: "Organization concurrency limit exceeded" }), { status: 429, headers });
    /** fetch that replies with `responses` in order, recording the fake-clock time of each call */
    function scripted(responses: (() => Response)[]) {
      const at: number[] = [];
      const f = vi.fn(async () => {
        at.push(Date.now());
        return (responses[at.length - 1] ?? responses[responses.length - 1])();
      });
      vi.stubGlobal("fetch", f);
      return { f, at };
    }
    beforeEach(() => vi.useFakeTimers({ now: 0 }));
    afterEach(() => {
      vi.useRealTimers();
      delete process.env.CONTEXT_DEV_RETRY_BUDGET_MS;
    });

    it("retries through several 429s with growing waits, then succeeds", async () => {
      const ok = () => new Response(JSON.stringify({ results: [] }));
      const { f, at } = scripted([rateLimited, rateLimited, rateLimited, rateLimited, rateLimited, ok]);
      const p = search("q");
      await vi.runAllTimersAsync();
      await expect(p).resolves.toEqual([]);
      expect(f).toHaveBeenCalledTimes(6); // the old client gave up after 3
      const gaps = at.slice(1).map((t, i) => t - at[i]);
      // equal jitter: attempt n waits between half and all of 500ms * 2^(n-1)
      gaps.forEach((g, i) => {
        expect(g).toBeGreaterThanOrEqual(250 * 2 ** i);
        expect(g).toBeLessThanOrEqual(500 * 2 ** i);
      });
    });

    it("waits at least Retry-After (delta-seconds and HTTP-date forms)", async () => {
      const ok = () => new Response(JSON.stringify({ results: [] }));
      const { at } = scripted([() => rateLimited({ "retry-after": "12" }), () => rateLimited({ "retry-after": new Date(30_000).toUTCString() }), ok]);
      const p = search("q");
      await vi.runAllTimersAsync();
      await p;
      expect(at[1] - at[0]).toBeGreaterThanOrEqual(12_000);
      expect(at[1] - at[0]).toBeLessThan(13_000);
      expect(at[2]).toBeGreaterThanOrEqual(30_000);
      expect(parseRetryAfter("2")).toBe(2000);
      expect(parseRetryAfter("garbage")).toBeUndefined();
      expect(parseRetryAfter(null)).toBeUndefined();
    });

    it("gives up with a 503 'busy' error once the retry budget is spent", async () => {
      process.env.CONTEXT_DEV_RETRY_BUDGET_MS = "20000";
      const { f, at } = scripted([rateLimited]);
      const p = search("q");
      const settled = expect(p).rejects.toMatchObject({ statusCode: 503, errorCode: "RATE_LIMITED", message: CONTEXT_DEV_BUSY });
      await vi.runAllTimersAsync();
      await settled;
      expect(f.mock.calls.length).toBeGreaterThan(3);
      expect(at[at.length - 1]).toBeLessThanOrEqual(20_000); // never sleeps past the budget
    });

    it("never retries a 400 or 401", async () => {
      for (const status of [400, 401]) {
        const { f } = scripted([() => new Response(JSON.stringify({ error_code: "BAD", message: "nope" }), { status })]);
        const p = search("q");
        const settled = expect(p).rejects.toThrow(new RegExp(`HTTP ${status}`));
        await vi.runAllTimersAsync();
        await settled;
        expect(f).toHaveBeenCalledTimes(1);
      }
    });
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

  it("trustOf: government and the hospital's own site are official, known bodies institutional, the rest untrusted", () => {
    expect(trustOf("https://www.medicare.gov/procedure-price-lookup/cost/74177/")).toBe("official");
    expect(trustOf("https://data.cms.gov/x")).toBe("official");
    expect(trustOf("https://billing.mercy.example/prices", "mercy.example")).toBe("official");
    expect(trustOf("https://www.acep.org/apc-faq")).toBe("institutional");
    expect(trustOf("https://claimmaxrcm.com/cpt-code-99285")).toBe("untrusted");
    expect(trustOf("https://notmercy.example/prices", "mercy.example")).toBe("untrusted");
    expect(trustOf("https://cms.gov.evil.example/x")).toBe("untrusted");
    expect(trustOf("not a url")).toBe("untrusted");
  });

  const emptyMedicareGov = (url: string) => ({ url, markdown: { requested: true, success: true, data: "## Code:\n\nFacility Fee\n\n$null" } });

  it("drops untrusted sites before the LLM and keeps only numbers printed in the cited source", async () => {
    mockFetch((r) => {
      if (r.url.endsWith("/web/scrape")) return emptyMedicareGov(r.body.url);
      if (r.url.endsWith("/brand/retrieve")) return { brand: { domain: "mercy.example", title: "Mercy General" } };
      if (r.body?.query?.startsWith("CPT"))
        return { results: [hit("https://billingblog.example/99285", "Blog", ["CPT 99285 pays $171.35"]), hit("https://www.cms.gov/pfs", "PFS", ["CPT 99285 national payment amount $176.17"])] };
      return { results: [hit("https://mercy.example/prices", "Prices", ["99285 ED visit discounted cash price $1,450.00"]), hit("https://aggregator.example/mercy", "Agg", ["99285 cash price $1,200.00"])] };
    });
    llm.mockResolvedValueOnce({ medicareRate: { amount: 176.17, sourceUrl: "https://www.cms.gov/pfs", quote: "CPT 99285 national payment amount $176.17", kind: "professional", plausible: true } });
    // hospital: cash price is real; negotiatedMedian is hallucinated (not in text) -> must be dropped
    llm.mockResolvedValueOnce({ hospitalCashPrice: { amount: 1450, sourceUrl: "https://mercy.example/prices" }, negotiatedMedian: { amount: 999, sourceUrl: "https://mercy.example/prices" } });
    const fp = await lookupFairPrice("99285", "ED visit", "Mercy General");
    expect(fp.medicareRate).toBe(176.17);
    expect(fp.hospitalCashPrice).toBe(1450);
    expect(fp.negotiatedMedian).toBeUndefined();
    expect(fp.sources.map((s) => s.url)).toEqual(["https://www.cms.gov/pfs", "https://mercy.example/prices"]);
    expect(fp.sources[0].title).toMatch(/^Medicare physician fee for 99285/);
    expect(fp.sources.every((s) => s.via === "context.dev")).toBe(true);
    // searches are restricted to trusted domains / the hospital's own site
    const searches = calls.filter((c) => c.url.endsWith("/web/search"));
    expect(searches[0].body.includeDomains).toEqual(MEDICARE_SOURCE_DOMAINS);
    expect(searches[1].body.includeDomains).toEqual(["mercy.example"]);
    // the LLM only ever saw trusted scraped text
    const medicarePrompt = String(llm.mock.calls[0][1]);
    expect(medicarePrompt).toContain("URL: https://www.cms.gov/pfs\nTITLE: PFS\nTRUST: official");
    expect(medicarePrompt).not.toContain("billingblog");
    expect(String(llm.mock.calls[1][1])).not.toContain("aggregator.example");
  });

  it("reads the official medicare.gov price page first and labels the facility rate", async () => {
    const page = "# CT abdomen and pelvis\n\n## Code: 74177\n\n## Hospital outpatient departments\n\nTotal Cost\n\n**$656**\n\nDoctor Fee\n\n$300\n\nFacility Fee\n\n$356";
    mockFetch((r) => (r.url.endsWith("/web/scrape") ? { url: r.body.url, markdown: { requested: true, success: true, data: page } } : { results: [] }));
    llm.mockResolvedValueOnce({ medicareRate: { amount: 356, sourceUrl: "https://www.medicare.gov/procedure-price-lookup/cost/74177/", quote: "Facility Fee $356", kind: "facility", plausible: true } });
    const fp = await lookupFairPrice("74177", "CT abdomen/pelvis");
    const scrapeCall = calls.find((c) => c.url.endsWith("/web/scrape"))!;
    expect(scrapeCall.body).toMatchObject({ url: "https://www.medicare.gov/procedure-price-lookup/cost/74177/", formats: { markdown: true }, sharedParams: { mainContentOnly: true, waitFor: 6000 } });
    expect(String(llm.mock.calls[0][1])).toContain("TRUST: official");
    expect(fp.medicareRate).toBe(356);
    expect(fp.sources[0]).toMatchObject({ url: "https://www.medicare.gov/procedure-price-lookup/cost/74177/", snippet: "Facility Fee $356" });
    expect(fp.sources[0].title).toMatch(/^Medicare hospital facility rate for 74177/);
  });

  it("rejects a printed number Claude flags as implausible, then falls back to Answers -> scrape on trusted sites only", async () => {
    mockFetch((r) => {
      if (r.url.endsWith("/web/search")) return { results: [hit("https://www.acep.org/faq", "FAQ", ["99285 billed charge $4,000.00"])] };
      if (r.url.endsWith("/web/answers")) return { json_content: { source_url: "https://www.cms.gov/lookup", amount: 176.17 }, sources: [] };
      if (r.body.url.includes("medicare.gov")) return emptyMedicareGov(r.body.url);
      return { url: "https://www.cms.gov/lookup", highlights: { requested: true, success: true, data: ["HCPCS 99285 ... see table"] } };
    });
    llm.mockResolvedValueOnce({ medicareRate: { amount: 4000, sourceUrl: "https://www.acep.org/faq", kind: "facility", plausible: false } });
    llm.mockResolvedValueOnce({ medicareRate: { amount: 176.17, sourceUrl: "https://www.cms.gov/lookup", plausible: true } });
    const fp = await lookupFairPrice("99285", "ED visit");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/v1/web/scrape", "/v1/web/search", "/v1/web/answers", "/v1/web/scrape"]);
    expect(fp.medicareRate).toBeUndefined(); // 4000 was implausible; Answers claimed 176.17 but the scraped page doesn't print it
    expect(fp.sources).toEqual([]);
  });

  it("rejects a stale rate from an old report and labels a current one with its year", async () => {
    const thisYear = new Date().getFullYear();
    mockFetch((r) => {
      if (r.url.endsWith("/web/search")) return { results: [hit("https://www.cms.gov/old-report.pdf", "Report", ["APC 0616 (HCPCS 99285), $334.71"]), hit("https://www.acep.org/apc-faq", "APC FAQ", ["5025 | 99285 | Level 5 Type A ED Visits | $612.40"])] };
      if (r.url.endsWith("/web/answers")) return { json_content: {}, sources: [] };
      return emptyMedicareGov(r.body.url);
    });
    llm.mockResolvedValueOnce({ medicareRate: { amount: 334.71, sourceUrl: "https://www.cms.gov/old-report.pdf", kind: "facility", year: thisYear - 10, plausible: true } });
    expect((await lookupFairPrice("99285", "ED visit")).medicareRate).toBeUndefined();
    llm.mockResolvedValueOnce({ medicareRate: { amount: 612.4, sourceUrl: "https://www.acep.org/apc-faq", kind: "facility", year: thisYear, plausible: true } });
    const fp = await lookupFairPrice("99285", "ED visit");
    expect(fp.medicareRate).toBe(612.4);
    expect(fp.sources[0].title).toMatch(new RegExp(`^Medicare hospital facility rate \\(${thisYear}\\) for 99285`));
  });

  it("never scrapes an untrusted page suggested by Answers", async () => {
    mockFetch((r) => {
      if (r.url.endsWith("/web/search")) return { results: [hit("https://blog.example/x", "Blog", ["CPT 99285 pays $171.35"])] };
      if (r.url.endsWith("/web/answers")) return { json_content: { source_url: "https://blog.example/x", amount: 171.35 }, sources: [] };
      return emptyMedicareGov(r.body.url);
    });
    const fp = await lookupFairPrice("99285", "ED visit");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/v1/web/scrape", "/v1/web/search", "/v1/web/answers"]);
    expect(llm).not.toHaveBeenCalled();
    expect(fp.medicareRate).toBeUndefined();
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

  it("search fallback reads only the hospital's own site, never third-party summaries", async () => {
    mockFetch((r) => {
      if (r.url.includes("/web/urls")) return { urls: [] };
      return { results: [hit("https://www.advocamed.example/hospital/st-elsewhere", "Guide", ["free care below 300% FPL"]), hit("https://stelsewhere.example/financial-assistance", "FAP", ["Free care at or below 250% of the FPL."])] };
    });
    llm.mockResolvedValue({ hasFap: true, freeCareBelowPctFpl: 250, discountBelowPctFpl: null, discountPct: null, applicationUrl: null, summary: "Free below 250% FPL.", sourceUrl: "https://stelsewhere.example/financial-assistance" });
    const p = await findCharityPolicy("St Elsewhere", "https://www.stelsewhere.example");
    expect(calls.find((c) => c.url.endsWith("/web/search"))?.body.includeDomains).toEqual(["stelsewhere.example"]);
    expect(String(llm.mock.calls[0][1])).not.toContain("advocamed");
    expect(p).toMatchObject({ hasFap: true, freeCareBelowPctFpl: 250 });
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
    // ceiling (2500) above her limit (2000): aim 20% under the limit, never at it
    const low = buildNegotiation({ bill, flags, fairPrices: fps, patient: patient({ maxPay: 2000 }) });
    expect(low.target).toBe(1600);
    expect(low.walkaway).toBe(2000);
    expect(low.opening).toBeLessThanOrEqual(low.target);
    // exactly at the limit also gets headroom; a $0 charity target is never raised
    expect(buildNegotiation({ bill, flags, fairPrices: fps, patient: patient({ maxPay: 2500 }) }).target).toBe(2000);
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
    process.env.CONTEXT_DEV_API_KEY = ""; // blank, not deleted: dotenv would refill a deleted key from a local .env
    const { buildApp } = await import("../src/index.js");
    const app = await buildApp();
    const c = createCase({ mode: "patient", bill, patient: patient() });
    const res = await app.inject({ method: "POST", url: `/api/cases/${c.id}/research`, payload: {} });
    expect(res.statusCode).toBe(503); // Mercy General has no cached research, so there is nothing to fall back on
    expect(res.json().error).toMatch(/CONTEXT_DEV_API_KEY/);
    await app.close();
  });

  it("researches, builds the ladder and marks the case researched", async () => {
    process.env.ANTHROPIC_API_KEY ||= "test-anthropic";
    mockFetch((r) => {
      if (r.url.includes("/web/search")) {
        const code = r.body.query.includes("99285") ? "99285" : "74177";
        return { results: [hit(`https://www.cms.gov/${code}`, "PFS", [`CPT ${code} national payment amount $${code === "99285" ? "200.00" : "400.00"}`])] };
      }
      if (r.url.includes("/brand/retrieve")) return { brand: { domain: "mercy.example" } };
      if (r.url.includes("/web/urls")) return { urls: [] };
      return {};
    });
    llm.mockImplementation(async (_s: string, user: string) => {
      if (user.includes("Medicare payment amount")) {
        const code = user.includes("Code: 99285") ? "99285" : "74177";
        return { medicareRate: { amount: code === "99285" ? 200 : 400, sourceUrl: `https://www.cms.gov/${code}` } };
      }
      return { hospitalCashPrice: null, negotiatedMedian: null };
    });
    const { buildApp } = await import("../src/index.js");
    const app = await buildApp();
    const c = createCase({ mode: "patient", status: "audited", bill, flags, patient: patient() });
    const res = await app.inject({ method: "POST", url: `/api/cases/${c.id}/research`, payload: {} });
    expect(res.statusCode).toBe(200); // finished inside the route's wait, so the reply is the researched case
    let body = res.json() as CasePacket;
    for (let i = 0; i < 100 && body.status !== "researched"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      body = (await app.inject({ method: "GET", url: `/api/cases/${c.id}` })).json();
    }
    expect(body.status).toBe("researched");
    expect((body as CasePacket & { research?: { state: string } }).research?.state).toBe("done");
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
