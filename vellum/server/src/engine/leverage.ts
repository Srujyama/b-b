// PURE: rank a case's negotiating leverage. Lowball's rankCards idea (score each listing by negotiability:
// price drops, days on lot, delta over market median) applied to a medical bill: score each bill line / audit
// flag / policy by how many dollars it can move and how certain that is, so the advocate leads with the
// strongest facts. Reasons are RAW TRUE FACTS only (numbers already on the bill, the audit, or verified
// research), never pre-written persuasion. No I/O, no env.
import type { AuditFlag, CasePacket } from "../types.js";
import { fplPercent } from "../research/charity.js";
import { MEDICARE_BENCHMARK_MULTIPLE } from "../research/facts.js";

export type LeverageKind =
  | "duplicate"
  | "upcoding"
  | "unbundling"
  | "math_error"
  | "no_surprises_act"
  | "markup"
  | "charity"
  | "prompt_pay";

export type LeverageItem = {
  kind: LeverageKind;
  lineIndex?: number;
  code?: string;
  /** Higher = lead with it. amountAtStake x certainty weight. */
  score: number;
  /** Raw, verifiable facts behind the score. */
  reasons: string[];
  /** USD this lever could take off the balance. */
  amountAtStake: number;
  /** true when amountAtStake is an estimate (prompt-pay), not a verified number. */
  estimated?: boolean;
};

/** How sure we are that the dollars actually come off. A proven error is removable regardless of anything else. */
export const CERTAINTY: Record<LeverageKind, number> = {
  duplicate: 1,
  math_error: 1,
  unbundling: 0.95,
  upcoding: 0.8, // depends on documentation the hospital holds
  charity: 0.9, // the hospital's own written policy, given the income the patient reported
  markup: 0.5, // fair-price argument: persuasive, not binding
  no_surprises_act: 0.5,
  prompt_pay: 0.3, // no published number: a typical discount, asked for, never claimed
};

/** Prompt-pay discounts are not published; this is only used to size the ask, and is marked estimated. */
export const PROMPT_PAY_ESTIMATE_PCT = 10;

const ERROR_KINDS: AuditFlag["kind"][] = ["duplicate", "upcoding", "unbundling", "math_error"];
const r2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

export function rankLeverage(packet: Pick<CasePacket, "bill" | "flags" | "fairPrices" | "charity" | "patient">): LeverageItem[] {
  const bill = packet.bill;
  if (!bill) return [];
  const items: LeverageItem[] = [];
  const flags = packet.flags ?? [];
  const lines = bill.lineItems ?? [];
  const balance = bill.patientBalance;
  const removedOnLine = new Map<number, number>(); // dollars already claimed per line by an error flag

  // ---- audit flags: billing errors ----
  for (const f of flags) {
    if (!(ERROR_KINDS as string[]).includes(f.kind) && f.kind !== "no_surprises_act") continue;
    const kind = f.kind as LeverageKind;
    const li = f.lineIndex !== undefined ? lines[f.lineIndex] : undefined;
    const amount = r2(Math.max(0, f.amountAtStake || 0));
    if (f.lineIndex !== undefined && ERROR_KINDS.includes(f.kind)) removedOnLine.set(f.lineIndex, (removedOnLine.get(f.lineIndex) ?? 0) + amount);
    const reasons = [f.evidence ?? f.message];
    if (amount > 0) reasons.push(`${money(amount)} removable`);
    items.push({ kind, ...(f.lineIndex !== undefined ? { lineIndex: f.lineIndex } : {}), ...(li?.code ? { code: li.code } : {}), score: r2(amount * CERTAINTY[kind]), reasons, amountAtStake: amount });
  }

  // ---- markup vs Medicare (only where a verified Medicare rate exists) ----
  lines.forEach((li, i) => {
    const fp = li.code ? packet.fairPrices?.find((p) => p.code.toUpperCase() === li.code!.toUpperCase()) : undefined;
    if (!fp?.medicareRate) return;
    const qty = li.qty > 0 ? li.qty : 1;
    const medicare = fp.medicareRate * qty;
    const remaining = Math.max(0, li.charge - (removedOnLine.get(i) ?? 0)); // don't double count dollars an error already claims
    const amount = r2(Math.max(0, remaining - medicare * MEDICARE_BENCHMARK_MULTIPLE));
    if (amount <= 0) return;
    const reasons = [`billed ${money(li.charge)}; Medicare pays ${money(r2(medicare))} (${(li.charge / medicare).toFixed(1)}x)`];
    if (fp.hospitalCashPrice) reasons.push(`hospital's own published cash price ${money(fp.hospitalCashPrice)} per unit`);
    items.push({ kind: "markup", lineIndex: i, code: li.code, score: r2(amount * CERTAINTY.markup), reasons, amountAtStake: amount });
  });

  // ---- charity care (the hospital's own policy, against the income the patient reported) ----
  const errorsTotal = flags.filter((f) => ERROR_KINDS.includes(f.kind)).reduce((s, f) => s + Math.max(0, f.amountAtStake || 0), 0);
  const afterErrors = Math.max(0, balance - errorsTotal);
  const c = packet.charity;
  const p = packet.patient;
  if (c?.hasFap) {
    const reasons = [`${c.hospital} publishes a financial assistance policy (IRS 501(r))`];
    let amount = 0;
    if (p?.annualIncome !== undefined && p.householdSize) {
      const fpl = fplPercent(p.annualIncome, p.householdSize);
      reasons.push(`household of ${p.householdSize}, income ${money(p.annualIncome)} = ${fpl}% FPL`);
      if (c.freeCareBelowPctFpl && fpl < c.freeCareBelowPctFpl) {
        amount = afterErrors;
        reasons.push(`policy: free care below ${c.freeCareBelowPctFpl}% FPL`);
      } else if (c.discountBelowPctFpl && c.discountPct && fpl < c.discountBelowPctFpl) {
        amount = afterErrors * (c.discountPct / 100);
        reasons.push(`policy: ${c.discountPct}% off below ${c.discountBelowPctFpl}% FPL`);
      } else reasons.push("income is above the policy's thresholds");
    } else reasons.push("household size / income not reported, eligibility unknown");
    amount = r2(amount);
    items.push({ kind: "charity", score: r2(amount * CERTAINTY.charity), reasons, amountAtStake: amount });
  }

  // ---- prompt-pay (an ask, never a claim) ----
  if (afterErrors > 0) {
    const amount = r2(afterErrors * (PROMPT_PAY_ESTIMATE_PCT / 100));
    items.push({
      kind: "prompt_pay",
      score: r2(amount * CERTAINTY.prompt_pay),
      reasons: [`balance after verified errors ${money(r2(afterErrors))}`, `sized at a ${PROMPT_PAY_ESTIMATE_PCT}% discount (estimate, not a published rate)`],
      amountAtStake: amount,
      estimated: true,
    });
  }

  // stable: equal scores keep bill order
  return items.map((it, i) => ({ it, i })).sort((a, b) => b.it.score - a.it.score || a.i - b.i).map(({ it }) => it);
}

/** Which leverage item (if any) a fact sheet line is about. Facts come from research/facts.ts buildNegotiation. */
function itemForFact(fact: string, items: LeverageItem[], flags: AuditFlag[]): LeverageItem | undefined {
  // an audit flag's message is quoted verbatim in its fact
  const flag = flags.find((f) => f.message && fact.includes(f.message));
  if (flag) return items.find((it) => it.kind === flag.kind && it.lineIndex === flag.lineIndex);
  const line = /^Line (\d+) \(([^ )]+)[^)]*\): billed .* Medicare pays/.exec(fact);
  if (line) return items.find((it) => it.kind === "markup" && it.lineIndex === Number(line[1]) - 1);
  const cash = /published (?:discounted cash price|negotiated rate) for ([^ ]+) is/.exec(fact);
  if (cash) return items.find((it) => it.kind === "markup" && it.code === cash[1]);
  if (/501\(r\)|federal poverty|financial assistance|qualifies for (free care|a \d+% discount)/i.test(fact)) return items.find((it) => it.kind === "charity");
  return undefined;
}

/**
 * Reorder the fact sheet so the advocate leads with the strongest leverage. Keeps EVERY fact (only order
 * changes): the account summary stays first, facts tied to a leverage item follow by score (ties keep their
 * original order), and facts not tied to one (totals, benchmarks, labels) keep their relative order at the end.
 */
export function orderFactsByLeverage(packet: Pick<CasePacket, "bill" | "flags" | "fairPrices" | "charity" | "patient" | "facts">): string[] {
  const facts = packet.facts ?? [];
  if (facts.length < 2 || !packet.bill) return [...facts];
  const items = rankLeverage(packet);
  const scored = facts.map((fact, i) => ({ fact, i, item: itemForFact(fact, items, packet.flags ?? []) }));
  const head = scored[0].item === undefined && /billed total charges/.test(scored[0].fact) ? [scored.shift()!] : [];
  const tied = scored.filter((s) => s.item).sort((a, b) => b.item!.score - a.item!.score || a.i - b.i);
  const rest = scored.filter((s) => !s.item);
  return [...head, ...tied, ...rest].map((s) => s.fact);
}
