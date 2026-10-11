// Payer medical-policy lookup (clinic mode). Finds the payer's real clinical policy bulletin / medical policy for a
// procedure with Context.dev (search -> scrape), then extracts the coverage criteria with the LLM ONLY from the
// scraped text. Every criterion is tied to the URL it was read from; nothing here is hard-coded policy content.
import type { ClaimCase, Source } from "../types.js";
import { llmJson } from "../llm.js";
import { brand, scrape, search, type SearchHit } from "../research/contextdev.js";

export type PayerPolicy = NonNullable<ClaimCase["policy"]>;
export type PolicyProgress = (message: string) => void;

/**
 * Where big payers publish medical policy. This is only a search hint (it narrows Context.dev's search to the
 * payer's own sites, plus the imaging benefit managers they delegate to); the policy itself is always fetched live.
 */
export const PAYER_DOMAINS: { match: RegExp; domains: string[] }[] = [
  { match: /aetna/i, domains: ["aetna.com"] },
  { match: /united\s*health|uhc|optum/i, domains: ["uhcprovider.com", "uhc.com"] },
  { match: /cigna|evernorth/i, domains: ["cigna.com", "evicore.com"] },
  { match: /anthem|elevance|wellpoint/i, domains: ["anthem.com", "carelonmedicalbenefitsmanagement.com"] },
  { match: /humana/i, domains: ["humana.com"] },
  { match: /kaiser/i, domains: ["kaiserpermanente.org"] },
  { match: /blue\s*shield\s*of\s*california/i, domains: ["blueshieldca.com"] },
  { match: /centene|ambetter|wellcare/i, domains: ["centene.com", "ambetterhealth.com"] },
  { match: /molina/i, domains: ["molinahealthcare.com"] },
];

export function payerDomains(payer: string): string[] {
  return PAYER_DOMAINS.find((p) => p.match.test(payer))?.domains ?? [];
}

const POLICY_RE = /polic|bulletin|cpb|guideline|criteria|coverage|medical[-_ ]?necess/i;

/** Rank search hits: policy-looking URLs/titles on the payer's domains first, then anything mentioning the code. */
export function rankPolicyHits(hits: SearchHit[], domains: string[], procedureCode: string): SearchHit[] {
  const score = (h: SearchHit) => {
    let s = 0;
    if (domains.some((d) => h.url.includes(d))) s += 4;
    if (POLICY_RE.test(h.url)) s += 2;
    if (POLICY_RE.test(h.title)) s += 2;
    const hay = `${h.title} ${h.description} ${(h.highlights ?? []).join(" ")} ${h.markdown ?? ""}`;
    if (procedureCode && hay.includes(procedureCode)) s += 1;
    return s;
  };
  return [...hits].map((h, i) => ({ h, i, s: score(h) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.h);
}

type PolicyDoc = { url: string; title: string; text: string; source: Source };

const MAX_DOC_CHARS = 9000;

function criteriaQuery(procedureCode: string, description: string) {
  return `medical necessity criteria for ${description} (CPT ${procedureCode}): indications considered medically necessary, required duration of conservative therapy, neurological signs, red flags, documentation required`;
}

type Extracted = {
  applies: boolean;
  title: string | null;
  sourceUrl: string | null;
  criteria: string[];
};

export function cleanCriteria(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of list) {
    if (typeof c !== "string") continue;
    const t = c.replace(/\s+/g, " ").trim();
    if (t.length < 8 || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.slice(0, 12);
}

/**
 * Locate the payer's medical policy for a procedure and extract its coverage criteria.
 * Throws (loudly) if Context.dev / OpenAI are not configured or no policy can be found — never returns invented criteria.
 */
export async function findPayerPolicy(
  payer: string,
  procedureCode: string,
  description: string,
  onProgress: PolicyProgress = () => {},
): Promise<PayerPolicy> {
  if (!payer?.trim()) throw Object.assign(new Error("claim.payer is required to look up a medical policy"), { statusCode: 400 });

  let domains = payerDomains(payer);
  if (!domains.length) {
    try {
      const b = await brand({ name: payer });
      domains = [b.domain];
      onProgress(`Resolved ${payer} -> ${b.domain} (Context.dev brand)`);
    } catch (e) {
      onProgress(`Brand lookup failed for ${payer}: ${(e as Error).message}; searching the open web`);
    }
  }

  const query = `${payer} medical policy ${description} ${procedureCode} medical necessity criteria`;
  let hits: SearchHit[] = [];
  if (domains.length) hits = await search(query, { includeDomains: domains, highlights: { maxCharacters: 4000 } });
  if (!hits.length) hits = await search(query, { highlights: { maxCharacters: 4000 } });
  const ranked = rankPolicyHits(hits, domains, procedureCode).slice(0, 3);
  if (!ranked.length) throw Object.assign(new Error(`No medical policy found for ${payer} ${procedureCode} via Context.dev search`), { statusCode: 404 });
  onProgress(`Found ${ranked.length} candidate policy page(s) for ${payer}: ${ranked.map((h) => h.url).join(", ")}`);

  // Read the top candidates: targeted highlights of the criteria section; fall back to the search hit's own text.
  const docs: PolicyDoc[] = [];
  for (const h of ranked.slice(0, 2)) {
    let text = "";
    let url = h.url;
    let source = h.source;
    try {
      const page = await scrape(h.url, { highlightsQuery: criteriaQuery(procedureCode, description), maxCharacters: MAX_DOC_CHARS });
      text = page.highlights?.join("\n…\n") || page.markdown || "";
      url = page.url || h.url;
      source = page.source;
      if (page.errors.length) onProgress(`Scrape of ${h.url} partially failed: ${page.errors.join("; ")}`);
    } catch (e) {
      onProgress(`Could not scrape ${h.url}: ${(e as Error).message}`);
    }
    if (!text.trim()) text = (h.highlights?.join("\n…\n") || h.markdown || h.description || "");
    if (text.trim()) docs.push({ url, title: h.title || url, text: text.slice(0, MAX_DOC_CHARS), source });
  }
  if (!docs.length) throw Object.assign(new Error(`Found ${payer} policy pages but could not read any of them`), { statusCode: 502 });

  const out = await llmJson<Extracted>(
    `You read US health-plan medical policies (clinical policy bulletins, medical policies, imaging guidelines).
Use ONLY text printed in the SOURCES. Extract the coverage criteria that decide whether the named procedure is medically necessary
for the patient's situation (the indications that apply to the denial). Each criterion is one short, self-contained, checkable
requirement in plain English, faithful to the source wording (e.g. "At least 6 weeks of failed conservative therapy").
If no source is the payer's policy for this procedure, set applies=false and criteria=[]. sourceUrl = the URL line of the SOURCE used. Return JSON only.`,
    `Payer: ${payer}
Procedure: CPT ${procedureCode} — ${description}
Return {"applies":boolean,"title":string|null (the policy's own title as printed),"sourceUrl":string|null,"criteria":string[] (3-10 items)}

${docs.map((d, i) => `### SOURCE ${i + 1}\nURL: ${d.url}\nTITLE: ${d.title}\n${d.text}`).join("\n\n")}`,
    { temperature: 0 },
  );

  const criteria = cleanCriteria(out?.criteria);
  if (!out?.applies || !criteria.length) {
    throw Object.assign(new Error(`Context.dev found pages for ${payer}, but none was a medical policy for ${procedureCode} with readable criteria (${docs.map((d) => d.url).join(", ")})`), {
      statusCode: 404,
    });
  }
  // The cited URL must be one we actually read; otherwise cite the first document.
  const doc = docs.find((d) => d.url === out.sourceUrl) ?? docs[0];
  const title = (typeof out.title === "string" && out.title.trim()) || doc.title;
  onProgress(`Extracted ${criteria.length} criteria from "${title}" (${doc.url})`);
  return { title, url: doc.url, criteria };
}
