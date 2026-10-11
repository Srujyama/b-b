// Hospital financial-assistance (charity care) policy. Nonprofit hospitals must publish a Financial Assistance
// Policy (FAP) under IRS §501(r)(4). We locate it with Context.dev (brand -> site map -> scrape, search fallback)
// and extract FPL thresholds with the LLM ONLY from the scraped text, re-verifying every number.
import type { CharityPolicy, Source } from "../types.js";
import { llmJson } from "../llm.js";
import { brandByName, mapUrls, scrape, search } from "./contextdev.js";
import { trustOf } from "./trust.js";
import { docsPrompt, hitToDoc, numberAppearsIn, type Doc } from "./fairprice.js";

// ---- 2026 HHS poverty guidelines (constant table, cited) ----
export const FPL_2026_SOURCE: Source = {
  title: "2026 HHS Poverty Guidelines (ASPE)",
  url: "https://aspe.hhs.gov/topics/poverty-economic-mobility/poverty-guidelines",
  via: "other",
};
export type FplRegion = "contiguous" | "alaska" | "hawaii";
/** [base for 1 person, increment per additional person] — reproduces the published table for sizes 1-8 and beyond. */
export const FPL_2026: Record<FplRegion, [number, number]> = {
  contiguous: [15960, 5680], // 1: $15,960 ... 4: $33,000 ... 8: $55,720
  alaska: [19950, 7100],
  hawaii: [18360, 6530],
};

export function povertyLine(householdSize: number, region: FplRegion = "contiguous"): number {
  if (!Number.isFinite(householdSize) || householdSize < 1) throw new Error(`householdSize must be >= 1 (got ${householdSize})`);
  const [base, inc] = FPL_2026[region];
  return base + inc * (Math.floor(householdSize) - 1);
}

/** Household income as a percent of the 2026 federal poverty guideline, rounded to 1 decimal. */
export function fplPercent(income: number, householdSize: number, region: FplRegion = "contiguous"): number {
  if (!Number.isFinite(income) || income < 0) throw new Error(`income must be a non-negative number (got ${income})`);
  return Math.round((income / povertyLine(householdSize, region)) * 1000) / 10;
}

// ---- policy discovery ----
const FAP_RE = /financ\w*[-_ ]?assist|charity|fap\b|uncompensated|billing|patient[-_ ]?financial/i;
const HIGHLIGHT_Q = "financial assistance eligibility: percent of federal poverty level for free care and for discounted care, discount percentage, how to apply";

type Extract = {
  hasFap: boolean;
  freeCareBelowPctFpl: number | null;
  discountBelowPctFpl: number | null;
  discountPct: number | null;
  applicationUrl: string | null;
  summary: string;
  sourceUrl: string | null;
};

export function hostOf(website?: string): string | undefined {
  if (!website) return undefined;
  try {
    return new URL(/^https?:\/\//.test(website) ? website : `https://${website}`).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

export type CharityProgress = (message: string, messageZh: string) => void;

export async function findCharityPolicy(hospitalName: string, website?: string, onProgress: CharityProgress = () => {}): Promise<CharityPolicy> {
  const sources: Source[] = [];

  // 1) Company data: resolve the hospital's domain with Context.dev Brand if the bill didn't print a website.
  let domain = hostOf(website);
  if (!domain) {
    try {
      const b = await brandByName(hospitalName);
      domain = b.domain;
      sources.push({ ...b.source, title: `Hospital profile: ${b.title ?? b.domain}` });
      onProgress(`Resolved ${hospitalName} -> ${domain} (Context.dev brand)`, `已找到医院官网：${domain}`);
    } catch (e) {
      onProgress(`Brand lookup failed for ${hospitalName}: ${(e as Error).message}`, `未能通过名称找到医院官网`);
    }
  }

  // 2) Candidate FAP pages: map the hospital's own site, then fall back to web search.
  const candidates: string[] = [];
  if (domain) {
    try {
      const urls = await mapUrls(domain, { search: "financial assistance policy charity care", maxLinks: 20 });
      for (const u of urls) if (FAP_RE.test(u.url) || FAP_RE.test(u.title ?? "")) candidates.push(u.url);
    } catch (e) {
      onProgress(`Site map failed for ${domain}: ${(e as Error).message}`, `无法读取医院网站目录`);
    }
  }
  const docs: Doc[] = [];
  for (const url of candidates.slice(0, 2)) {
    try {
      const page = await scrape(url, { highlightsQuery: HIGHLIGHT_Q });
      const text = (page.highlights?.join("\n…\n") || page.markdown || "").slice(0, 6000);
      if (text.trim()) docs.push({ url: page.url, title: url, text, source: page.source });
    } catch (e) {
      onProgress(`Could not read ${url}: ${(e as Error).message}`, `无法读取页面 ${url}`);
    }
  }
  if (!docs.length) {
    // official sources only: the hospital's own site, or a government filing of its policy
    const hits = await search(`${hospitalName} financial assistance policy charity care federal poverty level`, { highlights: { maxCharacters: 4000 }, ...(domain ? { includeDomains: [domain] } : {}) });
    const official = hits.filter((h) => trustOf(h.url, domain) === "official");
    for (const h of official.slice(0, 4)) {
      const d = hitToDoc(h);
      if (d) docs.push(d);
    }
  }
  if (!docs.length) {
    return { hospital: hospitalName, hasFap: false, summary: `No financial assistance policy for ${hospitalName} could be found via Context.dev.`, sources };
  }
  onProgress(`Reading ${docs.length} financial-assistance source(s) for ${hospitalName}`, `正在阅读医院的经济援助政策（${docs.length} 个来源）`);

  // 3) Extract ONLY from scraped text, then verify every number is printed in the cited source.
  const out = await llmJson<Extract>(
    `You read hospital Financial Assistance Policies (IRS 501(r)). Use ONLY facts printed in the SOURCES; never assume typical values.
If a threshold is not printed, return null. Percents are numbers (e.g. 200 for "200% of the FPL"). sourceUrl = the URL line of the SOURCE you used. Return JSON only.`,
    `Hospital: ${hospitalName}
Return {"hasFap":boolean (true only if a source is this hospital's financial assistance/charity care policy),"freeCareBelowPctFpl":number|null,"discountBelowPctFpl":number|null,"discountPct":number|null (percent off charges for the discounted tier, if a single figure is printed),"applicationUrl":string|null,"summary":string (2 sentences, English, only printed facts),"sourceUrl":string|null}

${docsPrompt(docs)}`,
  );

  const doc = docs.find((d) => d.url === out?.sourceUrl) ?? docs[0];
  const ok = (n: number | null | undefined) => (typeof n === "number" && n > 0 && numberAppearsIn(doc.text, n) ? n : undefined);
  const policy: CharityPolicy = {
    hospital: hospitalName,
    hasFap: Boolean(out?.hasFap),
    freeCareBelowPctFpl: ok(out?.freeCareBelowPctFpl),
    discountBelowPctFpl: ok(out?.discountBelowPctFpl),
    discountPct: ok(out?.discountPct),
    applicationUrl: typeof out?.applicationUrl === "string" && /^https?:\/\//.test(out.applicationUrl) && JSON.stringify(docs).includes(out.applicationUrl) ? out.applicationUrl : undefined,
    summary: out?.summary || `Financial assistance policy for ${hospitalName}.`,
    // cite a page as this hospital's policy only when the model confirmed it is one
    sources: out?.hasFap ? [...sources, { ...doc.source, title: `${hospitalName} financial assistance policy` }] : sources,
  };
  if (policy.discountPct !== undefined && policy.discountPct > 100) policy.discountPct = undefined;
  return policy;
}
