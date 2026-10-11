import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedPreview } from "../src/dev/preview.js";
import summaryRoutes, { buildSummary, clearSummaryAudioCache, DEFAULT_SUMMARY_VOICE, speakSummary } from "../src/routes/summary.js";
import { createCase } from "../src/store.js";
import type { CasePacket, Receipt } from "../src/types.js";

const at = "2026-10-11T00:00:00.000Z";
const rc = (kind: string, detail?: Record<string, unknown>): Receipt => ({ chain: "xrpl", kind, txHash: `H${kind}`, explorerUrl: "https://devnet.xrpl.org", detail, at });

function realCase(patch: Partial<CasePacket> = {}): CasePacket {
  return createCase({
    mode: "patient",
    status: "agreed",
    bill: { provider: { name: "Test Hospital" }, lineItems: [], totalCharges: 10000, patientBalance: 10000 },
    flags: [
      { kind: "duplicate", message: "dup", amountAtStake: 842 },
      { kind: "unbundling", message: "unb", amountAtStake: 100.5 },
      { kind: "above_fair_price", message: "fair", amountAtStake: 5000 }, // leverage, not an error
    ],
    agreedAmount: 2500,
    ...patch,
  });
}

async function app() {
  const a = Fastify();
  await a.register(summaryRoutes);
  return a;
}

describe("outcome summary template", () => {
  it("labels a live browser rehearsal as simulated in both spoken languages", () => {
    const s = buildSummary(realCase({ voiceSimulation: true }));
    expect(s.simulated).toBe(true);
    expect(s.en).toMatch(/^Note: this is a simulated call result/);
    expect(s.zh).toMatch(/^注意：这是模拟通话/);
  });
  it("speaks only numbers taken from the packet", () => {
    const s = buildSummary(realCase());
    expect(s.preview).toBe(false);
    expect(s.numbers).toEqual({ originalBill: 10000, errorsFound: 2, errorAmount: 942.5, agreedAmount: 2500, saved: 7500, savedPct: 75 });
    expect(s.zh).toContain("10,000 美元");
    expect(s.zh).toContain("2 处可能的错误");
    expect(s.zh).toContain("942.50 美元");
    expect(s.zh).toContain("2,500 美元");
    expect(s.zh).toContain("少付 7,500 美元，省了 75%");
    expect(s.en).toContain("$7,500 less than the original bill, a 75% saving");
    expect(s.zh).not.toContain("5,000"); // above_fair_price is not counted as an error
    expect(s.steps).toEqual({ credential: "none", escrow: "none", loan: "none" });
    expect(s.zh).toContain("下一步：把谈妥的 2,500 美元 放进托管账户");
  });

  it("above the assistance cutoff the credential line does not claim financial-assistance eligibility", () => {
    const charity = { hospital: "Test Hospital", hasFap: true, freeCareBelowPctFpl: 400, summary: "free below 400%", sources: [] };
    const receipts = [rc("CredentialCreate"), rc("CredentialAccept")];
    const lin = { name: "Lin Mei", language: "zh" as const, householdSize: 3, annualIncome: 112000, maxPay: 5000, consent: true }; // 410% FPL
    const above = buildSummary(realCase({ charity, receipts, patient: lin }));
    expect(above.en).not.toMatch(/financial-hardship credential/);
    expect(above.en).toContain("This is not the hospital's financial assistance.");
    expect(above.zh).not.toContain("经济困难证明");
    const below = buildSummary(realCase({ charity, receipts, patient: { ...lin, annualIncome: 38000 } }));
    expect(below.en).toContain("Your financial-hardship credential has been issued");
  });

  it("does not count a $0 flag (No Surprises Act notice) as a billing error", () => {
    const s = buildSummary(realCase({ flags: [...realCase().flags, { kind: "no_surprises_act", message: "self-pay notice", amountAtStake: 0 }] }));
    expect(s.numbers.errorsFound).toBe(2);
    expect(s.en).not.toMatch(/surprise-billing/);
  });

  it("a $0 deal reads as a write-off: no escrow step, no loan pitch, settled once the hospital confirms", () => {
    const pending = buildSummary(realCase({ agreedAmount: 0 }));
    expect(pending.numbers).toMatchObject({ agreedAmount: 0, saved: 10000, savedPct: 100 });
    expect(pending.en).toContain("write off the whole balance");
    expect(pending.en).toContain("No money has to move");
    expect(pending.en).not.toMatch(/put the agreed|payment plan/);
    const done = buildSummary(realCase({ agreedAmount: 0, status: "settled" }));
    expect(done.en).toContain("This bill is settled");
    expect(done.zh).toContain("没有用托管");
  });

  it("reports escrow / credential / loan status from the receipts", () => {
    const locked = buildSummary(realCase({ receipts: [rc("CredentialCreate"), rc("CredentialAccept"), rc("EscrowCreate"), rc("LoanSet", { principal: 2500, payments: 12 })] }));
    expect(locked.steps).toEqual({ credential: "done", escrow: "locked", loan: "done" });
    expect(locked.zh).toContain("2,500 美元 已经放进 XRPL 测试网的托管账户");
    expect(locked.zh).toContain("分 12 期付");
    expect(locked.en).toContain("$2,500 over 12 payments");

    const done = buildSummary(realCase({ receipts: [rc("EscrowCreate"), rc("Batch"), rc("EscrowFinish")] }));
    expect(done.steps.escrow).toBe("released");
    expect(done.zh).toContain("这笔账结清了");
    expect(done.zh).not.toContain("0% 分期");
  });

  it("says plainly when there is no deal yet, and never claims savings", () => {
    const s = buildSummary(realCase({ agreedAmount: undefined }));
    expect(s.numbers.saved).toBeUndefined();
    expect(s.zh).toContain("还没有和医院谈妥价格");
    expect(s.zh).not.toContain("省了");
  });

  it("labels the dev-preview case as preview, with the seeded numbers", async () => {
    const p = await seedPreview("receipts", 0);
    const s = buildSummary(p);
    expect(s.preview).toBe(true);
    expect(s.zh.startsWith("注意：这是界面预览用的示例数据")).toBe(true);
    expect(s.numbers.originalBill).toBe(p.bill!.patientBalance);
    expect(s.numbers.agreedAmount).toBe(600);
    expect(s.numbers.saved).toBe(p.bill!.patientBalance - 600);
    expect(s.lines.zh.some((l) => l.includes("预览"))).toBe(false); // the UI shows the notice as a tag instead
    expect(s.lines.zh.join("")).toBe(s.zh.replace("注意：这是界面预览用的示例数据，不是真实的个案。", ""));
  });

  it("GET /summary returns the template; 404 for an unknown case", async () => {
    const a = await app();
    const c = realCase();
    const res = await a.inject({ method: "GET", url: `/api/cases/${c.id}/summary` });
    expect(res.statusCode).toBe(200);
    expect(res.json().zh).toBe(buildSummary(c).zh);
    expect((await a.inject({ method: "GET", url: "/api/cases/nope/summary" })).statusCode).toBe(404);
    await a.close();
  });
});

describe("outcome summary audio (ElevenLabs TTS)", () => {
  beforeEach(() => {
    clearSummaryAudioCache();
    vi.stubEnv("ELEVENLABS_API_BASE", "");
    vi.stubEnv("ELEVENLABS_INTAKE_VOICE_ID", "");
    vi.stubEnv("ELEVENLABS_ZH_TTS_MODEL", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("503 with a clear message when ELEVENLABS_API_KEY is missing", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    const a = await app();
    const c = realCase();
    const res = await a.inject({ method: "GET", url: `/api/cases/${c.id}/summary.mp3` });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("ElevenLabs is not configured — set ELEVENLABS_API_KEY");
    await a.close();
  });

  it("sends the zh text to the TTS endpoint and caches per case + text", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "k-test");
    const c = realCase();
    const zh = buildSummary(c).zh;
    const f = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${DEFAULT_SUMMARY_VOICE}?output_format=mp3_44100_128`);
      expect(init.method).toBe("POST");
      expect(init.headers).toMatchObject({ "xi-api-key": "k-test", "content-type": "application/json" });
      expect(JSON.parse(init.body as string)).toEqual({ text: zh, model_id: "eleven_flash_v2_5", language_code: "zh" });
      return new Response(new Uint8Array([0xff, 0xfb, 1, 2]), { headers: { "content-type": "audio/mpeg" } });
    });
    const first = await speakSummary(c.id, zh, f as unknown as typeof fetch);
    expect(first).toEqual({ audio: Buffer.from([0xff, 0xfb, 1, 2]), cached: false });
    expect((await speakSummary(c.id, zh, f as unknown as typeof fetch)).cached).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    await speakSummary(c.id, `${zh}变了`, f as unknown as typeof fetch).catch(() => undefined); // new text -> new request
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("honours voice/model env and omits language_code for multilingual_v2", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "k-test");
    vi.stubEnv("ELEVENLABS_INTAKE_VOICE_ID", "voice123");
    vi.stubEnv("ELEVENLABS_ZH_TTS_MODEL", "eleven_multilingual_v2");
    const f = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain("/v1/text-to-speech/voice123?");
      expect(JSON.parse(init.body as string)).toEqual({ text: "你好", model_id: "eleven_multilingual_v2" });
      return new Response(new Uint8Array([1]));
    });
    await speakSummary("case-x", "你好", f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("upstream failure is a 502 that never echoes the provider body", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "k-secret");
    const f = vi.fn(async () => Response.json({ detail: "bad key k-secret" }, { status: 401 }));
    const err = await speakSummary("case-y", "你好", f as unknown as typeof fetch).catch((e) => e);
    expect(err.statusCode).toBe(502);
    expect(err.message).toBe("ElevenLabs text-to-speech failed (HTTP 401)");
    expect(err.message).not.toContain("k-secret");
  });

  it("GET /summary.mp3 serves audio/mpeg through the global fetch", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "k-test");
    const f = vi.fn(async () => new Response(new Uint8Array([9, 9, 9])));
    vi.stubGlobal("fetch", f);
    try {
      const a = await app();
      const c = realCase();
      const res = await a.inject({ method: "GET", url: `/api/cases/${c.id}/summary.mp3` });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("audio/mpeg");
      expect(res.rawPayload).toEqual(Buffer.from([9, 9, 9]));
      expect(res.headers["x-vellum-cache"]).toBe("miss");
      const again = await a.inject({ method: "GET", url: `/api/cases/${c.id}/summary.mp3` });
      expect(again.headers["x-vellum-cache"]).toBe("hit");
      expect(f).toHaveBeenCalledTimes(1);
      await a.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
