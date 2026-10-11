// Fair-price lookup: Medicare rate + the hospital's own price-transparency numbers, found with Context.dev
// (search -> highlights -> answers fallback -> scrape) and extracted by the LLM ONLY from scraped text.
// Every number is re-checked against the source text it was cited from; anything unverifiable stays undefined.
import type { FairPrice, Source } from "../types.js";
import { llmJson } from "../llm.js";
import { answer, scrape, search, type SearchHit } from "./contextdev.js";

/** A scraped page reduced to the text the LLM is allowed to read. */
export type Doc = { url: string; title: string; text: string; source: Source };

const MAX_DOC_CHARS = 5000;

export function hitToDoc(h: SearchHit): Doc | undefined {
  const text = (h.highlights?.join("\n…\n") || h.markdown || "").slice(0, MAX_DOC_CHARS);
  return text.trim() ? { url: h.url, title: h.title, text, source: h.source } : undefined;
}

export function docsPrompt(docs: Doc[]): string {
  return docs.map((d, i) => `### SOURCE ${i + 1}\nURL: ${d.url}\nTITLE: ${d.title}\n${d.text}`).join("\n\n");
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

type MedicareExtract = { medicareRate: Cited };
type HospitalExtract = { hospitalCashPrice: Cited; negotiatedMedian: Cited };

async function medicareFrom(code: string, description: string, docs: Doc[]) {
  if (!docs.length) return undefined;
  const out = await llmJson<MedicareExtract>(
    SYSTEM,
    `Code: ${code} (${description}). Find the Medicare payment amount for this exact code (CMS Physician Fee Schedule national payment, or the OPPS/APC national payment rate for hospital outpatient/ER). Prefer the most recent year; prefer the national (not locality) amount.
Return {"medicareRate":{"amount":number|null,"sourceUrl":string|null,"quote":string|null}}.

${docsPrompt(docs)}`,
    { temperature: 0 },
  );
  return verifyCited(out?.medicareRate, docs, code);
}

/** Find the Medicare rate and the hospital's own published prices for one billed code. */
export async function lookupFairPrice(code: string, description: string, hospital?: string): Promise<FairPrice> {
  const sources: Source[] = [];
  const result: FairPrice = { code, description, sources };

  // 1) Medicare: Context.dev web search with query-focused highlights.
  const medicareHits = await search(`CPT ${code} ${description} Medicare national payment amount fee schedule`, { highlights: { maxCharacters: 3000 } });
  const medicareDocs = medicareHits.map(hitToDoc).filter((d): d is Doc => Boolean(d)).slice(0, 6);
  let medicare = await medicareFrom(code, description, medicareDocs);

  // 2) Fallback: Context.dev Answers finds the page; we scrape it ourselves and extract only from that text.
  if (!medicare) {
    const a = await answer(
      `Find a web page (preferably cms.gov or a Medicare fee schedule lookup) that states the Medicare national payment amount for CPT/HCPCS code ${code} (${description}). Return that page URL and the amount as printed.`,
      { source_url: "", amount: 0 },
    );
    const url = typeof a.json.source_url === "string" && /^https?:\/\//.test(a.json.source_url) ? a.json.source_url : undefined;
    if (url) {
      const page = await scrape(url, { highlightsQuery: `Medicare payment amount for code ${code}` });
      const text = (page.highlights?.join("\n…\n") || page.markdown || "").slice(0, MAX_DOC_CHARS);
      if (text) medicare = await medicareFrom(code, description, [{ url: page.url, title: url, text, source: page.source }]);
    }
  }
  if (medicare) {
    result.medicareRate = medicare.amount;
    sources.push(citeSource(medicare, `Medicare rate for ${code}`));
  }

  // 3) Hospital's own price-transparency numbers (cash price / payer-negotiated rates).
  if (hospital) {
    const hits = await search(`"${hospital}" ${code} ${description} standard charges price transparency discounted cash price`, { highlights: { maxCharacters: 3000 } });
    const docs = hits.map(hitToDoc).filter((d): d is Doc => Boolean(d)).slice(0, 6);
    if (docs.length) {
      const out = await llmJson<HospitalExtract>(
        SYSTEM,
        `Hospital: ${hospital}. Code: ${code} (${description}).
From this hospital's OWN published price-transparency data only (not other hospitals, not national averages):
- hospitalCashPrice = its discounted cash / self-pay price for this code
- negotiatedMedian = a median or typical payer-negotiated rate for this code, only if printed as such
Return {"hospitalCashPrice":{"amount":number|null,"sourceUrl":string|null,"quote":string|null},"negotiatedMedian":{...same}}.

${docsPrompt(docs)}`,
        { temperature: 0 },
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
