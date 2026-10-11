import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { opt } from "../env.js";
import { requireCase } from "../store.js";
import { fplPercent } from "../research/charity.js";
import type { AuditFlagKind, CasePacket, Receipt } from "../types.js";

// Mandarin outcome summary (see docs/API.md):
//   GET /api/cases/:id/summary      → {zh, en, preview, numbers, steps}  deterministic template, never an LLM
//   GET /api/cases/:id/summary.mp3  → audio/mpeg, ElevenLabs TTS of the zh text (cached per case + text)
// Every number spoken comes straight from the packet, so the summary can never invent a figure.

// Flag kinds that are billing mistakes. above_fair_price / charity_eligible are leverage, not errors.
const ERROR_KINDS: AuditFlagKind[] = ["duplicate", "upcoding", "unbundling", "math_error", "no_surprises_act", "other"];
const KIND_ZH: Record<AuditFlagKind, string> = {
  duplicate: "重复收费", upcoding: "级别收高了", unbundling: "拆开重复收", math_error: "算错了",
  no_surprises_act: "意外账单保护", other: "其他问题", above_fair_price: "高于合理价", charity_eligible: "可申请援助",
};
const KIND_EN: Record<AuditFlagKind, string> = {
  duplicate: "a duplicate charge", upcoding: "upcoding", unbundling: "unbundled charges", math_error: "a math error",
  no_surprises_act: "a surprise-billing violation", other: "another issue", above_fair_price: "above fair price", charity_eligible: "charity eligible",
};

const money = (n: number) => {
  const c = Math.round(n * 100) / 100;
  const cents = Number.isInteger(c) ? 0 : 2; // $600 not $600.00, but $942.50 not $942.5
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: cents, maximumFractionDigits: cents }).format(c);
};
const zhUsd = (n: number) => `${money(n)} 美元`;
const enUsd = (n: number) => `$${money(n)}`;

export type StepState = "done" | "none";
export type OutcomeSummary = {
  zh: string;
  en: string;
  /** the same text sentence by sentence (the preview notice, if any, is NOT in lines; see `preview`) */
  lines: { zh: string[]; en: string[] };
  preview: boolean;
  simulated: boolean;
  numbers: {
    originalBill?: number;
    errorsFound: number;
    errorAmount: number;
    agreedAmount?: number;
    saved?: number;
    savedPct?: number;
  };
  steps: { credential: StepState; escrow: "released" | "locked" | "none"; loan: StepState };
};

/** Same rule dashboard.js uses: a seeded design-harness case must never read as real. */
export function isPreviewCase(p: CasePacket): boolean {
  return (
    p.facts.some((f) => /^PREVIEW/.test(String(f))) ||
    p.receipts.some((r) => /PREVIEW/.test(String(r.txHash)) || /PREVIEW/.test(String(r.detail?.note ?? "")))
  );
}

/** true when her stated household income is at or above every tier of the hospital's financial-assistance policy. */
export function aboveFapThreshold(p: CasePacket): boolean {
  const c = p.charity;
  const pt = p.patient;
  const cut = Math.max(c?.freeCareBelowPctFpl ?? 0, c?.discountBelowPctFpl ?? 0);
  if (!c?.hasFap || !cut || pt?.annualIncome === undefined || !pt.householdSize) return false;
  try {
    return fplPercent(pt.annualIncome, pt.householdSize) >= cut;
  } catch {
    return false;
  }
}

const has = (rs: Receipt[], kind: string) => rs.some((r) => r.chain === "xrpl" && r.kind === kind);

export function buildSummary(p: CasePacket): OutcomeSummary {
  const preview = isPreviewCase(p);
  const balance = p.bill?.patientBalance;
  // Only flags with dollars attached are billing errors: a $0 flag (e.g. the No Surprises Act notice for a
  // self-pay patient) is a right to tell her about, not a mistake to count.
  const errors = p.flags.filter((f) => ERROR_KINDS.includes(f.kind) && Number(f.amountAtStake) > 0);
  const errorAmount = errors.reduce((s, f) => s + (Number(f.amountAtStake) || 0), 0);
  const kinds = [...new Set(errors.map((f) => f.kind))];
  const agreed = typeof p.agreedAmount === "number" && p.agreedAmount >= 0 ? p.agreedAmount : undefined;
  const saved = balance != null && agreed != null && agreed < balance ? balance - agreed : undefined;
  const savedPct = saved != null && balance ? Math.round((saved / balance) * 100) : undefined;

  const credential: StepState = has(p.receipts, "CredentialAccept") || has(p.receipts, "CredentialCreate") ? "done" : "none";
  const escrow = has(p.receipts, "EscrowFinish") || has(p.receipts, "Batch") ? "released" : has(p.receipts, "EscrowCreate") ? "locked" : "none";
  const loanReceipt = p.receipts.find((r) => r.chain === "xrpl" && r.kind === "LoanSet");
  const loan: StepState = loanReceipt ? "done" : "none";

  const zh: string[] = [];
  const en: string[] = [];
  zh.push("您好，这是 Vellum 替您办账单的结果。");
  en.push("Hello, here is how Vellum did on your bill.");

  if (balance != null) {
    zh.push(`医院原来说您要付 ${zhUsd(balance)}。`);
    en.push(`The hospital said you owed ${enUsd(balance)}.`);
  }
  if (errors.length) {
    zh.push(`Vellum 在账单里找到 ${errors.length} 处可能的错误（${kinds.map((k) => KIND_ZH[k]).join("、")}），涉及最多 ${zhUsd(errorAmount)}。`);
    en.push(`Vellum found ${errors.length} possible billing error${errors.length === 1 ? "" : "s"} (${kinds.map((k) => KIND_EN[k]).join(", ")}), worth up to ${enUsd(errorAmount)}.`);
  } else if (p.bill) {
    zh.push("账单里没有发现明显的错误。");
    en.push("No clear billing errors were found.");
  }

  const writeOff = agreed === 0;
  if (writeOff) {
    zh.push("医院同意把这笔账全部免掉，您不用付钱。");
    en.push("The hospital agreed to write off the whole balance: you owe nothing.");
    if (saved != null) {
      zh.push(`比原来少付 ${zhUsd(saved)}，省了 ${savedPct}%。`);
      en.push(`That is ${enUsd(saved)} less than the original bill, a ${savedPct}% saving.`);
    }
  } else if (agreed != null) {
    zh.push(`最后和医院谈妥的价格是 ${zhUsd(agreed)}。`);
    en.push(`The price agreed with the hospital is ${enUsd(agreed)}.`);
    if (saved != null) {
      zh.push(`比原来少付 ${zhUsd(saved)}，省了 ${savedPct}%。`);
      en.push(`That is ${enUsd(saved)} less than the original bill, a ${savedPct}% saving.`);
    }
  } else {
    zh.push("还没有和医院谈妥价格。谈妥以后，这里会告诉您结果。");
    en.push("No price has been agreed with the hospital yet. The result will appear here once it is.");
  }

  if (credential === "done") {
    if (aboveFapThreshold(p)) {
      // She does NOT qualify for the hospital's financial assistance; the clinic's credential only opens the 0% plan.
      zh.push("诊所还在 XRPL 测试网上给您签发了一份证明，需要时可以用社区基金的零利息分期。这不是医院的经济援助。");
      en.push("Your clinic also issued a credential on the XRPL test network, so you can use the 0% community payment plan if you need it. This is not the hospital's financial assistance.");
    } else {
      zh.push("您的经济困难证明已经在 XRPL 测试网上签发。");
      en.push("Your financial-hardship credential has been issued on the XRPL test network.");
    }
  }
  if (writeOff) {
    if (p.status === "settled") {
      zh.push("医院已经确认您欠款为零。没有钱需要付，所以没有用托管，这笔账结清了。");
      en.push("The hospital confirmed a zero balance. No money had to move, so no escrow was used. This bill is settled.");
    } else {
      zh.push("下一步：等医院确认您的欠款为零。没有钱需要付，所以不用托管。");
      en.push("Next step: the hospital confirms the zero balance. No money has to move, so no escrow is needed.");
    }
  } else if (agreed != null) {
    if (escrow === "released") {
      zh.push("医院已经确认您欠款为零，托管里的钱已经付给医院，这笔账结清了。");
      en.push("The hospital confirmed a zero balance and the escrowed money was released to it. This bill is settled.");
    } else if (escrow === "locked") {
      zh.push(`${zhUsd(agreed)} 已经放进 XRPL 测试网的托管账户。要等医院确认您欠款为零，钱才会付出去。`);
      en.push(`${enUsd(agreed)} is locked in an XRPL test-network escrow. It is paid only after the hospital confirms a zero balance.`);
    } else {
      zh.push(`下一步：把谈妥的 ${zhUsd(agreed)} 放进托管账户，医院确认欠款为零以后才付出去。`);
      en.push(`Next step: put the agreed ${enUsd(agreed)} in escrow; it is paid only once the hospital confirms a zero balance.`);
    }
    if (loan === "done") {
      const d = loanReceipt!.detail ?? {};
      const principal = Number(d.principal);
      const payments = Number(d.payments);
      const parts = Number.isFinite(principal) && Number.isFinite(payments);
      zh.push(parts ? `互助基金已经给您开了 0% 分期：${zhUsd(principal)}，分 ${payments} 期付，不收利息。` : "互助基金已经给您开了 0% 分期，不收利息。");
      en.push(parts ? `The community fund opened a 0% payment plan: ${enUsd(principal)} over ${payments} payments, no interest.` : "The community fund opened a 0% payment plan with no interest.");
    } else if (escrow !== "released") {
      zh.push("如果一次付不起，可以向互助基金申请 0% 分期。");
      en.push("If paying at once is hard, you can ask the community fund for a 0% payment plan.");
    }
  }

  // A seeded design-harness case says so out loud, first, in both languages.
  const notice = preview
    ? { zh: "注意：这是界面预览用的示例数据，不是真实的个案。", en: "Note: this is preview data from the design harness, not a real case." }
    : p.voiceSimulation
      ? { zh: "注意：这是模拟通话的演示结果，没有联系真实医院，也没有达成真实协议。", en: "Note: this is a simulated call result. No real hospital was contacted and no real settlement was agreed." }
      : undefined;
  return {
    zh: [notice?.zh, ...zh].filter(Boolean).join(""),
    en: [notice?.en, ...en].filter(Boolean).join(" "),
    lines: { zh, en },
    preview,
    simulated: p.voiceSimulation === true,
    numbers: { originalBill: balance, errorsFound: errors.length, errorAmount: Math.round(errorAmount * 100) / 100, agreedAmount: agreed, saved, savedPct },
    steps: { credential, escrow, loan },
  };
}

// ---------------------------------------------------------------- TTS

export const DEFAULT_SUMMARY_VOICE = "EXAVITQu4vr4xnSDxMaL"; // "Sarah", ElevenLabs premade, multilingual
const MAX_CACHE = 64;
const audioCache = new Map<string, Buffer>();
export const clearSummaryAudioCache = () => audioCache.clear();

class TtsError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
  }
}

export function ttsConfig() {
  const key = opt("ELEVENLABS_API_KEY");
  if (!key) throw new TtsError("ElevenLabs is not configured — set ELEVENLABS_API_KEY", 503);
  return {
    key,
    base: (opt("ELEVENLABS_API_BASE", "https://api.elevenlabs.io") as string).replace(/\/$/, ""),
    voiceId: opt("ELEVENLABS_INTAKE_VOICE_ID", DEFAULT_SUMMARY_VOICE) as string,
    modelId: opt("ELEVENLABS_ZH_TTS_MODEL", "eleven_flash_v2_5") as string,
  };
}

/** One TTS request for `text`, cached per case + voice + model + text. Returns mp3 bytes. */
export async function speakSummary(caseId: string, text: string, f: typeof fetch = fetch, lang: "zh" | "en" = "zh"): Promise<{ audio: Buffer; cached: boolean }> {
  const base = ttsConfig();
  // English uses the advocate's voice; Chinese keeps the multilingual summary voice.
  const cfg = lang === "en"
    ? { ...base, voiceId: opt("ELEVENLABS_ADVOCATE_VOICE_ID", "hpp4J3VqNfWAUOO0d1Us") as string, modelId: opt("ELEVENLABS_TTS_MODEL", "eleven_flash_v2_5") as string }
    : base;
  const cacheKey = `${caseId}:${createHash("sha256").update(`${cfg.voiceId}\n${cfg.modelId}\n${text}`).digest("hex")}`;
  const hit = audioCache.get(cacheKey);
  if (hit) return { audio: hit, cached: true };

  // language_code pins Mandarin normalization on Flash/Turbo v2.5; multilingual_v2 ignores it.
  const body: Record<string, unknown> = { text, model_id: cfg.modelId };
  if (!/multilingual_v2/.test(cfg.modelId)) body.language_code = lang;
  let res: Response;
  try {
    res = await f(`${cfg.base}/v1/text-to-speech/${encodeURIComponent(cfg.voiceId)}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": cfg.key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new TtsError("ElevenLabs text-to-speech request failed or timed out", 502);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    // never echo the provider body: it can reflect the key
    throw new TtsError(`ElevenLabs text-to-speech failed (HTTP ${res.status})`, 502);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  if (!audio.length) throw new TtsError("ElevenLabs returned empty audio", 502);
  if (audioCache.size >= MAX_CACHE) audioCache.delete(audioCache.keys().next().value!);
  audioCache.set(cacheKey, audio);
  return { audio, cached: false };
}

export default async function summaryRoutes(app: FastifyInstance) {
  app.setErrorHandler((e: Error & { statusCode?: number }, _req, reply) => {
    const code = e.statusCode ?? (/is not configured/i.test(e.message) ? 503 : 502);
    reply.code(code).send({ error: e.message });
  });

  app.get<{ Params: { id: string } }>("/api/cases/:id/summary", async (req) => buildSummary(requireCase(req.params.id)));

  app.get<{ Params: { id: string }; Querystring: { lang?: string } }>("/api/cases/:id/summary.mp3", async (req, reply) => {
    const packet = requireCase(req.params.id);
    const lang = req.query.lang === "zh" ? "zh" : "en"; // English by default; ?lang=zh reads it in Mandarin
    const sum = buildSummary(packet);
    const { audio, cached } = await speakSummary(packet.id, lang === "zh" ? sum.zh : sum.en, fetch, lang);
    return reply.header("content-type", "audio/mpeg").header("cache-control", "no-store").header("x-vellum-cache", cached ? "hit" : "miss").send(audio);
  });
}
