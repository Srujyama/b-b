import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// LLM and Context.dev (fetch) are mocked at the boundary: these tests need NO API keys.
vi.mock("../src/llm.js", () => ({ llmJson: vi.fn(), llmText: vi.fn() }));
import { llmJson } from "../src/llm.js";
import { buildAppealLetter, claimFacts, draftAppeal, mapCriteria, quoteInNotes, validateClaim } from "../src/claims/appeal.js";
import { cleanCriteria, findPayerPolicy, payerDomains, rankPolicyHits } from "../src/claims/policy.js";
import type { SearchHit } from "../src/research/contextdev.js";
import type { ClaimCase } from "../src/types.js";

const llm = vi.mocked(llmJson);
const fixture = JSON.parse(readFileSync(new URL("../fixtures/denial-mri.json", import.meta.url), "utf8"));
const claim: ClaimCase = fixture.claim;
const notes = claim.clinicalNotes;

const POLICY_URL = "https://www.aetna.com/cpb/medical/data/200_299/0236.html";
const POLICY_TITLE = "Magnetic Resonance Imaging (MRI) and Computed Tomography (CT) of the Spine";
const CRITERIA = [
  "Low back pain with radiculopathy persisting after at least 6 weeks of conservative therapy",
  "Objective neurological deficit on examination",
  "Physical therapy or supervised exercise program completed",
  "Red flags such as cauda equina syndrome have been assessed",
  "Prior lumbar MRI within the last 12 months showing the same findings",
];

type Req = { url: string; body?: any };
let calls: Req[] = [];
function mockContextDev() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      if (url.endsWith("/web/search"))
        return Response.json({
          results: [
            { url: "https://www.aetna.com/individuals-families/find-a-doctor.html", title: "Find a doctor", description: "", highlights: { code: "SUCCESS", highlights: ["Find a doctor near you"] } },
            { url: POLICY_URL, title: `${POLICY_TITLE} - Medical Clinical Policy Bulletins`, description: "Aetna considers MRI of the lumbar spine medically necessary...", highlights: { code: "SUCCESS", highlights: ["72148"] } },
          ],
        });
      if (url.endsWith("/web/scrape"))
        return Response.json({
          url: body.url,
          highlights: { requested: true, success: true, data: ["Aetna considers MRI of the lumbar spine medically necessary for radiculopathy after 6 weeks of conservative therapy, or with progressive neurological deficit..."] },
        });
      return Response.json({ message: "unexpected" }, { status: 404 });
    }),
  );
}

/** A plausible model: verdict + verbatim quotes per criterion; criterion 4 is honestly NOT met. */
function installLlm(opts: { fabricate?: boolean } = {}) {
  llm.mockImplementation(async (system: string) => {
    if (system.includes("medical policies")) return { applies: true, title: POLICY_TITLE, sourceUrl: POLICY_URL, criteria: CRITERIA } as never;
    if (system.includes("utilization-review nurse"))
      return {
        results: [
          { index: 0, met: true, quotes: ["since 2026-07-14 (9 weeks)", "persisting after more than 6 weeks of conservative therapy"] },
          { index: 1, met: true, quotes: ["Left ankle (Achilles) reflex absent", "Left plantarflexion strength 4/5"] },
          { index: 2, met: true, quotes: [opts.fabricate ? "Completed 10 weeks of chiropractic care" : "Completed 6 weeks of supervised physical therapy (12 sessions"] },
          { index: 3, met: true, quotes: ["No bowel or bladder dysfunction, no saddle anesthesia"] },
          { index: 4, met: false, quotes: ["No prior lumbar MRI."] },
        ],
      } as never;
    throw new Error(`unexpected llm call: ${system.slice(0, 60)}`);
  });
}

beforeEach(() => {
  process.env.CONTEXT_DEV_API_KEY = "test-key";
  llm.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CONTEXT_DEV_API_KEY;
});

describe("fixture", () => {
  it("is a realistic denied lumbar MRI whose notes meet typical criteria", () => {
    expect(validateClaim(claim)).toBe(claim);
    expect(claim.procedure.code).toBe("72148");
    expect(claim.denialReason).toMatch(/not medically necessary/i);
    expect(claim.diagnoses.map((d) => d.code)).toContain("M54.17");
    expect(notes).toMatch(/6 weeks of supervised physical therapy/);
    expect(notes).toMatch(/reflex absent/);
    expect(claim.policy).toBeUndefined(); // policy is looked up live, never seeded
  });
});

describe("second demo denial (sleep study)", () => {
  const sleep: ClaimCase = JSON.parse(readFileSync(new URL("../fixtures/denial-sleep.json", import.meta.url), "utf8")).claim;
  it("is a valid, different denial whose notes justify skipping the home test", () => {
    expect(validateClaim(sleep)).toBe(sleep);
    expect(sleep.procedure.code).toBe("95810");
    expect(sleep.payer).not.toBe(claim.payer);
    expect(sleep.denialReason).toMatch(/home sleep apnea test/i);
    expect(sleep.clinicalNotes).toMatch(/ejection fraction 30%/);
    expect(sleep.clinicalNotes).toMatch(/continuous home oxygen/);
    expect(sleep.clinicalNotes).toMatch(/medical interpreter/);
    expect(sleep.policy).toBeUndefined(); // looked up live, never seeded
    expect(sleep.criteriaMet).toBeUndefined();
  });
});

describe("policy lookup (pure parts)", () => {
  it("maps payers to their policy domains", () => {
    expect(payerDomains("Aetna Better Health")).toEqual(["aetna.com"]);
    expect(payerDomains("UnitedHealthcare")).toContain("uhcprovider.com");
    expect(payerDomains("Tiny Local Plan")).toEqual([]);
  });
  it("ranks policy-bulletin pages above generic pages", () => {
    const mk = (url: string, title: string): SearchHit => ({ url, title, description: "", source: { title, url, via: "context.dev" } });
    const ranked = rankPolicyHits([mk("https://www.aetna.com/find-a-doctor", "Find a doctor"), mk(POLICY_URL, "Clinical Policy Bulletin 0236")], ["aetna.com"], "72148");
    expect(ranked[0].url).toBe(POLICY_URL);
  });
  it("cleans and dedupes criteria", () => {
    expect(cleanCriteria(["  At least 6 weeks  of therapy ", "at least 6 weeks of therapy", 3, "x"])).toEqual(["At least 6 weeks of therapy"]);
  });
});

describe("findPayerPolicy (mocked Context.dev + LLM)", () => {
  it("searches the payer's domain, scrapes the policy and cites its url", async () => {
    mockContextDev();
    installLlm();
    const p = await findPayerPolicy("Aetna", "72148", "MRI lumbar spine without contrast");
    expect(p).toEqual({ title: POLICY_TITLE, url: POLICY_URL, criteria: CRITERIA });
    expect(calls[0].body.includeDomains).toEqual(["aetna.com"]);
    expect(calls[1].url).toMatch(/\/web\/scrape$/);
    expect(calls[1].body.url).toBe(POLICY_URL); // policy-looking hit ranked first
  });
  it("fails loudly without a Context.dev key", async () => {
    delete process.env.CONTEXT_DEV_API_KEY;
    await expect(findPayerPolicy("Aetna", "72148", "MRI")).rejects.toThrow(/CONTEXT_DEV_API_KEY/);
  });
  it("refuses to invent criteria when no page is a policy", async () => {
    mockContextDev();
    llm.mockResolvedValue({ applies: false, title: null, sourceUrl: null, criteria: [] } as never);
    await expect(findPayerPolicy("Aetna", "72148", "MRI")).rejects.toThrow(/none was a medical policy/);
  });
});

describe("criteria mapping", () => {
  it("verifies quotes verbatim (case/whitespace-insensitive)", () => {
    expect(quoteInNotes("left ankle (achilles)   reflex absent", notes)).toBe(true);
    expect(quoteInNotes("Completed 6 weeks ... without improvement", notes)).toBe(true);
    expect(quoteInNotes("MRI showed a herniated disc", notes)).toBe(false);
  });
  it("maps by index, falls back to text, marks skipped criteria not met", () => {
    const r = mapCriteria(
      ["A criterion", "B criterion", "C criterion"],
      [{ criterion: "b criterion", met: true, quotes: ["Gait antalgic"] }, { index: 0, met: true, quotes: ["No prior lumbar MRI"] }],
      notes,
    );
    expect(r.map((x) => x.met)).toEqual([true, true, false]);
    expect(r[1].evidence).toBe('"Gait antalgic"');
    expect(r[2].evidence).toMatch(/Not evaluated/);
  });
  it("downgrades a 'met' verdict whose evidence is not in the chart", () => {
    const [r] = mapCriteria(["PT completed"], [{ index: 0, met: true, quotes: ["Completed 10 weeks of chiropractic care"] }], notes);
    expect(r.met).toBe(false);
    expect(r.evidence).toMatch(/not in the chart/);
  });
});

describe("draftAppeal", () => {
  it("looks up the policy, checks every criterion with quoted evidence, and writes the letter", async () => {
    mockContextDev();
    installLlm();
    const out = await draftAppeal(claim);
    expect(out.policy?.url).toBe(POLICY_URL);
    expect(out.criteriaMet).toHaveLength(CRITERIA.length);
    expect(out.criteriaMet!.map((c) => c.met)).toEqual([true, true, true, true, false]);
    expect(out.criteriaMet![1].evidence).toContain("Left ankle (Achilles) reflex absent");
    const letter = out.appealLetter!;
    for (const c of out.criteriaMet!.filter((c) => c.met)) {
      expect(letter).toContain(c.criterion);
      expect(letter).toContain(c.evidence);
    }
    expect(letter).toContain(POLICY_TITLE);
    expect(letter).toContain(POLICY_URL);
    expect(letter).toMatch(/reverse the denial/i);
    expect(letter).toMatch(/peer-to-peer/i);
    expect(letter).toContain("EXAMPLE-2026-0917-4412");
    expect(letter).not.toMatch(/MET\. Documentation in the medical record: .*Prior lumbar MRI/);
  });
  it("never lets a fabricated quote through into the letter", async () => {
    mockContextDev();
    installLlm({ fabricate: true });
    const out = await draftAppeal(claim);
    expect(out.criteriaMet![2].met).toBe(false);
    expect(out.appealLetter).not.toContain("chiropractic");
  });
  it("reuses a caller-supplied policy without searching", async () => {
    mockContextDev();
    installLlm();
    const out = await draftAppeal({ ...claim, policy: { title: POLICY_TITLE, url: POLICY_URL, criteria: CRITERIA } });
    expect(calls).toHaveLength(0);
    expect(out.criteriaMet!.filter((c) => c.met)).toHaveLength(4);
  });
  it("rejects malformed claims with 400", async () => {
    await expect(draftAppeal({ payer: "Aetna" } as ClaimCase)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("letter + facts (pure)", () => {
  const policy = { title: "Policy T", url: "https://payer.example/policy", criteria: ["Crit one", "Crit two"] };
  const results = [
    { criterion: "Crit one", met: true, evidence: '"quote one"' },
    { criterion: "Crit two", met: true, evidence: '"quote two"' },
  ];
  it("letter contains every met criterion and its evidence", () => {
    const letter = buildAppealLetter(claim, policy, results, new Date("2026-10-11"));
    expect(letter.startsWith("2026-10-11")).toBe(true);
    for (const r of results) {
      expect(letter).toContain(r.criterion);
      expect(letter).toContain(r.evidence);
    }
    expect(letter).toMatch(/documents every one of them/);
  });
  it("facts cite the policy and each met criterion", () => {
    const facts = claimFacts({ ...claim, policy, criteriaMet: results, appealLetter: "x" });
    expect(facts.join("\n")).toContain("Policy T");
    expect(facts.filter((f) => f.startsWith("Policy criterion"))).toHaveLength(2);
    expect(facts).toContain("2 of 2 criteria in the payer's policy are documented in the chart.");
  });
});

describe("routes", () => {
  it("POST /api/claims/demo builds a clinic case with policy, criteria, letter and facts", async () => {
    mockContextDev();
    installLlm();
    const { buildApp } = await import("../src/index.js");
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/claims/demo", payload: {} });
    expect(res.statusCode).toBe(200);
    const c = res.json();
    expect(c.mode).toBe("clinic");
    expect(c.status).toBe("researched");
    expect(c.claim.policy.url).toBe(POLICY_URL);
    expect(c.claim.criteriaMet).toHaveLength(5);
    expect(c.claim.appealLetter).toContain(POLICY_TITLE);
    expect(c.patient.name).toMatch(/Bayview/);
    expect(c.facts.some((f: string) => f.includes("reflex absent"))).toBe(true);

    // POST /api/claims accepts {claim}; derived fields from the caller are discarded and recomputed.
    const res2 = await app.inject({ method: "POST", url: "/api/claims", payload: { claim: { ...claim, criteriaMet: [{ criterion: "x", met: true, evidence: "y" }], appealLetter: "fake" } } });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().claim.appealLetter).not.toBe("fake");
    expect(res2.json().claim.criteriaMet).toHaveLength(5);

    const bad = await app.inject({ method: "POST", url: "/api/claims", payload: { claim: { payer: "Aetna" } } });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
  it("POST /api/claims/demo picks a named demo denial and rejects unknown names", async () => {
    delete process.env.CONTEXT_DEV_API_KEY; // the fixture choice is validated before any lookup
    const { buildApp } = await import("../src/index.js");
    const app = await buildApp();
    for (const fixture of ["nope", "toString", "__proto__"]) {
      const res = await app.inject({ method: "POST", url: "/api/claims/demo", payload: { fixture } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/mri, sleep/);
    }
    // a valid name reaches the live lookup (503 here only because Context.dev has no key in tests)
    const ok = await app.inject({ method: "POST", url: "/api/claims/demo", payload: { fixture: "sleep" } });
    expect(ok.statusCode).toBe(503);
    await app.close();
  });
  it("returns 503 when Context.dev is not configured", async () => {
    delete process.env.CONTEXT_DEV_API_KEY;
    const { buildApp } = await import("../src/index.js");
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/claims/demo", payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/CONTEXT_DEV_API_KEY/);
    await app.close();
  });
});
