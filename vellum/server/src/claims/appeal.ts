// Medical-necessity appeal (clinic mode): payer policy -> criterion-by-criterion check against the chart with
// verbatim quoted evidence -> formal appeal letter. Evidence quotes are verified against the clinical notes, so
// a criterion is only ever "met" if the chart literally says so.
import type { ClaimCase } from "../types.js";
import { llmJson } from "../llm.js";
import { findPayerPolicy, policyGroups, type CriteriaGroup, type PayerPolicy, type PolicyProgress } from "./policy.js";

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

// ---------- coverage decision (pure) ----------
export type GroupResult = { logic: CriteriaGroup["logic"]; label?: string; satisfied: boolean; met: CriterionResult[]; unmet: CriterionResult[] };
/** Whether the chart satisfies the policy as a whole: every all-of group fully met, every any-of group met at least once. */
export type Coverage = { satisfied: boolean; groups: GroupResult[] };

/**
 * Decide satisfaction from the per-criterion results (already quote-verified by mapCriteria). A criterion with no
 * result counts as not met. A policy with no criteria is never satisfied.
 */
export function evaluateCoverage(policy: Pick<PayerPolicy, "criteria" | "groups">, results: CriterionResult[]): Coverage {
  const byText = new Map(results.map((r) => [r.criterion, r]));
  const groups = policyGroups(policy).map((g): GroupResult => {
    const rs = g.criteria.map((c) => byText.get(c) ?? { criterion: c, met: false, evidence: "Not evaluated." });
    const met = rs.filter((r) => r.met);
    const unmet = rs.filter((r) => !r.met);
    const satisfied = g.logic === "any" ? met.length > 0 : unmet.length === 0;
    return { logic: g.logic, ...(g.label ? { label: g.label } : {}), satisfied, met, unmet };
  });
  return { satisfied: groups.length > 0 && groups.every((g) => g.satisfied), groups };
}

// ---------- letter (pure, deterministic: every claim in it comes from the policy or the chart) ----------
export function buildAppealLetter(claim: ClaimCase & ClaimMeta, policy: PayerPolicy, results: CriterionResult[], today = new Date()): string {
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
  ];
  const cov = evaluateCoverage(policy, results);
  const policyRef = `${claim.payer}'s own medical policy, "${policy.title}" (${policy.url})`;
  let n = 0;
  const listMet = (rs: CriterionResult[], word: "Criterion" | "Indication") =>
    rs.forEach((r) => {
      lines.push(`${++n}. ${word}: ${r.criterion}`);
      lines.push(`   MET. Documentation in the medical record: ${r.evidence}`);
      lines.push("");
    });
  const flat = cov.groups.length === 1 && cov.groups[0].logic === "all";

  if (flat) {
    // A plain list of requirements: every one must be met.
    const g = cov.groups[0];
    const total = g.met.length + g.unmet.length;
    lines.push(`${policyRef}, sets out the criteria for this service. The patient's medical record documents ${g.satisfied ? "every one of them" : `${g.met.length} of the ${total} required criteria`}, as follows:`, "");
    listMet(g.met, "Criterion");
  } else {
    lines.push(`${policyRef}, sets out when this service is covered.${cov.satisfied ? " The patient's medical record satisfies it:" : ""}`, "");
    for (const g of cov.groups) {
      const label = g.label ? ` (${g.label})` : "";
      if (g.logic === "any") {
        if (!g.met.length) continue; // reported below as a gap, without listing the alternatives
        const s = g.met.length > 1 ? "s" : "";
        lines.push(`${claim.payer}'s policy covers this service when any one of the listed indications${label} is present; the record documents the following indication${s}:`, "");
        listMet(g.met, "Indication");
      } else {
        if (!g.met.length) continue;
        lines.push(g.satisfied ? `The policy also requires all of the following${label}, and the record documents each one:` : `The policy also requires all of the following${label}; the record documents these:`, "");
        listMet(g.met, "Criterion");
      }
    }
  }

  // Gaps: only unmet members of all-of groups are real gaps. Unmet alternatives in a satisfied any-of group are not.
  const required = cov.groups.filter((g) => g.logic === "all").flatMap((g) => g.unmet);
  const emptyAny = cov.groups.filter((g) => g.logic === "any" && !g.satisfied);
  if (required.length) {
    lines.push("The following required criteria are not explicitly documented in the enclosed notes:");
    required.forEach((r) => lines.push(`   - ${r.criterion}`));
    lines.push("");
  }
  for (const g of emptyAny)
    lines.push(`The enclosed notes do not explicitly document any one of the ${g.unmet.length} alternative indications in ${claim.payer}'s policy${g.label ? ` (${g.label})` : ""}.`, "");

  if (cov.satisfied) {
    lines.push(
      `Because the documented clinical findings satisfy the criteria of ${claim.payer}'s policy, this service was medically necessary and the denial should be overturned. We request that ${claim.payer} reverse the denial and reprocess the claim for payment.`,
    );
  } else {
    lines.push(
      `We ask that the reviewer consider the clinical picture as a whole, and we will supply further records on request. On the documentation above, we request that ${claim.payer} reconsider the medical necessity of this service, reverse the denial and reprocess the claim for payment.`,
    );
  }
  lines.push(
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
    "Prepared with Vellum, an AI claims advocate, for the treating provider's review and signature.",
  );
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** Facts the voice advocate may state on the call with the insurer (English, all sourced). */
export function claimFacts(claim: ClaimCase): string[] {
  const facts: string[] = [`The claim is for CPT ${claim.procedure.code} (${claim.procedure.description}), denied as: "${claim.denialReason}".`];
  const policy = claim.policy as PayerPolicy | undefined;
  if (policy) facts.push(`${claim.payer}'s own medical policy for this service is "${policy.title}" (${policy.url}).`);
  for (const r of claim.criteriaMet ?? []) {
    if (r.met) facts.push(`Policy criterion "${r.criterion}" is met; the chart documents: ${r.evidence}.`);
  }
  const all = claim.criteriaMet ?? [];
  const cov = policy && all.length ? evaluateCoverage(policy, all) : undefined;
  if (cov && !(cov.groups.length === 1 && cov.groups[0].logic === "all")) {
    // Structured policy: never a raw "x of N" count, which misreads alternatives as missing requirements.
    for (const g of cov.groups) {
      if (g.logic === "any" && g.satisfied)
        facts.push(`${claim.payer}'s policy covers this service when any one of its listed indications is present; the chart documents: ${g.met.map((r) => r.criterion).join("; ")}.`);
      if (g.logic === "all" && g.met.length)
        facts.push(`${g.met.length} of ${g.met.length + g.unmet.length} required criteria${g.label ? ` (${g.label})` : ""} are documented in the chart.`);
    }
    if (cov.satisfied) facts.push(`The chart satisfies ${claim.payer}'s policy for this service.`);
  } else if (all.length) facts.push(`${all.filter((r) => r.met).length} of ${all.length} criteria in the payer's policy are documented in the chart.`);
  if (claim.appealLetter) facts.push("A formal written appeal letter citing the policy criterion by criterion has been prepared.");
  return facts;
}

export type DraftOpts = { onProgress?: PolicyProgress };

/**
 * Policy lookup (if not supplied) -> criteria check -> coverage decision -> appeal letter. Signature kept for the
 * x402 route. `coverage` is an extra, recomputed-every-time property (types.ts has no slot for it).
 */
export async function draftAppeal(claim: ClaimCase, opts: DraftOpts = {}): Promise<ClaimCase & { coverage: Coverage }> {
  const c = validateClaim(claim);
  const log = opts.onProgress ?? (() => {});
  const policy: PayerPolicy =
    c.policy?.criteria?.length && c.policy.url
      ? (c.policy as PayerPolicy)
      : await findPayerPolicy(c.payer, c.procedure.code, c.procedure.description, log);
  log(`Checking ${policy.criteria.length} policy criteria against the clinical notes`);
  const criteriaMet = await evaluateCriteria(policy.criteria, c);
  const coverage = evaluateCoverage(policy, criteriaMet);
  const shape = coverage.groups
    .map((g) => `${g.logic === "any" ? "any one of" : "all of"} ${g.met.length + g.unmet.length}: ${g.met.length} documented`)
    .join("; ");
  log(`Policy ${coverage.satisfied ? "satisfied" : "NOT satisfied"} by the chart (${shape})`);
  const appealLetter = buildAppealLetter(c as ClaimCase & ClaimMeta, policy, criteriaMet);
  return { ...c, policy, criteriaMet, coverage, appealLetter };
}
