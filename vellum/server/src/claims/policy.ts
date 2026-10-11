// Payer medical-policy lookup (clinic mode). Finds the payer's real clinical policy bulletin / medical policy for a
// procedure with Context.dev (search -> scrape), then extracts the coverage criteria with the LLM ONLY from the
// scraped text. Every criterion is tied to the URL it was read from; nothing here is hard-coded policy content.
import type { ClaimCase, Source } from "../types.js";
import { llmJson } from "../llm.js";
import { brand, scrape, search, type SearchHit } from "../research/contextdev.js";

/**
 * How a policy combines its criteria. The policy as a whole is satisfied when EVERY group is satisfied; an "all"
 * group needs every member met, an "any" group (alternative indications) needs at least one.
 */
export type CriteriaGroup = { logic: "all" | "any"; label?: string; criteria: string[] };

/**
 * The shared ClaimCase policy shape plus optional structure. `criteria` stays the flat list (every group's members,
 * in order) so existing consumers keep working; `groups` is present only when the policy is more than one all-of list.
 */
export type PayerPolicy = NonNullable<ClaimCase["policy"]> & { groups?: CriteriaGroup[] };
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

type RawGroup = { logic?: unknown; label?: unknown; criteria?: unknown };
type Extracted = {
  applies: boolean;
  title: string | null;
  sourceUrl: string | null;
  groups?: RawGroup[];
  criteria?: string[]; // legacy flat shape: treated as one all-of group
};

/**
 * A connective/heading rather than a requirement, e.g. "Any one of the following indications is met (criteria are
 * alternatives, not all required)". These are never emitted as criteria; `metaLogic` says which logic they imply.
 */
const META_RE =
  /^(?:(?:any|at least|only|exactly)\s+(?:one|1)|one or more|any|all|each|either|both)(?:\s+[\w-]+){0,3}\s+of\s+the\s+(?:following|below|listed|above)\b[^:]*:?$/i;
const ALTERNATIVES_RE = /criteria are alternatives|not all (?:are )?required|alternatives?,? not all|only one (?:needs|is required)/i;

export function metaLogic(text: string): "all" | "any" | null {
  const t = text
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.:;,\s]+$/, "");
  if (ALTERNATIVES_RE.test(text)) return "any";
  if (!META_RE.test(t)) return null;
  return /^(?:any|at least|only|exactly|one or more|either)\b/i.test(t) ? "any" : "all";
}

export function cleanCriteria(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of list) {
    if (typeof c !== "string") continue;
    const t = c.replace(/\s+/g, " ").trim();
    if (t.length < 8 || seen.has(t.toLowerCase()) || metaLogic(t)) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.slice(0, 12);
}

const MAX_TOTAL_CRITERIA = 16;

/**
 * Normalise the model's groups: drop meta-statements (a dropped "any one of the following" turns its group into an
 * any-of group), dedupe across groups, drop empty groups. Accepts the legacy flat `criteria` list as one all-of group.
 */
export function cleanGroups(raw: { groups?: unknown; criteria?: unknown } | null | undefined): CriteriaGroup[] {
  const src: RawGroup[] = Array.isArray(raw?.groups)
    ? (raw.groups as RawGroup[])
    : Array.isArray(raw?.criteria)
      ? [{ logic: "all", criteria: raw.criteria }]
      : [];
  const seen = new Set<string>();
  const out: CriteriaGroup[] = [];
  let total = 0;
  for (const g of src.slice(0, 4)) {
    if (!g || typeof g !== "object") continue;
    const items: unknown[] = Array.isArray(g.criteria) ? g.criteria : [];
    let logic: "all" | "any" = g.logic === "any" ? "any" : "all";
    if (items.some((c) => typeof c === "string" && metaLogic(c) === "any")) logic = "any";
    const label =
      typeof g.label === "string" && g.label.trim() && !metaLogic(g.label) ? g.label.replace(/\s+/g, " ").trim() : undefined;
    const kept = cleanCriteria(items)
      .filter((c) => !seen.has(c.toLowerCase()))
      .slice(0, MAX_TOTAL_CRITERIA - total);
    if (!kept.length) continue;
    kept.forEach((c) => seen.add(c.toLowerCase()));
    total += kept.length;
    // a one-member any-of group is simply a requirement
    out.push({ logic: kept.length === 1 ? "all" : logic, ...(label ? { label } : {}), criteria: kept });
  }
  return out;
}

/** Build the policy object: flat `criteria` always; `groups` only when it carries structure beyond one all-of list. */
export function policyFromGroups(title: string, url: string, groups: CriteriaGroup[]): PayerPolicy {
  const criteria = groups.flatMap((g) => g.criteria);
  return groups.every((g) => g.logic === "all") ? { title, url, criteria } : { title, url, criteria, groups };
}

/**
 * The structure to evaluate a policy against. A supplied `groups` is used only if it partitions `criteria` exactly;
 * otherwise (or with no groups) every criterion is treated as required, which is the conservative reading.
 */
export function policyGroups(policy: Pick<PayerPolicy, "criteria" | "groups">): CriteriaGroup[] {
  const flat = Array.isArray(policy.criteria) ? policy.criteria : [];
  const g = policy.groups;
  if (Array.isArray(g) && g.length) {
    const ok = g.every((x) => x && (x.logic === "all" || x.logic === "any") && Array.isArray(x.criteria) && x.criteria.length);
    const members = ok ? g.flatMap((x) => x.criteria) : [];
    if (ok && members.length === flat.length && new Set(members).size === flat.length && members.every((c) => flat.includes(c)))
      return g.map((x) => ({ logic: x.logic, ...(typeof x.label === "string" && x.label ? { label: x.label } : {}), criteria: [...x.criteria] }));
  }
  return flat.length ? [{ logic: "all", criteria: [...flat] }] : [];
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
for the patient's situation (the indications that apply to the denial), AND how the policy combines them.
Each criterion is one short, self-contained, checkable requirement in plain English, faithful to the source wording
(e.g. "Radiculopathy persisting after at least 6 weeks of conservative therapy"). If one indication carries its own conditions
that must hold together, keep them inside that one criterion.
Put the criteria into groups. logic "any" = alternative indications: the policy says "any of the following", "one of", or lists
indications joined by "or", so meeting ONE is enough. logic "all" = requirements that must EVERY one be met.
The policy is satisfied when every group is satisfied. Use as few groups as the policy's structure needs (often a single "any" group of indications).
NEVER output a connective, heading or instruction as a criterion (e.g. "Any one of the following indications is met",
"All of the following", "criteria are alternatives, not all required"); express that with the group's logic instead.
If no source is the payer's policy for this procedure, set applies=false and groups=[]. sourceUrl = the URL line of the SOURCE used. Return JSON only.`,
    `Payer: ${payer}
Procedure: CPT ${procedureCode} — ${description}
Return {"applies":boolean,"title":string|null (the policy's own title as printed),"sourceUrl":string|null,
"groups":[{"logic":"any"|"all","label":string|null (short, e.g. "Indications for lumbar MRI"),"criteria":string[]}] (3-12 criteria in total)}

${docs.map((d, i) => `### SOURCE ${i + 1}\nURL: ${d.url}\nTITLE: ${d.title}\n${d.text}`).join("\n\n")}`,
    { temperature: 0 },
  );

  const groups = cleanGroups(out);
  if (!out?.applies || !groups.length) {
    throw Object.assign(new Error(`Context.dev found pages for ${payer}, but none was a medical policy for ${procedureCode} with readable criteria (${docs.map((d) => d.url).join(", ")})`), {
      statusCode: 404,
    });
  }
  // The cited URL must be one we actually read; otherwise cite the first document.
  const doc = docs.find((d) => d.url === out.sourceUrl) ?? docs[0];
  const title = (typeof out.title === "string" && out.title.trim()) || doc.title;
  const policy = policyFromGroups(title, doc.url, groups);
  const shape = groups.map((g) => `${g.logic === "any" ? "any one of" : "all of"} ${g.criteria.length}`).join(" AND ");
  onProgress(`Extracted ${policy.criteria.length} criteria (${shape}) from "${title}" (${doc.url})`);
  return policy;
}
