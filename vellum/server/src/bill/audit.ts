import type { AuditFlag, Bill, LineItem } from "../types.js";

// PURE, deterministic bill audit. No network, no LLM: the same bill always yields the same flags,
// so the negotiator can cite them and tests can pin exact dollar amounts.

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const r2 = (n: number) => Math.round(n * 100) / 100;
const norm = (code?: string) => (code ?? "").trim().toUpperCase();

/**
 * Lab panels and the component tests they already include (AMA CPT panel definitions).
 * Billing a component separately on the same day as its panel is unbundling (NCCI).
 */
export const LAB_PANELS: Record<string, { name: string; components: string[] }> = {
  "80053": {
    name: "comprehensive metabolic panel",
    components: ["82040", "82247", "82310", "82374", "82435", "82565", "82947", "84075", "84132", "84155", "84295", "84450", "84460", "84520"],
  },
  "80048": {
    name: "basic metabolic panel",
    components: ["82310", "82374", "82435", "82565", "82947", "84132", "84295", "84520"],
  },
  "80051": { name: "electrolyte panel", components: ["82374", "82435", "84132", "84295"] },
  "80061": { name: "lipid panel", components: ["82465", "83718", "84478"] },
  "80076": { name: "hepatic function panel", components: ["82040", "82247", "82248", "84075", "84155", "84450", "84460"] },
  "85025": { name: "complete blood count with automated differential", components: ["85027", "85004", "85048", "85041", "85014", "85018"] },
};

/** Codes that are reportable at most once per encounter (initial-service codes). */
const ONCE_PER_ENCOUNTER = new Set(["96374", "96360", "96365", "99281", "99282", "99283", "99284", "99285"]);

const CRITICAL_CARE = new Set(["99291", "99292"]);
const ED_EM = new Set(["99281", "99282", "99283", "99284", "99285"]);

/**
 * Level-4 / level-5 ED visit ratio used to size a possible 99285 upcode.
 * Medicare OPPS pays APC 5024 (level 4) at roughly 70% of APC 5025 (level 5); applying that ratio to
 * the hospital's own level-5 charge estimates what a level-4 line would have cost.
 */
export const ED_LEVEL4_OVER_LEVEL5 = 0.7;

function sameDay(a: LineItem, b: LineItem) {
  return !a.date || !b.date || a.date === b.date;
}

export function auditBill(bill: Bill): AuditFlag[] {
  const flags: AuditFlag[] = [];
  const items = bill.lineItems ?? [];
  const codes = new Set(items.map((li) => norm(li.code)).filter(Boolean));
  const counted = new Set<number>(); // lines already fully claimed by a flag (avoid double-counting dollars)

  // 1) Duplicates: same code + date + charge (+ qty) more than once.
  const seen = new Map<string, number>();
  items.forEach((li, i) => {
    const code = norm(li.code);
    if (!code) return;
    const key = `${code}|${li.date ?? ""}|${r2(li.charge)}|${li.qty}`;
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, i);
      return;
    }
    counted.add(i);
    const once = ONCE_PER_ENCOUNTER.has(code);
    flags.push({
      kind: "duplicate",
      lineIndex: i,
      message:
        `Line ${i + 1} (${code} ${li.description}, ${money(li.charge)}) is an exact duplicate of line ${first + 1}: same code, date and charge.` +
        (once ? ` ${code} is an initial-service code reportable only once per encounter.` : "") +
        ` Remove the duplicate charge of ${money(li.charge)}.`,
      messageZh: `第 ${i + 1} 项（${code}）和第 ${first + 1} 项完全一样：同一天、同一个项目、同样的价钱，被收了两次。这 ${money(li.charge)} 应该删掉。`,
      amountAtStake: r2(li.charge),
      evidence: `lines ${first + 1} and ${i + 1}: ${code} ${li.date ?? ""} ${money(li.charge)}`.trim(),
    });
  });

  // 2) Possible upcode: ED level 5 with no critical care billed.
  const hasCritical = [...codes].some((c) => CRITICAL_CARE.has(c));
  items.forEach((li, i) => {
    if (norm(li.code) !== "99285" || hasCritical || counted.has(i)) return;
    const stake = r2(li.charge * (1 - ED_LEVEL4_OVER_LEVEL5));
    flags.push({
      kind: "upcoding",
      lineIndex: i,
      message:
        `Line ${i + 1} bills the highest ED level (99285, ${money(li.charge)}) but no critical care (99291/99292) was billed and the patient was treated and discharged. ` +
        `Level 5 requires high-complexity decision making; this visit supports at most level 4 (99284), roughly ${money(li.charge - stake)}. Request the ED triage and physician documentation that justifies level 5.`,
      messageZh: `第 ${i + 1} 项按急诊“最高级别（第5级）”收费，但您没有接受重症抢救，当天就回家了。这种情况通常只算第4级，大约可以少付 ${money(stake)}。我们会要求医院拿出病历证明。`,
      amountAtStake: stake,
      evidence: `99285 billed; no 99291/99292 on the bill; level-4 ≈ ${Math.round(ED_LEVEL4_OVER_LEVEL5 * 100)}% of level-5 (OPPS APC 5024 vs 5025)`,
    });
  });

  // 3) Unbundling: panel components billed separately on the same day as the panel.
  items.forEach((panel, pi) => {
    const def = LAB_PANELS[norm(panel.code)];
    if (!def || counted.has(pi)) return;
    const parts: { li: LineItem; i: number }[] = [];
    items.forEach((li, i) => {
      if (i !== pi && !counted.has(i) && def.components.includes(norm(li.code)) && sameDay(panel, li)) parts.push({ li, i });
    });
    if (!parts.length) return;
    parts.forEach(({ i }) => counted.add(i));
    const stake = r2(parts.reduce((s, p) => s + p.li.charge, 0));
    const list = parts.map((p) => `${norm(p.li.code)} (line ${p.i + 1}, ${money(p.li.charge)})`).join(", ");
    flags.push({
      kind: "unbundling",
      lineIndex: parts[0].i,
      message:
        `${list} ${parts.length > 1 ? "are" : "is"} already included in the ${def.name} ${norm(panel.code)} (line ${pi + 1}) billed the same day. ` +
        `Billing panel components separately is unbundling under NCCI edits; remove ${money(stake)}.`,
      messageZh: `第 ${parts.map((p) => p.i + 1).join("、")} 项化验，其实已经包含在第 ${pi + 1} 项的“套餐化验”里了，医院又单独收了一次钱。这 ${money(stake)} 应该删掉。`,
      amountAtStake: stake,
      evidence: `panel ${norm(panel.code)} includes ${parts.map((p) => norm(p.li.code)).join(", ")}`,
    });
  });

  // 4) Math: line items vs stated total, and total vs stated balance.
  const lineSum = r2(items.reduce((s, li) => s + (li.charge || 0), 0));
  if (items.length && Math.abs(lineSum - bill.totalCharges) > 1) {
    const over = r2(bill.totalCharges - lineSum);
    flags.push({
      kind: "math_error",
      message: `Line items add up to ${money(lineSum)} but the statement's total charges are ${money(bill.totalCharges)} (difference ${money(Math.abs(over))}).`,
      messageZh: `账单上每一项加起来是 ${money(lineSum)}，可是总数写的是 ${money(bill.totalCharges)}，对不上。`,
      amountAtStake: Math.max(0, over),
      evidence: `sum(lineItems)=${lineSum}; totalCharges=${bill.totalCharges}`,
    });
  }
  const expectedBalance = r2(bill.totalCharges - (bill.insurancePaid ?? 0) - (bill.adjustments ?? 0));
  if (Math.abs(expectedBalance - bill.patientBalance) > 1) {
    const over = r2(bill.patientBalance - expectedBalance);
    flags.push({
      kind: "math_error",
      message: `Total charges ${money(bill.totalCharges)} minus insurance ${money(bill.insurancePaid ?? 0)} and adjustments ${money(bill.adjustments ?? 0)} is ${money(expectedBalance)}, but the balance due is ${money(bill.patientBalance)}.`,
      messageZh: `总费用减去保险和减免以后应该是 ${money(expectedBalance)}，但账单要您付 ${money(bill.patientBalance)}，数字算错了。`,
      amountAtStake: Math.max(0, over),
      evidence: `expected balance ${expectedBalance}; stated ${bill.patientBalance}`,
    });
  }

  // 5) No Surprises Act context (informational, $0 stake on its own).
  const isEmergency = [...codes].some((c) => ED_EM.has(c)) || items.some((li) => norm(li.code) === "0450");
  const insured = Boolean(bill.insurer && !/^(none|self[- ]?pay|n\/a)/i.test(bill.insurer.trim()));
  if (isEmergency && insured && bill.patientBalance > 0) {
    flags.push({
      kind: "no_surprises_act",
      message:
        `Emergency services (ED E/M codes) are protected by the No Surprises Act (42 U.S.C. 300gg-111): the patient owes no more than in-network cost-sharing even if the hospital or a physician was out of network. Any balance above in-network cost-sharing is not owed.`,
      messageZh: `急诊受联邦《无意外账单法》保护：就算医院或医生不在您保险的网络内，您也只需要付网络内的自付部分，多收的部分可以不付。`,
      amountAtStake: 0,
      evidence: `emergency codes present; insurer: ${bill.insurer}`,
    });
  } else if (isEmergency && !insured) {
    flags.push({
      kind: "no_surprises_act",
      message:
        `Self-pay emergency visit: No Surprises Act balance-billing limits apply to insured patients, so the uninsured protections that matter here are the hospital's 501(r) financial assistance policy, the 501(r) limit on charging FAP-eligible patients more than amounts generally billed (AGB) to insurers, and state fair-pricing law. Request the itemized bill, the FAP application and the AGB rate.`,
      messageZh: `您没有保险，所以《无意外账单法》的这部分保护不适用；但非营利医院必须提供经济援助，而且对符合条件的病人不能收得比保险公司还高。我们会帮您申请。`,
      amountAtStake: 0,
      evidence: `emergency codes present; no insurer on file`,
    });
  }

  return flags;
}

/** Total dollars the flags could remove (non-overlapping by construction). */
export function totalAtStake(flags: AuditFlag[]): number {
  return r2(flags.reduce((s, f) => s + (f.amountAtStake || 0), 0));
}
