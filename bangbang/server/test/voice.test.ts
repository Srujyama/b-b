import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../src/llm.js", () => ({
  llmText: vi.fn(async (_system: string, user: string) => `ZH(${user})`),
  llmJson: vi.fn(),
}));

import { createCase, subscribe } from "../src/store.js";
import type { CaseEvent, CasePacket } from "../src/types.js";
import { startAgentBridge, type WsLike } from "../src/agent/bridge.js";
import { clearTranslateCache } from "../src/agent/translate.js";
import {
  agentConfig,
  AGENTS,
  conversationInit,
  getSignedUrl,
  internalToolName,
  resamplePcm16,
  toolConfig,
} from "../src/agent/elevenlabs.js";
import voiceRoutes from "../src/routes/voice.js";
import Fastify from "fastify";

class FakeWs extends EventEmitter implements WsLike {
  readyState = 0;
  sent: any[] = [];
  closed = false;
  constructor(public url: string) {
    super();
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close");
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  server(msg: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
  meta(outFmt = "pcm_16000", inFmt = "pcm_16000") {
    this.server({
      type: "conversation_initiation_metadata",
      conversation_initiation_metadata_event: { conversation_id: "c", agent_output_audio_format: outFmt, user_input_audio_format: inFmt },
    });
  }
  audioOut() {
    return this.sent.filter((m) => m.user_audio_chunk).map((m) => Buffer.from(m.user_audio_chunk, "base64"));
  }
}

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
    facts: ["The ER visit was billed at level 5."],
  });
}

function collect(caseId: string) {
  const events: CaseEvent[] = [];
  subscribe(caseId, { readyState: 1, send: (d: string) => events.push(JSON.parse(d)), on: () => undefined } as any);
  return events;
}

function tone(n: number, v = 1000): Buffer {
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(v, i * 2);
  return b;
}

const ENV = {
  ELEVENLABS_API_KEY: "k",
  ELEVENLABS_ADVOCATE_AGENT_ID: "agent_adv",
  ELEVENLABS_HOSPITAL_AGENT_ID: "agent_hosp",
  ELEVENLABS_INTAKE_AGENT_ID: "agent_zh",
};

describe("bridge", () => {
  let sockets: FakeWs[];
  beforeEach(() => {
    vi.useFakeTimers();
    clearTranslateCache();
    sockets = [];
    Object.assign(process.env, ENV);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function start(caseId: string) {
    const handle = await startAgentBridge(caseId, "hospital", {
      connect: (url) => {
        const ws = new FakeWs(url);
        sockets.push(ws);
        return ws;
      },
      signedUrl: async (id) => `wss://signed/${id}`,
      tickMs: 100,
      graceMs: 1000,
    });
    const [adv, hosp] = sockets;
    adv.open();
    hosp.open();
    adv.meta();
    hosp.meta("pcm_16000", "pcm_16000");
    return { handle, adv, hosp };
  }

  it("connects both agents with per-case overrides and case_id dynamic variable", async () => {
    const c = patientCase();
    const { handle, adv, hosp } = await start(c.id);
    expect(adv.url).toBe("wss://signed/agent_adv");
    expect(hosp.url).toBe("wss://signed/agent_hosp");
    const advInit = adv.sent[0];
    expect(advInit.type).toBe("conversation_initiation_client_data");
    expect(advInit.dynamic_variables.case_id).toBe(c.id);
    expect(advInit.conversation_config_override.agent.prompt.prompt).toContain("report_outcome");
    expect(advInit.conversation_config_override.agent.prompt.prompt).not.toMatch(/end_call with outcome/);
    expect(advInit.conversation_config_override.agent.first_message).toBe("");
    expect(hosp.sent[0].conversation_config_override.agent.first_message).toMatch(/Patient accounts/);
    handle.stop();
  });

  it("relays audio hospital→advocate and advocate→hospital, paced and resampled", async () => {
    const c = patientCase();
    const events = collect(c.id);
    const { handle, adv, hosp } = await start(c.id);
    // advocate's mic expects 8 kHz for this test → resample from the hospital's 16 kHz output
    adv.meta("pcm_16000", "pcm_8000");

    const helloHosp = tone(1600, 1200); // 100ms @16k
    hosp.server({ type: "audio", audio_event: { audio_base_64: helloHosp.toString("base64"), event_id: 1 } });
    await vi.advanceTimersByTimeAsync(100);
    const intoAdv = adv.audioOut();
    expect(intoAdv.length).toBeGreaterThan(0);
    expect(intoAdv[0].length).toBe(800 * 2); // 100ms @ 8 kHz
    expect(intoAdv[0].readInt16LE(0)).toBe(1200);

    const helloAdv = tone(1600, -700);
    adv.server({ type: "audio", audio_event: { audio_base_64: helloAdv.toString("base64"), event_id: 2 } });
    await vi.advanceTimersByTimeAsync(100);
    const intoHosp = hosp.audioOut();
    expect(intoHosp.some((b) => b.readInt16LE(0) === -700)).toBe(true);

    // both voices streamed to the browser
    const audio = events.filter((e) => e.type === "audio") as Extract<CaseEvent, { type: "audio" }>[];
    expect(audio.map((a) => a.who)).toEqual(["hospital", "advocate"]);
    // silence fills the mic between turns
    await vi.advanceTimersByTimeAsync(100);
    expect(adv.audioOut().at(-1)!.every((x) => x === 0)).toBe(true);
    handle.stop();
  });

  it("drops the advocate's speech before the billing office answers", async () => {
    const c = patientCase();
    const { handle, adv, hosp } = await start(c.id);
    adv.server({ type: "audio", audio_event: { audio_base_64: tone(160, 999).toString("base64"), event_id: 1 } });
    await vi.advanceTimersByTimeAsync(100);
    expect(hosp.audioOut().every((b) => b.every((x) => x === 0))).toBe(true);
    handle.stop();
  });

  it("translates transcript lines to zh and stores them on the packet", async () => {
    const c = patientCase();
    const events = collect(c.id);
    const { handle, adv, hosp } = await start(c.id);
    hosp.server({ type: "agent_response", agent_response_event: { agent_response: "Patient accounts, this is Dana.", event_id: 1 } });
    adv.server({ type: "agent_response", agent_response_event: { agent_response: "Hi, I'm calling for Lin Mei.", event_id: 2 } });
    adv.server({ type: "user_transcript", user_transcription_event: { user_transcript: "ignored ASR echo", event_id: 3 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(c.transcript).toEqual([
      expect.objectContaining({ role: "hospital", text: "Patient accounts, this is Dana.", textZh: "ZH(Patient accounts, this is Dana.)" }),
      expect.objectContaining({ role: "advocate", text: "Hi, I'm calling for Lin Mei.", textZh: "ZH(Hi, I'm calling for Lin Mei.)" }),
    ]);
    expect(events.filter((e) => e.type === "transcript")).toHaveLength(2);
    handle.stop();
  });

  it("routes client tool calls to handleTool and answers with client_tool_result", async () => {
    const c = patientCase();
    const { handle, adv } = await start(c.id);
    adv.server({
      type: "client_tool_call",
      client_tool_call: { tool_name: "log_offer", tool_call_id: "t1", parameters: { amount: 9800 }, event_id: 4 },
    });
    expect(c.offers.at(-1)).toMatchObject({ by: "hospital", amount: 9800 });
    expect(adv.sent.find((m) => m.type === "client_tool_result")).toMatchObject({ tool_call_id: "t1", is_error: false });

    adv.server({
      type: "client_tool_call",
      client_tool_call: { tool_name: "accept_offer", tool_call_id: "t2", parameters: { amount: 9000 }, event_id: 5 },
    });
    // above the 4000 mandate → refused, reported as an error to the agent
    expect(adv.sent.filter((m) => m.type === "client_tool_result").at(-1)).toMatchObject({ tool_call_id: "t2", is_error: true });
    expect(c.agreedAmount).toBeUndefined();
    handle.stop();
  });

  it("shuts down after report_outcome (deal) and on hang-up", async () => {
    const c = patientCase();
    const { handle, adv, hosp } = await start(c.id);
    adv.server({
      type: "client_tool_call",
      client_tool_call: { tool_name: "report_outcome", tool_call_id: "t3", parameters: { outcome: "deal", amount: 2400 }, event_id: 6 },
    });
    expect(c.agreedAmount).toBe(2400);
    expect(c.status).toBe("agreed");
    expect(adv.closed).toBe(false); // goodbye still playing
    await vi.advanceTimersByTimeAsync(1000);
    expect(adv.closed && hosp.closed).toBe(true);
    expect(await handle.done).toEqual({ reason: "outcome" });

    const c2 = patientCase();
    sockets = [];
    const b2 = await start(c2.id);
    b2.hosp.close(); // counterparty used the end_call system tool
    expect(b2.adv.closed).toBe(true);
    expect(await b2.handle.done).toEqual({ reason: "hangup" });
  });

  it("stops at the timeout and answers pings", async () => {
    const c = patientCase();
    const handle = await startAgentBridge(c.id, "hospital", {
      connect: (url) => {
        const ws = new FakeWs(url);
        sockets.push(ws);
        return ws;
      },
      signedUrl: async (id) => `wss://signed/${id}`,
      timeoutMs: 5000,
    });
    sockets[0].open();
    sockets[0].server({ type: "ping", ping_event: { event_id: 42, ping_ms: 10 } });
    expect(sockets[0].sent.at(-1)).toEqual({ type: "pong", event_id: 42 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await handle.done).toEqual({ reason: "timeout" });
  });

  it("fails loudly when an agent id is missing", async () => {
    delete process.env.ELEVENLABS_HOSPITAL_AGENT_ID;
    const c = patientCase();
    await expect(startAgentBridge(c.id, "hospital", { signedUrl: async () => "x", connect: () => new FakeWs("x") })).rejects.toThrow(
      /ELEVENLABS_HOSPITAL_AGENT_ID is not configured/,
    );
  });
});

describe("elevenlabs helpers", () => {
  beforeEach(() => Object.assign(process.env, ENV));

  it("maps the outcome tool away from the built-in end_call", () => {
    expect(internalToolName("report_outcome")).toBe("end_call");
    expect(internalToolName("end_call")).toBe("end_call");
    expect(toolConfig("end_call", "client").name).toBe("report_outcome");
    const wh = toolConfig("end_call", "webhook", "https://x.ngrok.app/") as any;
    expect(wh.api_schema.url).toBe("https://x.ngrok.app/api/eleven/tools/report_outcome");
    expect(wh.api_schema.request_body_schema.properties.case_id.dynamic_variable).toBe("case_id");
    expect(() => toolConfig("log_offer", "webhook")).toThrow(/PUBLIC_URL/);
  });

  it("agent configs enable overrides, end_call system tool and a zh multilingual intake", () => {
    const intake = agentConfig(AGENTS.find((a) => a.role === "intake")!, ["tool_1"]) as any;
    expect(intake.conversation_config.agent.language).toBe("zh");
    expect(intake.conversation_config.tts.model_id).toMatch(/v2_5|multilingual/);
    expect(intake.conversation_config.agent.prompt.tool_ids).toEqual(["tool_1"]);
    expect(intake.conversation_config.agent.prompt.built_in_tools.end_call.params.system_tool_type).toBe("end_call");
    expect(intake.platform_settings.overrides.conversation_config_override.agent).toEqual({
      prompt: { prompt: true },
      first_message: true,
      language: true,
    });
    const init = conversationInit("intake", undefined, "case-9");
    expect(init.dynamic_variables.case_id).toBe("case-9");
    expect(init.conversation_config_override.agent.language).toBe("zh");
  });

  it("resamples PCM16", () => {
    const out = resamplePcm16(tone(1600, 500), 16000, 24000);
    expect(out.length).toBe(2400 * 2);
    expect(out.readInt16LE(100)).toBe(500);
  });

  it("gets a signed URL with the xi-api-key header", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ signed_url: "wss://signed" }), { status: 200 }));
    expect(await getSignedUrl("agent_adv", f as any)).toBe("wss://signed");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=agent_adv");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("k");
  });
});

describe("voice routes", () => {
  beforeEach(() => Object.assign(process.env, ENV));

  async function app() {
    const a = Fastify();
    await a.register(voiceRoutes);
    return a;
  }

  it("webhook tool route maps report_outcome → end_call and needs case_id", async () => {
    const a = await app();
    const c = patientCase();
    let r = await a.inject({ method: "POST", url: "/api/eleven/tools/log_offer", payload: { amount: 3000 } });
    expect(r.statusCode).toBe(400);
    r = await a.inject({ method: "POST", url: "/api/eleven/tools/log_offer", payload: { amount: 3000, case_id: c.id } });
    expect(r.json()).toMatchObject({ ok: true });
    r = await a.inject({ method: "POST", url: "/api/eleven/tools/report_outcome", payload: { outcome: "deal", amount: 3000, case_id: c.id } });
    expect(r.json()).toMatchObject({ ok: true, message: "Call ended with a deal." });
    expect(c.agreedAmount).toBe(3000);
    r = await a.inject({ method: "POST", url: "/api/eleven/tools/log_offer", payload: { amount: 1, case_id: "nope" } });
    expect(r.statusCode).toBe(404);
  });

  it("human negotiate returns the advocate signed URL + init; intake returns a signed URL", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (u: any) =>
      new Response(JSON.stringify({ signed_url: `wss://signed?${String(u).split("agent_id=")[1]}` }), { status: 200 }),
    ) as any;
    try {
      const a = await app();
      const c = patientCase();
      let r = await a.inject({ method: "POST", url: `/api/cases/${c.id}/negotiate`, payload: { counterparty: "human" } });
      const body = r.json();
      expect(body.mode).toBe("human");
      expect(body.advocateSignedUrl).toBe("wss://signed?agent_adv");
      expect(body.advocateInit.dynamic_variables.case_id).toBe(c.id);
      expect(c.status).toBe("negotiating");
      r = await a.inject({ method: "GET", url: `/api/intake/signed-url?case=${c.id}` });
      expect(r.json().signedUrl).toBe("wss://signed?agent_zh");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("missing ElevenLabs key is a loud error", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const a = await app();
    const r = await a.inject({ method: "GET", url: "/api/intake/signed-url" });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toMatch(/ELEVENLABS_API_KEY is not configured/);
  });
});
