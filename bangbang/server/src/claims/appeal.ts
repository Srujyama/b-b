// Medical-necessity appeal (clinic mode): payer policy -> criterion-by-criterion check against the chart with
// verbatim quoted evidence -> formal appeal letter. Evidence quotes are verified against the clinical notes, so
// a criterion is only ever "met" if the chart literally says so.
import type { ClaimCase } from "../types.js";
import { llmJson } from "../llm.js";
import { findPayerPolicy, type PayerPolicy, type PolicyProgress } from "./policy.js";

export type CriterionResult = NonNullable<ClaimCase["criteriaMet"]>[number];

/**
 * Optional claim metadata a clinic may send alongside the shared ClaimCase shape (types.ts has no slot for it).
 * It only decorates the letter header; nothing is derived from it.
 */
export type ClaimMeta = {
  claimNumber?: string;
  memberId?: string;
  patientInitials?: string;
  dateOfService?: string;
  denialDate?: string;
  provider?: { name?: string; npi?: string; address?: string; physician?: string; phone?: string };
};

function badRequest(message: string) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

export function validateClaim(claim: unknown): ClaimCase {
  const c = claim as ClaimCase | undefined;
  if (!c || typeof c !== "object") throw badRequest("claim must be an object");
  if (typeof c.payer !== "string" || !c.payer.trim()) throw badRequest("claim.payer is required");
  if (typeof c.denialReason !== "string" || !c.denialReason.trim()) throw badRequest("claim.denialReason is required");
  if (!c.procedure || typeof c.procedure.code !== "string" || typeof c.procedure.description !== "string")
    throw badRequest("claim.procedure {code, description} is required");
  if (!Array.isArray(c.diagnoses)) throw badRequest("claim.diagnoses must be an array of {code, description}");
  if (typeof c.clinicalNotes !== "string" || !c.clinicalNotes.trim()) throw badRequest("claim.clinicalNotes is required");
  return c;
}

// ---------- evidence verification (pure) ----------
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

/** True if every segment of `quote` (split on "..." / "…") is literally in `notes`, ignoring case/whitespace. */
export function quoteInNotes(quote: string, notes: string): boolean {
  const n = norm(notes);
  const segments = quote
    .split(/\.\.\.|…/)
    .map((s) => norm(s).replace(/^["'\s]+|["'\s]+$/g, ""))
    .filter((s) => s.length > 0);
  return segments.length > 0 && segments.every((s) => s.length >= 4 && n.includes(s));
}

type RawEval = { index?: number; criterion?: string; met?: boolean; quote?: string; quotes?: string[] };

/**
 * Map the model's per-criterion verdicts back onto the policy's criteria (by index, else by text), and keep a
 * "met" verdict only if its quoted evidence is verbatim in the chart. Criteria the model skipped are not met.
 */
export function mapCriteria(criteria: string[], raw: RawEval[] | undefined, notes: string): CriterionResult[] {
  const results = Array.isArray(raw) ? raw : [];
  return criteria.map((criterion, i) => {
    const r =
      results.find((x) => Number(x?.index) === i) ??
      results.find((x) => typeof x?.criterion === "string" && norm(x.criterion) === norm(criterion));
    if (!r) return { criterion, met: false, evidence: "Not evaluated — no documentation found in the chart for this criterion." };
    const quotes = (Array.isArray(r.quotes) ? r.quotes : r.quote ? [r.quote] : []).filter((q): q is string => typeof q === "string" && q.trim() !== "");
    const verified = quotes.filter((q) => quoteInNotes(q, notes));
    if (r.met === true && verified.length) return { criterion, met: true, evidence: verified.map((q) => `"${q.trim()}"`).join("; ") };
    if (r.met === true) return { criterion, met: false, evidence: "Model claimed this was met, but its quoted evidence is not in the chart — treated as not documented." };
    return { criterion, met: false, evidence: verified.length ? `Chart says ${verified.map((q) => `"${q.trim()}"`).join("; ")}, which does not satisfy this criterion.` : "No documentation of this criterion in the chart." };
  });
}

export async function evaluateCriteria(criteria: string[], claim: ClaimCase): Promise<CriterionResult[]> {
  if (!criteria.length) return [];
  const out = await llmJson<{ results: RawEval[] }>(
    `You are a utilization-review nurse checking a chart against a health plan's medical-necessity criteria.
For EACH numbered criterion decide whether the CLINICAL NOTES document it. Be strict: met=true only if the notes explicitly document it.
quotes = 1-3 short VERBATIM excerpts copied character-for-character from the notes that prove it (no paraphrase, no ellipses inside a quote).
If a criterion is about an exclusion/contraindication (e.g. "no recent imaging"), met=true only if the notes affirmatively support it. Return JSON only.`,
    `Procedure: CPT ${claim.procedure.code} — ${claim.procedure.description}
Diagnoses: ${claim.diagnoses.map((d) => `${d.code} ${d.description}`).join("; ") || "(none listed)"}

CRITERIA:
${criteria.map((c, i) => `${i}. ${c}`).join("\n")}

CLINICAL NOTES:
${claim.clinicalNotes}

Return {"results":[{"index":number,"met":boolean,"quotes":string[]}]} with one entry per criterion.`,
    { temperature: 0 },
  );
  return mapCriteria(criteria, out?.results, claim.clinicalNotes);
}

// ---------- letter (pure, deterministic: every claim in it comes from the policy or the chart) ----------
export function buildAppealLetter(claim: ClaimCase & ClaimMeta, policy: PayerPolicy, results: CriterionResult[], today = new Date()): string {
  const met = results.filter((r) => r.met);
  const unmet = results.filter((r) => !r.met);
  const p = claim.provider ?? {};
  const date = today.toISOString().slice(0, 10);
  const dx = claim.diagnoses.map((d) => `${d.code} (${d.description})`).join("; ") || "see attached records";
  const ref = [
    claim.claimNumber && `Claim number: ${claim.claimNumber}`,
    claim.memberId && `Member ID: ${claim.memberId}`,
    claim.patientInitials && `Patient: ${claim.patientInitials}`,
    claim.dateOfService && `Date of service: ${claim.dateOfService}`,
    claim.denialDate && `Date of denial: ${claim.denialDate}`,
    `Procedure: CPT ${claim.procedure.code} — ${claim.procedure.description}`,
    `Diagnoses (ICD-10-CM): ${dx}`,
  ].filter(Boolean);

  const lines: string[] = [
    date,
    "",
    `${claim.payer}`,
    "Attn: Appeals / Utilization Review Department",
    "",
    `RE: Request for reconsideration of medical-necessity denial`,
    ...ref.map((r) => `    ${r}`),
    "",
    "To the Appeals Reviewer:",
    "",
    `On behalf of ${p.name ?? "the treating provider's office"}${p.physician ? ` and the treating physician, ${p.physician}` : ""}, we request reconsideration and reversal of the denial of CPT ${claim.procedure.code} (${claim.procedure.description}). The denial states: "${claim.denialReason}"`,
    "",
    `${claim.payer}'s own medical policy, "${policy.title}" (${policy.url}), sets out the criteria for this service. The patient's medical record documents ${met.length === results.length && results.length ? "every one of them" : `${met.length} of ${results.length} of them`}, as follows:`,
    "",
  ];
  met.forEach((r, i) => {
    lines.push(`${i + 1}. Criterion: ${r.criterion}`);
    lines.push(`   MET. Documentation in the medical record: ${r.evidence}`);
    lines.push("");
  });
  if (unmet.length) {
    lines.push("The following criteria are not explicitly documented in the enclosed notes; we ask that the reviewer consider the clinical picture as a whole, and we will supply further records on request:");
    unmet.forEach((r) => lines.push(`   - ${r.criterion}`));
    lines.push("");
  }
  lines.push(
    `Because the documented clinical findings satisfy the criteria of ${claim.payer}'s policy, this service was medically necessary and the denial should be overturned. We request that ${claim.payer} reverse the denial and reprocess the claim for payment.`,
    "",
    `If the reviewer is not prepared to overturn the denial on the written record, we request a peer-to-peer review between the treating physician and the plan's medical director before any final adverse determination, and a copy of the specific criteria and clinical rationale relied on, as required for adverse benefit determinations under 29 CFR 2560.503-1.`,
    "",
    "Enclosures: clinical notes for the date of service; the denial notice.",
    "",
    "Sincerely,",
    "",
    p.physician ?? "Treating physician",
    p.name ?? "",
    ...(p.npi ? [`NPI ${p.npi}`] : []),
    ...(p.address ? [p.address] : []),
    ...(p.phone ? [p.phone] : []),
    "",
    "Prepared with BangBang, an AI claims advocate, for the treating provider's review and signature.",
  );
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** Facts the voice advocate may state on the call with the insurer (English, all sourced). */
export function claimFacts(claim: ClaimCase): string[] {
  const facts: string[] = [`The claim is for CPT ${claim.procedure.code} (${claim.procedure.description}), denied as: "${claim.denialReason}".`];
  if (claim.policy) facts.push(`${claim.payer}'s own medical policy for this service is "${claim.policy.title}" (${claim.policy.url}).`);
  for (const r of claim.criteriaMet ?? []) {
    if (r.met) facts.push(`Policy criterion "${r.criterion}" is met; the chart documents: ${r.evidence}.`);
  }
  const all = claim.criteriaMet ?? [];
  if (all.length) facts.push(`${all.filter((r) => r.met).length} of ${all.length} criteria in the payer's policy are documented in the chart.`);
  if (claim.appealLetter) facts.push("A formal written appeal letter citing the policy criterion by criterion has been prepared.");
  return facts;
}

export type DraftOpts = { onProgress?: PolicyProgress };

/** Policy lookup (if not supplied) -> criteria check -> appeal letter. Signature kept for the x402 route. */
export async function draftAppeal(claim: ClaimCase, opts: DraftOpts = {}): Promise<ClaimCase> {
  const c = validateClaim(claim);
  const log = opts.onProgress ?? (() => {});
  const policy =
    c.policy?.criteria?.length && c.policy.url
      ? c.policy
      : await findPayerPolicy(c.payer, c.procedure.code, c.procedure.description, log);
  log(`Checking ${policy.criteria.length} policy criteria against the clinical notes`);
  const criteriaMet = await evaluateCriteria(policy.criteria, c);
  log(`${criteriaMet.filter((r) => r.met).length} of ${criteriaMet.length} criteria documented in the chart`);
  const appealLetter = buildAppealLetter(c as ClaimCase & ClaimMeta, policy, criteriaMet);
  return { ...c, policy, criteriaMet, appealLetter };
}
