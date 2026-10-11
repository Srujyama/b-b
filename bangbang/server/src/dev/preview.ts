// UI DESIGN HARNESS — not part of the product, and OFF unless DEV_PREVIEW=1.
//
// Lets us design the later screens (bill explanation, research feed, negotiation room, receipts) without
// API keys. It seeds one case into the real store and then replays events over the real /ws, so the real
// web UI renders it via its normal `#case=<id>` resume path.
//
// What is real: the bill is parsed from the seed statement by the deterministic statement reader, the
// audit flags come from auditBill, and the FPL math and negotiation ladder from buildNegotiation.
// What is PREVIEW-ONLY and labeled as such: the Chinese line explanations (normally the LLM), the
// research sources (normally Context.dev), the conversation (normally ElevenLabs), and the receipts
// (normally chain transactions; their hashes say PREVIEW and their links go nowhere real).
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { auditBill } from "../bill/audit.js";
import { parseStatementText } from "../bill/parse.js";
import { fplPercent } from "../research/charity.js";
import { buildNegotiation } from "../research/facts.js";
import { addReceipt, createCase, emit, updateCase } from "../store.js";
import type { CasePacket, CharityPolicy, FairPrice, Offer, Patient, Receipt, TranscriptLine } from "../types.js";

export const STAGES = ["bill", "research", "room", "receipts"] as const;
export type Stage = (typeof STAGES)[number];

const FIXTURE = fileURLToPath(new URL("../../fixtures/lin-er-bill.json", import.meta.url));
const PREVIEW = "PREVIEW (dev harness, not live data)";

// Plain-Mandarin explanations a parent would understand (normally written by the LLM in explainZh).
const ZH: Record<string, string> = {
  "99285": "急诊看诊费（最高的第5级，最复杂的情况）",
  "74177": "肚子和骨盆的CT扫描（打了显影剂）",
  Q9967: "CT用的显影剂",
  "80053": "全套血液化验（包括肾功能、血糖等14项）",
  "82565": "肌酐化验（看肾功能）——已经包含在全套化验里",
  "84520": "尿素氮化验（看肾功能）——已经包含在全套化验里",
  "82947": "血糖化验——已经包含在全套化验里",
  "85025": "血常规（数红细胞、白细胞）",
  "83690": "脂肪酶化验（看胰腺）",
  "81003": "尿检",
  "36415": "抽血的手续费",
  "96374": "静脉打针（第一针）",
  J7030: "生理盐水点滴 1000毫升",
  J2405: "止吐药（昂丹司琼）",
  J1885: "止痛药（酮咯酸）",
  J2270: "止痛药（吗啡）",
};

function previewFairPrices(): FairPrice[] {
  const src = (title: string) => [{ title: `${title} (${PREVIEW})`, url: "https://example.org/preview", via: "other" as const }];
  return [
    { code: "74177", description: "CT abdomen & pelvis w/ contrast", medicareRate: 391.12, billed: 6245, sources: src("CMS OPPS rate") },
    { code: "99285", description: "ED visit level 5", medicareRate: 506.11, billed: 3412, sources: src("CMS OPPS rate") },
    { code: "80053", description: "Comprehensive metabolic panel", medicareRate: 10.56, billed: 612, sources: src("CMS clinical lab fee schedule") },
  ];
}

function previewCharity(): CharityPolicy {
  return {
    hospital: "Stanford Health Care",
    hasFap: true,
    freeCareBelowPctFpl: 400,
    summary: `${PREVIEW}: Financial assistance policy offers free care to uninsured patients under 400% of the federal poverty level.`,
    sources: [{ title: `Financial Assistance Policy (${PREVIEW})`, url: "https://example.org/preview", via: "other" }],
  };
}

// A plausible arc: the rep resists, concedes the duplicate, then charity care. Times are filled at replay.
const SCRIPT: { role: "hospital" | "advocate"; text: string; zh: string; offer?: number }[] = [
  { role: "hospital", text: "Stanford Patient Financial Services, this is Dana. How can I help?", zh: "斯坦福病人财务服务部，我是Dana。有什么可以帮您？" },
  { role: "advocate", text: "Hi Dana. I'm an AI advocate calling on behalf of Mei Lin, account ending 0-7, with her written consent. I'm calling about her ER visit on August fourteenth.", zh: "您好Dana。我是AI代理，经林美书面授权，代表她打来，关于她8月14日的急诊账单。" },
  { role: "hospital", text: "I see a balance of fourteen thousand two hundred ninety-six dollars. Would she like to set up payments?", zh: "我看到余额是14,296美元。她想办分期付款吗？", offer: 14296 },
  { role: "advocate", text: "Before that: the initial IV push, 96374, is billed twice for the same encounter. That's eight hundred forty-two dollars that shouldn't be there.", zh: "在那之前：第一针静脉注射（96374）同一次就诊被收了两次，多收了842美元。" },
  { role: "hospital", text: "You're right, I can remove the duplicate. That brings it to thirteen thousand four hundred fifty-four.", zh: "您说得对，我可以删掉重复的。这样余额是13,454美元。", offer: 13454 },
  { role: "advocate", text: "Thank you. Also, Mrs. Lin is uninsured and her household income is about 150% of the poverty line. Your financial assistance policy covers care in full under 400%.", zh: "谢谢。另外，林太太没有保险，家庭收入大约是贫困线的150%。贵院的财务援助政策规定400%以下可以全免。" },
  { role: "hospital", text: "If she qualifies, the most I can do today is apply the self-pay discount: forty percent off, so eight thousand seventy-two.", zh: "如果她符合条件……我今天最多能给自付折扣，打六折，8,072美元。", offer: 8072 },
  { role: "advocate", text: "She qualifies for free care under your own policy. She can pay five hundred dollars today as a good-faith settlement and submit the application.", zh: "按贵院自己的政策她可以全免。她今天可以先付500美元表示诚意，并提交申请。" },
  { role: "hospital", text: "Let me check with my supervisor... Okay. We can settle at six hundred dollars, paid in full, zero balance.", zh: "我问一下主管……好的。我们可以600美元结清，余额清零。", offer: 600 },
  { role: "advocate", text: "Agreed: six hundred dollars, paid in full, zero balance. Please send the zero-balance confirmation. Thank you, Dana.", zh: "同意：600美元全部结清，余额清零。请发确认书给我们。谢谢您，Dana。" },
];

const fakeHash = (n: number) => `PREVIEW${String(n).padStart(4, "0")}${"0".repeat(53)}`;
const RECEIPTS: Omit<Receipt, "at">[] = [
  { chain: "bsc", kind: "openMandate", txHash: fakeHash(1), explorerUrl: "#preview", detail: { maxAmountUsd: 2500, note: PREVIEW } },
  { chain: "xrpl", kind: "CredentialCreate", txHash: fakeHash(2), explorerUrl: "#preview", detail: { credential: "FinancialHardship", note: PREVIEW } },
  { chain: "base", kind: "x402-payment", txHash: fakeHash(3), explorerUrl: "#preview", detail: { amount: "0.05 AUSD", for: "fair-price 74177", note: PREVIEW } },
  { chain: "gemini", kind: "fed-odds", txHash: fakeHash(4), explorerUrl: "#preview", detail: { market: "FED261030", note: PREVIEW } },
  { chain: "xrpl", kind: "EscrowCreate", txHash: fakeHash(5), explorerUrl: "#preview", detail: { amount: "600 USD", note: PREVIEW } },
  { chain: "bsc", kind: "recordDeal", txHash: fakeHash(6), explorerUrl: "#preview", detail: { amountUsd: 600, note: PREVIEW } },
  { chain: "xrpl", kind: "Batch", txHash: fakeHash(7), explorerUrl: "#preview", detail: { inner: ["EscrowFinish", "Payment (advocate fee)"], note: PREVIEW } },
];

/** Build the case up to `stage` and replay that stage's live events, `stepMs` apart. */
export async function seedPreview(stage: Stage, stepMs = 900): Promise<CasePacket> {
  const fx = JSON.parse(await readFile(FIXTURE, "utf8")) as { patient: Patient; statementLines: string[] };
  const bill = parseStatementText(fx.statementLines.join("\n"));
  bill.lineItems = bill.lineItems.map((li) => ({ ...li, descriptionZh: ZH[li.code ?? ""] ?? li.descriptionZh }));
  const flags = auditBill(bill);
  const patient = fx.patient;
  const c = createCase({ mode: "patient", status: "audited", patient, bill, flags });

  const later: (() => void)[] = [];
  const log = (message: string, messageZh: string) => later.push(() => emit(c.id, { type: "log", message, messageZh }));

  if (stage !== "bill") {
    const fairPrices = previewFairPrices();
    const charity = previewCharity();
    const ladder = buildNegotiation({ bill, flags, fairPrices, charity, patient });
    updateCase(c.id, { fairPrices, charity, facts: ladder.facts, target: ladder.target, opening: ladder.opening, walkaway: ladder.walkaway, status: "researched" });
    const fpl = fplPercent(patient.annualIncome ?? 0, patient.householdSize ?? 1);
    log(`[${PREVIEW}] Found Stanford Health Care's financial assistance policy`, `【预览】找到了斯坦福医院的财务援助政策`);
    log(`[${PREVIEW}] Medicare pays $391 for the CT you were billed $6,245 for`, `【预览】同样的CT，联邦医保只付391美元，您被收了6,245美元`);
    log(`[${PREVIEW}] Household income is ${Math.round(fpl)}% of the poverty line`, `【预览】您家收入是贫困线的${Math.round(fpl)}%`);
  }

  if (stage === "room" || stage === "receipts") {
    updateCase(c.id, { status: "negotiating" });
    const transcript: TranscriptLine[] = [];
    const offers: Offer[] = [];
    for (const s of SCRIPT) {
      const step = () => {
        const at = new Date().toISOString();
        const line: TranscriptLine = { role: s.role, text: s.text, textZh: s.zh, at };
        transcript.push(line);
        emit(c.id, { type: "transcript", line });
        if (s.offer !== undefined) {
          const offer: Offer = { by: "hospital", amount: s.offer, at };
          offers.push(offer);
          emit(c.id, { type: "offer", offer });
        }
      };
      if (stage === "room") later.push(step);
      else step();
    }
    const deal = () => {
      // stage=room stays "negotiating" so a resumed page lands on the room screen, not receipts
      updateCase(c.id, { agreedAmount: 600, status: stage === "room" ? "negotiating" : "agreed", transcript, offers });
      emit(c.id, { type: "deal", amount: 600 });
    };
    if (stage === "room") later.push(deal);
    else deal();
  }

  if (stage === "receipts") {
    for (const r of RECEIPTS) addReceipt(c.id, { ...r, at: new Date().toISOString() });
    updateCase(c.id, { status: "settled" });
  }

  // step=0: apply everything now (static screenshots). Otherwise give the browser time to open /ws first.
  if (stepMs <= 0) later.forEach((fn) => fn());
  else later.forEach((fn, i) => setTimeout(fn, 1500 + i * stepMs));
  return c;
}

export default async function previewRoutes(app: FastifyInstance) {
  if (process.env.DEV_PREVIEW !== "1") return; // never mounted in a normal run
  app.get<{ Querystring: { stage?: string; step?: string } }>("/dev/preview", async (req, reply) => {
    const stage = (req.query.stage ?? "room") as Stage;
    if (!STAGES.includes(stage)) return reply.code(400).send({ error: `stage must be one of ${STAGES.join(", ")}` });
    const step = req.query.step === undefined ? 900 : Number(req.query.step);
    const c = await seedPreview(stage, Number.isFinite(step) ? step : 900);
    return reply.redirect(`/#case=${c.id}`);
  });
}
