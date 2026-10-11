// PURE: turn research into the negotiator's fact sheet and price ladder. No I/O.
// Facts come only from audit flags, verified fair prices and the charity policy — English, true, with numbers.
import type { CasePacket, FairPrice } from "../types.js";
import { fplPercent, FPL_2026_SOURCE } from "./charity.js";

/** Fair-price benchmark = this multiple of Medicare (commercial payers typically pay ~2-3x Medicare). */
export const MEDICARE_BENCHMARK_MULTIPLE = 2.5;
/** Opening ask as a fraction of target when no Medicare anchor exists. */
export const OPENING_FRACTION = 0.6;

// Flags whose dollars are direct billing errors (removable). above_fair_price / charity_eligible are handled by
// the benchmark and charity logic instead, so counting them here would double-count.
const ERROR_KINDS = new Set(["duplicate", "upcoding", "unbundling", "math_error", "no_surprises_act", "other"]);

export type Negotiation = {
  facts: string[];
  target: number;
  opening: number;
  walkaway: number;
  basis: "charity" | "fair_price" | "billing_errors" | "balance";
  fplPct?: number;
};

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const r0 = (n: number) => Math.max(0, Math.round(n));

function priceFor(fps: FairPrice[], code?: string) {
  return code ? fps.find((f) => f.code.toUpperCase() === code.toUpperCase()) : undefined;
}

export function buildNegotiation(packet: Pick<CasePacket, "bill" | "flags" | "fairPrices" | "charity" | "patient">): Negotiation {
  const { bill, patient } = packet;
  if (!bill) throw new Error("buildNegotiation: case has no parsed bill");
  if (!patient || !(patient.maxPay >= 0)) throw new Error("buildNegotiation: case has no patient mandate (patient.maxPay)");
  const flags = packet.flags ?? [];
  const fps = packet.fairPrices ?? [];
  const balance = bill.patientBalance;
  const walkaway = r0(patient.maxPay);
  const facts: string[] = [];
  const hospital = bill.provider.name;

  facts.push(`${hospital} billed total charges of ${usd(bill.totalCharges)}; the patient balance stated on the bill is ${usd(balance)}.`);

  // ---- billing errors ----
  let errorsTotal = 0;
  for (const f of flags) {
    if (f.kind === "charity_eligible" || f.kind === "above_fair_price") continue;
    const where = f.lineIndex !== undefined ? `Line ${f.lineIndex + 1}` : "Bill";
    facts.push(`${where} (${f.kind.replace(/_/g, " ")}): ${f.message}${f.amountAtStake > 0 ? ` — ${usd(f.amountAtStake)} in dispute.` : ""}`);
    if (ERROR_KINDS.has(f.kind)) errorsTotal += Math.max(0, f.amountAtStake);
  }
  const afterErrors = Math.max(0, balance - errorsTotal);
  if (errorsTotal > 0) facts.push(`Removing the flagged billing errors (${usd(errorsTotal)}) leaves ${usd(afterErrors)}.`);

  // ---- fair prices (Medicare / hospital's own published prices) ----
  let benchmarkCharges = 0; // what the billed services are worth at the benchmark, line by line
  let medicareTotal = 0;
  let anyMedicare = false;
  bill.lineItems.forEach((li, i) => {
    const fp = priceFor(fps, li.code);
    const qty = li.qty > 0 ? li.qty : 1;
    if (fp?.medicareRate) {
      anyMedicare = true;
      const m = fp.medicareRate * qty;
      medicareTotal += m;
      benchmarkCharges += Math.min(li.charge, m * MEDICARE_BENCHMARK_MULTIPLE);
      const url = fp.sources.find((s) => /medicare/i.test(s.title))?.url ?? fp.sources[0]?.url;
      facts.push(
        `Line ${i + 1} (${li.code} ${li.description}): billed ${usd(li.charge)}; Medicare pays ${usd(fp.medicareRate)}${qty > 1 ? ` each (x${qty} = ${usd(m)})` : ""}, so the charge is ${(li.charge / m).toFixed(1)}x the Medicare rate${url ? ` (source: ${url})` : ""}.`,
      );
    } else {
      benchmarkCharges += li.charge; // no verified Medicare number: no claim, count the line at full charge
    }
    if (fp?.hospitalCashPrice) {
      const url = fp.sources.find((s) => /cash/i.test(s.title))?.url;
      facts.push(`${hospital}'s own published discounted cash price for ${li.code} is ${usd(fp.hospitalCashPrice)}, versus ${usd(li.charge / qty)} billed per unit${url ? ` (source: ${url})` : ""}.`);
    }
    if (fp?.negotiatedMedian) facts.push(`${hospital}'s published negotiated rate for ${li.code} is ${usd(fp.negotiatedMedian)}.`);
  });
  // translate the line-level benchmark into the patient's share
  const share = bill.totalCharges > 0 ? Math.min(1, balance / bill.totalCharges) : 1;
  const benchmarkBalance = anyMedicare ? Math.min(balance, benchmarkCharges * share) : undefined;
  if (benchmarkBalance !== undefined) {
    facts.push(`At ${MEDICARE_BENCHMARK_MULTIPLE}x Medicare for the priced services, a fair amount for this balance is about ${usd(r0(benchmarkBalance))}.`);
  }

  // ---- charity care (IRS 501(r)) ----
  let charityTarget: number | undefined;
  let fplPct: number | undefined;
  const c = packet.charity;
  if (c?.hasFap) {
    const tiers = [
      c.freeCareBelowPctFpl ? `free care for households below ${c.freeCareBelowPctFpl}% of the federal poverty level` : "",
      c.discountBelowPctFpl ? `discounted care below ${c.discountBelowPctFpl}% FPL${c.discountPct ? ` (${c.discountPct}% off)` : ""}` : "",
    ].filter(Boolean);
    facts.push(`${c.hospital} is required under IRS section 501(r) to publish a financial assistance policy${tiers.length ? `; it offers ${tiers.join(" and ")}` : ""}${c.sources[c.sources.length - 1] ? ` (source: ${c.sources[c.sources.length - 1].url})` : ""}.`);
    if (patient.annualIncome !== undefined && patient.householdSize) {
      fplPct = fplPercent(patient.annualIncome, patient.householdSize);
      facts.push(`The patient's household of ${patient.householdSize} has annual income of ${usd(patient.annualIncome)}, which is ${fplPct}% of the 2026 federal poverty guideline (${FPL_2026_SOURCE.url}).`);
      if (c.freeCareBelowPctFpl && fplPct < c.freeCareBelowPctFpl) {
        charityTarget = 0;
        facts.push(`Under the hospital's own policy the patient qualifies for free care (${fplPct}% < ${c.freeCareBelowPctFpl}% FPL): the balance should be written off in full.`);
      } else if (c.discountBelowPctFpl && c.discountPct && fplPct < c.discountBelowPctFpl) {
        charityTarget = r0(afterErrors * (1 - c.discountPct / 100));
        facts.push(`Under the hospital's own policy the patient qualifies for a ${c.discountPct}% discount (${fplPct}% < ${c.discountBelowPctFpl}% FPL), bringing ${usd(afterErrors)} to ${usd(charityTarget)}.`);
      }
    }
  }

  // ---- ladder ----
  let target: number;
  let basis: Negotiation["basis"];
  if (charityTarget !== undefined) {
    target = charityTarget;
    basis = "charity";
  } else if (benchmarkBalance !== undefined) {
    // Both "balance minus errors" and "benchmark x Medicare" are defensible ceilings; aim for the lower one,
    // but never below 1x Medicare (the hospital can always point to cost).
    target = r0(Math.max(Math.min(afterErrors, benchmarkBalance), medicareTotal * share));
    basis = benchmarkBalance <= afterErrors ? "fair_price" : "billing_errors";
  } else if (errorsTotal > 0) {
    target = r0(afterErrors);
    basis = "billing_errors";
  } else {
    target = r0(balance);
    basis = "balance";
  }
  target = Math.min(target, walkaway, r0(balance));

  let opening: number;
  if (target === 0) opening = 0;
  else if (anyMedicare && medicareTotal * share < target) opening = r0(Math.max(medicareTotal * share, target * 0.4));
  else opening = r0(target * OPENING_FRACTION);
  opening = Math.min(opening, target);

  return { facts, target, opening, walkaway, basis, fplPct };
}
