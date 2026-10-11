import { llmJson } from "../llm.js";
import type { Bill, LineItem } from "../types.js";

// Bill intake: photographed or text hospital statement -> Bill (vision LLM), then plain-Chinese
// explanations for every line. The LLM only READS; all judgement lives in audit.ts.

const CODE_TYPES = ["CPT", "HCPCS", "REV", "DRG", "NDC", "OTHER"] as const;

const PARSE_SYSTEM = `You transcribe US hospital bills / itemized statements into JSON. Copy what is printed; never invent.
Return ONLY a JSON object with exactly this shape:
{
  "provider": { "name": string, "address"?: string, "website"?: string, "npi"?: string, "ein"?: string, "phone"?: string },
  "patientName"?: string,
  "accountNumber"?: string,
  "serviceDate"?: "YYYY-MM-DD",
  "insurer"?: string,            // primary insurance as printed; omit or "NONE" if self-pay / none on file
  "lineItems": [
    { "code"?: string,           // the CPT/HCPCS code if printed (e.g. "99285", "J2405"), else the revenue code
      "codeType"?: "CPT" | "HCPCS" | "REV" | "DRG" | "NDC" | "OTHER",
      "description": string,     // as printed
      "qty": number,             // units, default 1
      "charge": number,          // USD line TOTAL as a number, no "$" or commas
      "date"?: "YYYY-MM-DD" }
  ],
  "totalCharges": number,
  "insurancePaid"?: number,
  "adjustments"?: number,        // positive number = amount taken off
  "patientBalance": number       // balance due / amount the patient owes
}
Rules: one entry per printed charge line, IN ORDER, keeping repeated lines as separate entries (duplicates matter).
Numbers are JSON numbers. 5-digit numeric codes are CPT; a letter + 4 digits is HCPCS; 4-digit codes starting with 0 are REV.
Do not include subtotal/total rows as line items.`;

/** Coerce "1,234.50" / "$12" / 12 -> number. */
function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const neg = /^\s*\(.*\)\s*$/.test(v) || /^\s*-/.test(v);
    const n = Number(v.replace(/[^0-9.]/g, ""));
    if (v.replace(/[^0-9]/g, "") && Number.isFinite(n)) return neg ? -n : n;
  }
  return undefined;
}
const r2 = (n: number) => Math.round(n * 100) / 100;

function isoDate(v: unknown): string | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  return s;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function inferCodeType(code?: string): LineItem["codeType"] {
  if (!code) return undefined;
  if (/^\d{5}$/.test(code) || /^\d{4}[FTU]$/.test(code)) return "CPT";
  if (/^[A-V]\d{4}$/i.test(code)) return "HCPCS";
  if (/^0\d{3}$/.test(code)) return "REV";
  return "OTHER";
}

/** Validate + normalize whatever the model returned into a strict Bill. Throws loudly if unusable. */
export function normalizeBill(raw: unknown): Bill {
  const o = (raw ?? {}) as Record<string, any>;
  const rawItems: any[] = Array.isArray(o.lineItems) ? o.lineItems : Array.isArray(o.line_items) ? o.line_items : [];
  const lineItems: LineItem[] = [];
  for (const it of rawItems) {
    const description = str(it?.description);
    const charge = num(it?.charge ?? it?.amount ?? it?.total);
    if (!description || charge === undefined) continue;
    const code = str(it?.code)?.toUpperCase();
    const codeType = CODE_TYPES.includes(it?.codeType) ? (it.codeType as LineItem["codeType"]) : inferCodeType(code);
    lineItems.push({
      ...(code ? { code } : {}),
      ...(codeType ? { codeType } : {}),
      description,
      qty: num(it?.qty ?? it?.quantity ?? it?.units) || 1,
      charge: r2(charge),
      ...(isoDate(it?.date) ? { date: isoDate(it?.date) } : {}),
    });
  }
  if (!lineItems.length) throw Object.assign(new Error("Could not read any charge lines from the bill — try a clearer, flatter photo of the itemized statement"), { statusCode: 422 });

  const providerRaw = (o.provider ?? {}) as Record<string, unknown>;
  const provider: Bill["provider"] = { name: str(providerRaw.name) ?? str(o.providerName) ?? "Unknown provider" };
  for (const k of ["address", "website", "npi", "ein", "phone"] as const) {
    const v = str(providerRaw[k]);
    if (v) provider[k] = v;
  }

  const sum = r2(lineItems.reduce((s, li) => s + li.charge, 0));
  const totalCharges = num(o.totalCharges) ?? sum;
  const insurancePaid = num(o.insurancePaid);
  const adjustments = num(o.adjustments);
  const patientBalance = num(o.patientBalance) ?? r2(totalCharges - (insurancePaid ?? 0) - Math.abs(adjustments ?? 0));

  const bill: Bill = { provider, lineItems, totalCharges: r2(totalCharges), patientBalance: r2(patientBalance) };
  const patientName = str(o.patientName);
  const accountNumber = str(o.accountNumber);
  const serviceDate = isoDate(o.serviceDate) ?? lineItems.find((li) => li.date)?.date;
  const insurer = str(o.insurer);
  if (patientName) bill.patientName = patientName;
  if (accountNumber) bill.accountNumber = accountNumber;
  if (serviceDate) bill.serviceDate = serviceDate;
  if (insurer) bill.insurer = insurer;
  if (insurancePaid !== undefined) bill.insurancePaid = r2(Math.abs(insurancePaid));
  if (adjustments !== undefined) bill.adjustments = r2(Math.abs(adjustments));
  return bill;
}

/** Read a bill from statement text and/or a photo (data: URL). Uses the vision LLM. */
export async function parseBill(input: { text?: string; imageDataUrl?: string }): Promise<Bill> {
  const text = input.text?.trim();
  if (!text && !input.imageDataUrl) throw Object.assign(new Error("No bill provided — send a photo (bill file) or billText"), { statusCode: 400 });
  const user = text
    ? `Transcribe this hospital statement into the JSON shape.\n\n----- STATEMENT -----\n${text}\n----- END -----`
    : "Transcribe the hospital statement in this photo into the JSON shape. Read every charge line.";
  const raw = await llmJson<unknown>(PARSE_SYSTEM, user, { image: input.imageDataUrl, temperature: 0 });
  return normalizeBill(raw);
}

const EXPLAIN_SYSTEM = `你是一位温暖、耐心的华人病人权益助手，在为一位只会说普通话、不懂英文、没有医学背景的妈妈解释美国医院账单。
对每一行收费，用一两句简单、亲切的简体中文说明：这是什么检查或治疗、为什么急诊会做它。不要用术语；必要时用括号附上简短的英文名称。
不要评价价格是否合理，也不要说有没有错误（那由别的程序判断）。
只返回 JSON：{"items":[{"index": number, "zh": string}]}，index 与输入的行号一致，每一行都要有。`;

/** Fill descriptionZh on every line (plain, warm Mandarin). Returns a new Bill. */
export async function explainZh(bill: Bill): Promise<Bill> {
  const lines = bill.lineItems.map((li, i) => `${i}. ${li.code ?? ""} ${li.description} (qty ${li.qty})`).join("\n");
  const res = await llmJson<{ items?: { index: number; zh: string }[] }>(EXPLAIN_SYSTEM, `账单来自：${bill.provider.name}\n收费明细：\n${lines}`, { temperature: 0.3 });
  const byIndex = new Map<number, string>();
  for (const it of res.items ?? []) if (typeof it?.index === "number" && typeof it.zh === "string" && it.zh.trim()) byIndex.set(it.index, it.zh.trim());
  const missing = bill.lineItems.map((_, i) => i).filter((i) => !byIndex.has(i));
  if (missing.length === bill.lineItems.length) throw new Error("Chinese explanation failed: the model returned no line explanations");
  return {
    ...bill,
    lineItems: bill.lineItems.map((li, i) => (byIndex.has(i) ? { ...li, descriptionZh: byIndex.get(i) } : li)),
  };
}

/**
 * Deterministic reader for statements in the common fixed-column itemized format
 * ("MM/DD/YYYY  REV  CODE  DESCRIPTION  QTY  CHARGES" + TOTAL/BALANCE rows). Used to cross-check
 * the LLM transcription and by tests; it is not a substitute for the vision path on real photos.
 */
export function parseStatementText(text: string): Bill {
  const lines = text.split(/\r?\n/);
  const items: LineItem[] = [];
  const row = /^\s*(\d{2}\/\d{2}\/\d{4})\s+(\d{4})\s+([A-Z0-9]{5})\s+(.+?)\s+(\d+)\s+\(?(-?[\d,]+\.\d{2})\)?\s*$/;
  const total = (label: RegExp) => {
    const l = lines.find((x) => label.test(x));
    return l ? num(l.match(/(-?[\d,]+\.\d{2})\s*$/)?.[1]) : undefined;
  };
  for (const l of lines) {
    const m = l.match(row);
    if (!m) continue;
    items.push({ code: m[3], codeType: inferCodeType(m[3]), description: m[4].trim(), qty: Number(m[5]), charge: num(m[6])!, date: isoDate(m[1]) });
  }
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  const insuranceLine = lines.find((l) => /Primary Insurance:/i.test(l));
  const raw = {
    provider: { name: nonEmpty[0] ?? "Unknown provider", address: nonEmpty.find((l) => /\b[A-Z]{2}\s+\d{5}\b/.test(l)) },
    patientName: lines.find((l) => /Patient:/i.test(l))?.match(/Patient:\s*(.+?)(\s{2,}|$)/i)?.[1],
    accountNumber: lines.find((l) => /Account No:/i.test(l))?.match(/Account No:\s*(\S+)/i)?.[1],
    insurer: insuranceLine?.replace(/.*Primary Insurance:\s*/i, "").trim(),
    lineItems: items,
    totalCharges: total(/TOTAL CHARGES/i),
    insurancePaid: total(/INSURANCE PAYMENTS/i),
    adjustments: total(/ADJUSTMENTS/i),
    patientBalance: total(/BALANCE DUE/i),
  };
  return normalizeBill(raw);
}
