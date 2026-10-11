// Fair-price lookup: Medicare rate + the hospital's own price-transparency numbers, found with Context.dev
// and extracted by the LLM ONLY from scraped text. Sources are restricted to trusted sites (trust.ts): the official
// medicare.gov price page first, then an allowlisted search. Every number is re-checked against the source text it
// was cited from, and Claude sanity-checks it against what it knows; anything unverifiable stays undefined.
import type { FairPrice, Source } from "../types.js";
import { llmJson } from "../llm.js";
import { answer, brandByName, scrape, search, type SearchHit } from "./contextdev.js";
import { isOnDomain, isTrusted, MEDICARE_SOURCE_DOMAINS, trustOf, type Trust } from "./trust.js";

/** A scraped page reduced to the text the LLM is allowed to read. */
export type Doc = { url: string; title: string; text: string; source: Source; trust?: Trust };

const MAX_DOC_CHARS = 5000;

export function hitToDoc(h: SearchHit): Doc | undefined {
  const text = (h.highlights?.join("\n…\n") || h.markdown || "").slice(0, MAX_DOC_CHARS);
  return text.trim() ? { url: h.url, title: h.title, text, source: h.source } : undefined;
}

export function docsPrompt(docs: Doc[]): string {
  return docs.map((d, i) => `### SOURCE ${i + 1}\nURL: ${d.url}\nTITLE: ${d.title}\n${d.trust ? `TRUST: ${d.trust}\n` : ""}${d.text}`).join("\n\n");
}

/** True if `n` is literally printed in `text` (handles $, commas, trailing .00). */
export function numberAppearsIn(text: string, n: number): boolean {
  if (!Number.isFinite(n)) return false;
  const t = text.replace(/(\d),(?=\d{3})/g, "$1");
  const forms = new Set<string>([String(n), n.toFixed(2)]);
  if (Number.isInteger(n)) forms.add(`${n}.00`);
  return [...forms].some((f) => new RegExp(`(^|[^\\d.])${f.replace(".", "\\.")}(?![\\d]|\\.\\d)`).test(t));
}

type Cited = { amount: number | null; sourceUrl: string | null; quote?: string | null } | null | undefined;

/** Accept an LLM-cited number only if its URL is one we scraped and the number is printed in that page's text. */
export function verifyCited(c: Cited, docs: Doc[], mustContain?: string): { amount: number; doc: Doc; quote?: string } | undefined {
  if (!c || typeof c.amount !== "number" || !c.sourceUrl || c.amount <= 0) return undefined;
  const doc = docs.find((d) => d.url === c.sourceUrl);
  if (!doc || !numberAppearsIn(doc.text, c.amount)) return undefined;
  if (mustContain && !doc.text.toUpperCase().includes(mustContain.toUpperCase())) return undefined;
  return { amount: c.amount, doc, quote: c.quote ?? undefined };
}

const citeSource = (v: { doc: Doc; quote?: string }, label: string): Source => ({ ...v.doc.source, title: `${label}: ${v.doc.title || v.doc.url}`, snippet: (v.quote || v.doc.source.snippet)?.slice(0, 500) });

const SYSTEM = `You extract US healthcare prices from web page excerpts. Rules:
- Use ONLY numbers literally printed in the SOURCES. Never estimate, compute, recall or round.
- If a value is not printed for exactly this code, return null for it.
- sourceUrl must be the URL line of the SOURCE the number came from; quote = the exact sentence/row containing it.
Return JSON only.`;

type RateKind = "facility" | "professional";
type MedicareCited = (NonNullable<Cited> & { kind?: RateKind | null; year?: number | null; plausible?: boolean | null }) | null | undefined;
type MedicareExtract = { medicareRate: MedicareCited };
type HospitalExtract = { hospitalCashPrice: Cited; negotiatedMedian: Cited };

const withTrust = (d: Doc, ownerDomain?: string): Doc => ({ ...d, trust: trustOf(d.url, ownerDomain) });

const PRINTS_DOLLARS = /\$\s?\d/;

/** Search hits -> docs: drop every untrusted site and every page that doesn't mention the code, then put pages that print a dollar amount first, official ones ahead. */
function trustedDocs(hits: SearchHit[], code: string, ownerDomain?: string): Doc[] {
  const rank = (d: Doc) => 2 * Number(PRINTS_DOLLARS.test(d.text)) + Number(d.trust === "official");
  return hits
    .map(hitToDoc)
    .filter((d): d is Doc => Boolean(d))
    .map((d) => withTrust(d, ownerDomain))
    .filter((d) => d.trust !== "untrusted" && d.text.toUpperCase().includes(code.toUpperCase()))
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, 6);
}

const MAX_RATE_AGE_YEARS = 1; // accept this year's or last year's Medicare rate, nothing older
const MEDICARE_GOV_WAIT_MS = 6000; // the price page fills its numbers in with JavaScript

/** Medicare's own Procedure Price Lookup page for a code (national averages, doctor fee + facility fee). Not every code has one. */
async function medicareGovDoc(code: string): Promise<Doc | undefined> {
  if (!/^[A-Z0-9]{5}$/i.test(code)) return undefined;
  try {
    const page = await scrape(`https://www.medicare.gov/procedure-price-lookup/cost/${code}/`, { markdown: true, waitForMs: MEDICARE_GOV_WAIT_MS });
    const text = (page.markdown ?? "").slice(0, MAX_DOC_CHARS);
    // a code Medicare doesn't list renders an empty template ("Code:" with "$null" amounts)
    if (!text.toUpperCase().includes(`CODE: ${code.toUpperCase()}`) || !/\$\d/.test(text)) return undefined;
    return { url: page.url, title: `Medicare.gov Procedure Price Lookup: ${code}`, text, source: page.source, trust: "official" };
  } catch {
    return undefined;
  }
}

// ACEP (American College of Emergency Physicians) reprints CMS's current OPPS payment rates for the codes an ER bills most.
const ACEP_APC_FAQ = "https://www.acep.org/administration/reimbursement/reimbursement-faqs/apc-ambulatory-payment-classifications-faq";
let acepPage: Promise<{ url: string; markdown: string; source: Source }> | undefined;

/** The table rows that mention `code`, each with the nearest heading above it that names the payment year,
 *  plus any sentence stating the year's conversion factor (payment = relative weight x conversion factor). */
export function rateRowsFor(markdown: string, code: string): string {
  const lines = markdown.split("\n");
  const codeRe = new RegExp(`(^|[^A-Z0-9])${code.replace(/[^A-Z0-9]/gi, "\\$&")}([^A-Z0-9]|$)`, "i");
  const out = new Set<number>();
  lines.forEach((line, i) => {
    if (!codeRe.test(line)) return;
    for (let j = i; j >= Math.max(0, i - 40); j--) {
      // a year, not part of a price or decimal ("$2026.10", "2.2023")
      if (/(?<![\d.,$])20\d\d(?![\d.,])/.test(lines[j]) && j !== i) {
        out.add(j).add(j + 1); // the dated title and the column header under it
        break;
      }
    }
    out.add(i);
  });
  if (out.size) lines.forEach((line, i) => /conversion factor/i.test(line) && /\$\d/.test(line) && out.size < 12 && out.add(i));
  return [...out].sort((a, b) => a - b).map((i) => lines[i]).join("\n").slice(0, MAX_DOC_CHARS);
}

/** ACEP's rate table, scraped once per process and cut down to the rows for this code. */
async function acepDoc(code: string): Promise<Doc | undefined> {
  try {
    acepPage ??= scrape(ACEP_APC_FAQ, { markdown: true }).then((p) => ({ url: p.url, markdown: p.markdown ?? "", source: p.source }));
    const page = await acepPage;
    const text = rateRowsFor(page.markdown, code);
    if (!PRINTS_DOLLARS.test(text)) return undefined;
    return { url: page.url, title: "ACEP: OPPS APC payment rates", text, source: page.source, trust: trustOf(page.url) };
  } catch {
    acepPage = undefined; // don't cache a failed scrape
    return undefined;
  }
}

async function medicareFrom(code: string, description: string, docs: Doc[]) {
  if (!docs.length) return undefined;
  const out = await llmJson<MedicareExtract>(
    SYSTEM,
    `Code: ${code} (${description}). Find the Medicare payment amount for this exact code.
This is for a HOSPITAL bill, so prefer the hospital outpatient FACILITY payment: the OPPS/APC national payment rate, or on medicare.gov the "Facility Fee" under "Hospital outpatient departments" (kind "facility"). Only if no facility payment is printed, use the Physician Fee Schedule national payment (kind "professional").
Medicare rates change every year, so the payment year matters most: take the figure for the most recent year printed, even from an institutional source, over an older figure from an official one. Each SOURCE has a TRUST line; only when two sources print figures for the same year, use the official one. Use the national (not locality) amount. year = the payment year the figure applies to, or null if the source does not say. If a table's year label disagrees with the source's own stated conversion factor for a year (payment = relative weight x conversion factor), go by the year whose conversion factor reproduces the printed payment.
Then, as a sanity check from your own knowledge of Medicare payment levels: plausible = false if the printed amount is far outside what Medicare pays for this code and rate kind (for example it is a hospital charge, a different code, or a copay rather than the payment). Never replace the printed number with your own.
Return {"medicareRate":{"amount":number|null,"sourceUrl":string|null,"quote":string|null,"kind":"facility"|"professional"|null,"year":number|null,"plausible":boolean}}.

${docsPrompt(docs)}`,
  );
  const m = out?.medicareRate;
  if (m?.plausible === false) return undefined;
  const year = typeof m?.year === "number" ? m.year : undefined;
  if (year !== undefined && year < new Date().getFullYear() - MAX_RATE_AGE_YEARS) return undefined; // stale: an old report, not today's rate
  const v = verifyCited(m, docs, code);
  return v && { ...v, year, kind: m?.kind === "facility" || m?.kind === "professional" ? m.kind : undefined };
}

/** Find the Medicare rate and the hospital's own published prices for one billed code. */
export async function lookupFairPrice(code: string, description: string, hospital?: string): Promise<FairPrice> {
  const sources: Source[] = [];
  const result: FairPrice = { code, description, sources };

  // 1) Medicare, from pages known to print current rates: ACEP's ER rate table (cached), else the official medicare.gov price page.
  let medicare: Awaited<ReturnType<typeof medicareFrom>>;
  for (const knownPage of [acepDoc, medicareGovDoc]) {
    const doc = await knownPage(code);
    if (doc && (medicare = await medicareFrom(code, description, [doc]))) break;
  }

  // 2) Otherwise a Context.dev search restricted to trusted domains. The query is built from the code, not the
  //    hospital's own abbreviations ("HC ED VISIT LEVEL 5"), which pull in the wrong pages.
  if (!medicare) {
    const hits = await search(`CPT HCPCS ${code} Medicare national payment rate ${new Date().getFullYear()} OPPS APC hospital outpatient fee schedule`, { includeDomains: MEDICARE_SOURCE_DOMAINS, highlights: { maxCharacters: 3000 } });
    medicare = await medicareFrom(code, description, trustedDocs(hits, code));
  }

  // 3) Last resort: Context.dev Answers finds the page; we accept it only from a trusted site, scrape it ourselves and extract only from that text.
  if (!medicare) {
    const a = await answer(
      `Find a page on cms.gov, medicare.gov or acep.org that states the Medicare national payment amount for CPT/HCPCS code ${code} (${description}). Return that page URL and the amount as printed.`,
      { source_url: "", amount: 0 },
    );
    const url = typeof a.json.source_url === "string" && /^https?:\/\//.test(a.json.source_url) && isTrusted(a.json.source_url) ? a.json.source_url : undefined;
    if (url) {
      const page = await scrape(url, { highlightsQuery: `Medicare payment amount for code ${code}` });
      const text = (page.highlights?.join("\n…\n") || page.markdown || "").slice(0, MAX_DOC_CHARS);
      if (text && isTrusted(page.url)) medicare = await medicareFrom(code, description, [withTrust({ url: page.url, title: url, text, source: page.source })]);
    }
  }
  if (medicare) {
    result.medicareRate = medicare.amount;
    const label = medicare.kind === "facility" ? "Medicare hospital facility rate" : medicare.kind === "professional" ? "Medicare physician fee" : "Medicare rate";
    sources.push(citeSource(medicare, `${label}${medicare.year ? ` (${medicare.year})` : ""} for ${code}`));
  }

  // 4) Hospital's own price-transparency numbers (cash price / payer-negotiated rates), read only from the hospital's own site.
  const domain = hospital ? await brandByName(hospital).then((b) => b.domain, () => undefined) : undefined;
  if (hospital && domain) {
    const hits = await search(`${hospital} ${code} ${description} standard charges price transparency discounted cash price`, { includeDomains: [domain], highlights: { maxCharacters: 3000 } });
    const docs = trustedDocs(hits, code, domain).filter((d) => isOnDomain(d.url, domain));
    if (docs.length) {
      const out = await llmJson<HospitalExtract>(
        SYSTEM,
        `Hospital: ${hospital}. Code: ${code} (${description}).
From this hospital's OWN published price-transparency data only (not other hospitals, not national averages):
- hospitalCashPrice = its discounted cash / self-pay price for this code
- negotiatedMedian = a median or typical payer-negotiated rate for this code, only if printed as such
Return {"hospitalCashPrice":{"amount":number|null,"sourceUrl":string|null,"quote":string|null},"negotiatedMedian":{...same}}.

${docsPrompt(docs)}`,
      );
      const cash = verifyCited(out?.hospitalCashPrice, docs, code);
      const neg = verifyCited(out?.negotiatedMedian, docs, code);
      if (cash) {
        result.hospitalCashPrice = cash.amount;
        sources.push(citeSource(cash, `${hospital} cash price for ${code}`));
      }
      if (neg) {
        result.negotiatedMedian = neg.amount;
        sources.push(citeSource(neg, `${hospital} negotiated rate for ${code}`));
      }
    }
  }
  return result;
}

/** Forget the cached rate table (tests). */
export function resetRateCache() {
  acepPage = undefined;
}
