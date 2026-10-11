import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../src/llm.js", () => ({
  llmText: vi.fn(async (_system: string, user: string) => `ZH(${user})`),
  llmJson: vi.fn(),
  llmChatJson: vi.fn(async () => {
    throw new Error("llmChatJson must be injected in tests");
  }),
}));

import { createCase, subscribe } from "../src/store.js";
import type { CaseEvent, CasePacket } from "../src/types.js";
import { activeBridge, startAgentBridge, voiceFailureReason, type WsLike } from "../src/agent/bridge.js";
import { startTextNegotiation, type TextChatFn } from "../src/agent/textNegotiation.js";
import voiceRoutes from "../src/routes/voice.js";
import Fastify from "fastify";

function patientCase(): CasePacket {
  return createCase({
    mode: "patient",
    status: "mandated",
    patient: { name: "Lin Mei", language: "zh", maxPay: 4000, consent: true },
    bill: {
      provider: { name: "St. Example Medical Center" },
      lineItems: [{ code: "99285", description: "ER visit level 5", qty: 1, charge: 14000 }],
      totalCharges: 14000,
      patientBalance: 14000,
    },
    target: 2500,
    opening: 1500,
    walkaway: 4000,
    facts: ["Line 1 is billed at level 5"],
  });
}

function collect(caseId: string) {
  const events: CaseEvent[] = [];
  subscribe(caseId, { readyState: 1, send: (d: string) => events.push(JSON.parse(d)), on: () => undefined } as any);
  return events;
}

/** Scripted Claude: advocate turns come from `adv`, hospital turns from `hosp`, chosen by the system prompt. */
function scripted(adv: unknown[], hosp: unknown[]) {
  const seen: { seat: "advocate" | "hospital"; turns: { role: string; content: string }[] }[] = [];
  const chat: TextChatFn = async <T,>(system: string, turns: { role: "user" | "assistant"; content: string }[]) => {
    const seat = system.includes('"tools"') ? "advocate" : "hospital";
    seen.push({ seat, turns });
    const next = (seat === "advocate" ? adv : hosp).shift();
    if (next === undefined) throw new Error(`script ran out of ${seat} turns`);
    return { value: next as T };
  };
  return { chat, seen };
}

const fast = { minGapMs: 0, translate: async (t: string) => `ZH(${t})` };

describe("text negotiation", () => {
  it("plays both sides through handleTool and reaches a deal at or below the walkaway", async () => {
    const c = patientCase();
    const events = collect(c.id);
    const { chat, seen } = scripted(
      [
        { tools: [], say: "Hi, I'm calling for Lin Mei about line one." },
        { tools: [{ name: "log_offer", amount: 9000 }], say: "Line one is upcoded. Can you do better?" },
        { tools: [{ name: "log_offer", amount: 3200 }, { name: "accept_offer", amount: 3200 }, { name: "end_call", outcome: "deal", amount: 3200 }], say: "Deal at thirty-two hundred, thank you." },
      ],
      [{ say: "Okay, nine thousand then." }, { say: "Best I can do is thirty-two hundred, paid today." }],
    );
    const h = startTextNegotiation(c.id, { ...fast, chat });
    expect(await h.done).toEqual({ reason: "outcome" });
    expect(c.agreedAmount).toBe(3200);
    expect(c.status).toBe("agreed");
    expect(c.voiceSimulation).toBe(true);
    expect(c.transcript.map((l) => l.role)).toEqual(["hospital", "advocate", "hospital", "advocate", "hospital", "advocate"]);
    expect(c.transcript[0].text).toMatch(/Patient accounts/);
    expect(c.transcript[1].textZh).toBe("ZH(Hi, I'm calling for Lin Mei about line one.)");
    expect(events.some((e) => e.type === "deal" && e.amount === 3200)).toBe(true);
    expect(events.filter((e) => e.type === "offer").map((e) => (e as any).offer.amount)).toEqual([9000, 3200, 3200]);
    // the hospital's line is on screen before the advocate's tool event for it
    const iLine = events.findIndex((e) => e.type === "transcript" && /nine thousand/.test(e.line.text));
    const iOffer = events.findIndex((e) => e.type === "offer" && e.offer.amount === 9000);
    expect(iLine).toBeLessThan(iOffer);
    // the advocate hears its tool results, like a voice agent does
    const third = seen.filter((s) => s.seat === "advocate")[2];
    expect(third.turns.at(-1)!.content).toMatch(/^\[log_offer 9000: Logged\./);
    // the hospital seat gets the production hospital prompt
    expect(seen.find((s) => s.seat === "hospital")!.turns[0]).toMatchObject({ role: "assistant" });
  });

  it("refuses an accept above the walkaway and keeps negotiating", async () => {
    const c = patientCase();
    const { chat, seen } = scripted(
      [
        { tools: [{ name: "log_offer", amount: 6000 }, { name: "accept_offer", amount: 6000 }, { name: "end_call", outcome: "deal", amount: 6000 }], say: "We accept six thousand." },
        { tools: [{ name: "end_call", outcome: "no_deal", summary: "hold placed" }], say: "Please place a hold. Goodbye." },
      ],
      [{ say: "Actually no, I need a supervisor for that." }],
    );
    const h = startTextNegotiation(c.id, { ...fast, chat });
    expect(await h.done).toEqual({ reason: "outcome" });
    expect(c.agreedAmount).toBeUndefined();
    expect(c.status).toBe("failed");
    expect(c.offers.some((o) => o.by === "advocate")).toBe(false);
    expect(seen.filter((s) => s.seat === "advocate")[1].turns.at(-1)!.content).toMatch(/accept_offer 6000: REFUSED/);
  });

  it("stops at the turn limit with a wrap-up nudge", async () => {
    const c = patientCase();
    const filler = () => ({ tools: [], say: "Can you do better?" });
    const { chat, seen } = scripted([filler(), filler(), filler()], [{ say: "No." }, { say: "No." }, { say: "No." }]);
    const h = startTextNegotiation(c.id, { ...fast, chat, maxTurns: 3 });
    expect(await h.done).toEqual({ reason: "timeout" });
    expect(seen.filter((s) => s.seat === "advocate").at(-1)!.turns.at(-1)!.content).toMatch(/TIME CHECK: this is your last turn/);
  });
});

// ---------------------------------------------------------------- voice first, text on failure

class FakeWs extends EventEmitter implements WsLike {
  readyState = 0;
  sent: any[] = [];
  constructor(public url: string) {
    super();
  }
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  drop(code: number, reason: string) {
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }
}

const ENV = { ELEVENLABS_API_KEY: "k", ELEVENLABS_ADVOCATE_AGENT_ID: "agent_adv", ELEVENLABS_HOSPITAL_AGENT_ID: "agent_hosp", ELEVENLABS_BROWSER_AGENT_ID: "" };
const dealScript = () =>
  scripted(
    [{ tools: [{ name: "log_offer", amount: 2400 }, { name: "accept_offer", amount: 2400 }, { name: "end_call", outcome: "deal", amount: 2400 }], say: "Twenty-four hundred works. Thank you." }],
    [],
  );

describe("startAgentBridge fallback", () => {
  beforeEach(() => Object.assign(process.env, ENV));
  afterEach(() => vi.unstubAllEnvs());

  it("falls back to text when ElevenLabs is out of credits before the call connects", async () => {
    const c = patientCase();
    const events = collect(c.id);
    const { chat } = dealScript();
    const h = await startAgentBridge(c.id, "hospital", {
      signedUrl: async () => {
        throw new Error('ElevenLabs GET /v1/convai/conversation/get-signed-url failed 401: {"detail":{"status":"quota_exceeded"}}');
      },
      connect: () => new FakeWs("x"),
      text: { ...fast, chat },
    });
    expect(h.channel).toBe("text");
    expect(activeBridge(c.id)).toBe(h);
    expect(await h.done).toEqual({ reason: "outcome" });
    expect(activeBridge(c.id)).toBeUndefined();
    expect(c.agreedAmount).toBe(2400);
    const log = events.find((e) => e.type === "log" && /Voice unavailable/.test(e.message)) as any;
    expect(log.message).toBe("Voice unavailable (ElevenLabs: out of credits) — continuing as a live text negotiation");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("falls back to text when the voice call is closed with a quota error mid-call, keeping what was said", async () => {
    const c = patientCase();
    const events = collect(c.id);
    const sockets: FakeWs[] = [];
    const { chat, seen } = dealScript();
    const h = await startAgentBridge(c.id, "hospital", {
      signedUrl: async (id) => `wss://signed/${id}`,
      connect: (url) => {
        const ws = new FakeWs(url);
        sockets.push(ws);
        return ws;
      },
      tickMs: 100,
      text: { ...fast, chat },
    });
    expect(h.channel).toBe("voice");
    const [adv, hosp] = sockets;
    adv.open();
    hosp.open();
    hosp.emit("message", JSON.stringify({ type: "agent_response", agent_response_event: { agent_response: "Patient accounts, this is Dana.", event_id: 1 } }));
    await new Promise((r) => setTimeout(r, 10));
    adv.drop(3000, "[quota_exceeded] You've run out of credits.");
    expect(await h.done).toEqual({ reason: "outcome" });
    expect(h.channel).toBe("text");
    expect(c.agreedAmount).toBe(2400);
    expect(events.some((e) => e.type === "log" && /Voice unavailable \(ElevenLabs: out of credits\)/.test(e.message))).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
    // the text call picks up after Dana's greeting instead of starting over
    expect(seen[0].turns.map((t) => t.content)).toEqual(["Patient accounts, this is Dana."]);
    expect(c.transcript.filter((l) => /Dana/.test(l.text))).toHaveLength(1);
  });

  it("goes straight to text without an ElevenLabs key, or when text is requested", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const c = patientCase();
    const events = collect(c.id);
    const a = dealScript();
    const h = await startAgentBridge(c.id, "hospital", { text: { ...fast, chat: a.chat } });
    expect(h.channel).toBe("text");
    expect(await h.done).toEqual({ reason: "outcome" });
    expect(events.some((e) => e.type === "log" && /ELEVENLABS_API_KEY is not configured/.test(e.message))).toBe(true);

    process.env.ELEVENLABS_API_KEY = "k";
    const c2 = patientCase();
    const signedUrl = vi.fn(async () => "x");
    const b = dealScript();
    const h2 = await startAgentBridge(c2.id, "hospital", { channel: "text", signedUrl, text: { ...fast, chat: b.chat } });
    expect(await h2.done).toEqual({ reason: "outcome" });
    expect(signedUrl).not.toHaveBeenCalled();
  });

  it("does not fall back after a real outcome, and still refuses without consent", async () => {
    const c = patientCase();
    c.patient!.consent = false;
    await expect(startAgentBridge(c.id, "hospital", { channel: "text" })).rejects.toThrow(/consent/);
    expect(activeBridge(c.id)).toBeUndefined();
  });

  it("summarizes ElevenLabs failures without leaking bodies", () => {
    expect(voiceFailureReason("ElevenLabs ended the advocate leg: 1002 This request exceeds your quota limit")).toBe("out of credits");
    expect(voiceFailureReason("ELEVENLABS_HOSPITAL_AGENT_ID is not configured")).toBe("ELEVENLABS_HOSPITAL_AGENT_ID is not configured");
    expect(voiceFailureReason("ElevenLabs GET /x failed 401: {\"detail\":\"invalid_api_key\"}")).toBe("API key rejected");
    expect(voiceFailureReason("ElevenLabs advocate connection error: connect ECONNREFUSED 1.2.3.4:443")).toBe("could not connect");
  });

  it("POST /negotiate {counterparty:'text'} runs the text negotiation", async () => {
    const c = patientCase();
    const app = Fastify();
    await app.register(voiceRoutes);
    // no LLM is injectable through the route (the mocked one throws): this only checks the wiring
    const r = await app.inject({ method: "POST", url: `/api/cases/${c.id}/negotiate`, payload: { counterparty: "text" } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ mode: "text", counterparty: "hospital", channel: "text" });
    activeBridge(c.id)?.stop();
    const bad = await app.inject({ method: "POST", url: `/api/cases/${c.id}/negotiate`, payload: { counterparty: "fax" } });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});
