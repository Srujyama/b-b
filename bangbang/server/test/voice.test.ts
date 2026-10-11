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
import { checkElevenLabsConnection, smokeTestElevenLabs } from "../src/agent/connection.js";
import { resolveSpeechProfile, speechInstructions, speechSmokeText } from "../src/agent/speech.js";

describe("ElevenLabs connection setup", () => {
  beforeEach(() => {
    vi.stubEnv("ELEVENLABS_API_KEY", "secret-test-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("PUBLIC_URL", "");
    vi.stubEnv("ELEVENLABS_OUTBOUND_AGENT_ID", "");
    vi.stubEnv("ELEVENLABS_PHONE_NUMBER_ID", "");
    vi.stubEnv("ELEVENLABS_ADVOCATE_VOICE_ID", "");
    vi.stubEnv("VOICE_TTS_MODEL", "");
    vi.stubEnv("VOICE_VOICE_PRESET", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("checks scoped API access without Claude, public URLs, phone numbers, or writes", async () => {
    const f = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.method ?? "GET").toBe("GET");
      expect(init.headers).toHaveProperty("xi-api-key", "secret-test-key");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return Response.json(url.includes("phone-numbers") ? { phone_numbers: [], has_more: false } : {});
    });
    const result = await checkElevenLabsConnection(f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(3);
    expect(result.connected).toBe(true);
    expect(result.callsReady).toBe(false);
    expect(result.checks.voice.detail).toContain("hpp4J3VqNfWAUOO0d1Us");
    expect(result.checks.phoneNumbers.detail).toContain("0 outbound Twilio numbers");
  });

  it("reports partial failures without reflecting secrets in provider bodies or transport errors", async () => {
    const f = vi.fn(async (url: string) => {
      if (url.includes("/voices/")) return Response.json({ detail: "secret-test-key" }, { status: 401 });
      if (url.includes("/agents")) throw new Error("URL contained secret-test-key");
      return Response.json({ phone_numbers: [] });
    });
    const result = await checkElevenLabsConnection(f as unknown as typeof fetch);
    expect(result.connected).toBe(false);
    expect(result.checks.voice.status).toBe(401);
    expect(result.checks.phoneNumbers.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret-test-key");
  });

  it("collects streamed v4 Turbo audio with a synthetic greeting and a purposeful pause", async () => {
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({ text: speechSmokeText(resolveSpeechProfile()), model_id: "eleven_v4_turbo", voice_settings: { stability: 0.5, speed: 1 } });
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array());
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      } }), { headers: { "content-type": "audio/mpeg" } });
    });
    const result = await smokeTestElevenLabs(f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(1);
    expect(result.audio).toEqual(Buffer.from([1, 2, 3]));
    expect(result.bytes).toBe(3);
    expect(result.firstAudioByteMs).toBeGreaterThanOrEqual(0);
    expect(result.totalMs).toBeGreaterThanOrEqual(result.firstAudioByteMs!);
  });

  it("uses the chosen voice/model in smoke tests and omits tags for Flash", async () => {
    vi.stubEnv("VOICE_TTS_MODEL", "eleven_flash_v2_5");
    vi.stubEnv("VOICE_VOICE_PRESET", "river");
    const f = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain("SAz9YHcvj6GT2YYXdXww");
      const request = JSON.parse(init.body as string);
      expect(request.model_id).toBe("eleven_flash_v2_5");
      expect(request.text).not.toMatch(/\[.*\]/);
      return new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } });
    });
    expect((await smokeTestElevenLabs(f as unknown as typeof fetch)).voiceName).toBe("River");
  });

  it("rejects unknown configuration and gives an explicit task choice precedence over custom voice IDs", () => {
    vi.stubEnv("ELEVENLABS_ADVOCATE_VOICE_ID", "custom-voice");
    expect(resolveSpeechProfile().voiceId).toBe("custom-voice");
    expect(resolveSpeechProfile({ voice: "eric" }).voiceId).toBe("cjVigY5qzO86Huf0OWal");
    vi.stubEnv("VOICE_TTS_MODEL", "invented-model");
    expect(() => resolveSpeechProfile()).toThrow("Unsupported VOICE_TTS_MODEL");
    expect(resolveSpeechProfile({ model: "eleven_v4" }).model).toBe("eleven_v4");
    vi.stubEnv("VOICE_VOICE_PRESET", "invented-voice");
    expect(() => resolveSpeechProfile({ model: "eleven_v4" })).toThrow("Unsupported VOICE_VOICE_PRESET");
  });

  it.each([
    ["HTTP error", () => Response.json({ detail: "secret-test-key" }, { status: 402 }), "requires a paid plan"],
    ["non-audio response", () => Response.json({ detail: "secret-test-key" }), "did not return an audio stream"],
    ["empty audio", () => new Response(new Uint8Array(), { headers: { "content-type": "audio/mpeg" } }), "empty audio stream"],
    ["transport error", () => { throw new Error("Provider returned HTTP secret-test-key"); }, "timed out or failed"],
  ] as const)("rejects %s without exposing raw diagnostics or retrying", async (_name, response, message) => {
    const f = vi.fn(async () => response());
    await expect(smokeTestElevenLabs(f as unknown as typeof fetch)).rejects.toThrow(message);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

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

// Branch A: real phone worker, native Haiku streaming, and orchestrator-owned context.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { anthropicRequest, completionChunks } from "../src/agent/haiku.js";
import { outboundAgentConfig, validateVoicePlan, type VoicePlan } from "../src/agent/call-plan.js";
import { CallJobStore, runVoiceTask, syncVoiceTask, verifyWebhook } from "../src/agent/calls.js";
import { configureVoiceContext } from "../src/agent/shared-context.js";

const voicePlan = (): VoicePlan => ({
  version: "1", jobId: "job-1", caseId: "case-1", planId: "plan-1", stepId: "call-billing",
  client: { name: "Test Client", authorization: { confirmed: true, reference: "consent-1" } },
  target: { name: "Example Billing", phone: "+14155550123" }, objective: "Request an itemized bill and nonbinding proposal",
  steps: ["Confirm the billing department", "Ask for an itemized bill"], facts: ["The client disputes a duplicate charge."],
  constraints: { maxOfferUsd: 2500, forbiddenActions: ["Do not accept a binding settlement"] },
});
const eventStream = (events: unknown[], fragment = false) => {
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""));
  return new ReadableStream<Uint8Array>({ start(controller) {
    if (fragment) for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
    else controller.enqueue(bytes);
    controller.close();
  } });
};
const spokenEvents = [
  { type: "message_start", message: { id: "msg-1" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello 您好" } },
  { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" },
];
const conversation = (extra: Record<string, unknown> = {}) => ({
  agent_id: "outbound-agent", conversation_id: "conv-1", status: "done",
  conversation_initiation_client_data: { dynamic_variables: { job_id: "job-1" } },
  transcript: [{ role: "agent", message: "I will bring this proposal to my client.", time_in_call_secs: 20 }],
  analysis: { transcript_summary: "Office proposed a discount.", call_successful: "success",
    data_collection_results: { proposal: { value: "$2,000 pending client approval" }, next_steps: { value: "Send authorization" } } },
  metadata: { call_duration_secs: 30 }, ...extra,
});

describe("native Haiku voice stream", () => {
  beforeEach(() => { vi.stubEnv("VOICE_TTS_MODEL", ""); vi.stubEnv("VOICE_VOICE_PRESET", ""); });
  afterEach(() => vi.unstubAllEnvs());
  it("gives Haiku bounded v4 delivery instructions matched to the selected model", () => {
    const input = { stream: true, messages: [{ role: "user", content: "Confirm the amount." }] };
    for (const model of ["eleven_v4_turbo", "eleven_v4"] as const) {
      const payload = anthropicRequest(input, resolveSpeechProfile({ model }));
      const instructions = payload.system![0].text;
      expect(instructions).toContain(`active speech engine: ${model}`);
      expect(instructions).toContain("at most one [pause]");
      expect(instructions).toContain("Never start or end with a pause");
      expect(instructions).toContain("Use at most one [slow]");
      expect(instructions).toContain("under 35 spoken words");
      expect(payload.max_tokens).toBe(512);
    }
    const flash = speechInstructions(resolveSpeechProfile({ model: "eleven_flash_v2_5" }));
    expect(flash).toContain("plain spoken text");
    expect(flash).not.toContain("[pause]");
    expect(flash).not.toContain("[slow]");
  });
  it("maps greeting, function calls and results to native Messages with caching and no sampling fields", () => {
    const payload = anthropicRequest({ stream: true, messages: [
      { role: "system", content: "You represent a client." }, { role: "assistant", content: "Hello" },
      { role: "user", content: "Please wait" },
      { role: "assistant", tool_calls: [{ id: "t1", type: "function", function: { name: "skip_turn", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "t1", content: "ok" },
    ], tools: [{ type: "function", function: { name: "skip_turn", parameters: { type: "object" } } }] });
    expect(payload.model).toBe("claude-haiku-5-5");
    expect(payload.thinking).toEqual({ type: "disabled" });
    expect(payload).not.toHaveProperty("temperature");
    expect(payload.system?.[0].cache_control).toEqual({ type: "ephemeral" });
    expect(payload.messages[0].role).toBe("user");
    expect(payload.messages.at(-1)?.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1" });
    expect(() => anthropicRequest({ stream: false, messages: [] })).toThrow();
  });
  it("streams split Unicode SSE frames without buffering a complete response", async () => {
    const first = vi.fn();
    const chunks: string[] = [];
    for await (const c of completionChunks(eventStream(spokenEvents, true), first)) chunks.push(c);
    expect(chunks.join("")).toContain("Hello 您好");
    expect(chunks.at(-1)).toBe("data: [DONE]\n\n");
    expect(first).toHaveBeenCalledOnce();
  });
  it("emits useful words before later speech tags arrive and preserves fragmented tags", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    const send = (event: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    const iterator = completionChunks(body);
    send(spokenEvents[0]);
    await iterator.next();
    send({ type: "content_block_delta", delta: { type: "text_delta", text: "Thank you. " } });
    expect((await iterator.next()).value).toContain("Thank you.");
    for (const text of ["[pa", "use] Could you send that in writing?"])
      send({ type: "content_block_delta", delta: { type: "text_delta", text } });
    send(spokenEvents[2]); send(spokenEvents[3]); controller.close();
    let delivered = "";
    for await (const chunk of iterator) {
      if (!chunk.includes("[DONE]")) delivered += JSON.parse(chunk.slice(6)).choices[0].delta.content ?? "";
    }
    expect(delivered).toBe("[pause] Could you send that in writing?");
  });
  it("maps native tool-use blocks to OpenAI tool-call deltas", async () => {
    const events = [
      spokenEvents[0], { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t2", name: "end_call" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"reason":"done"}' } },
      { type: "message_delta", delta: { stop_reason: "tool_use" } }, { type: "message_stop" },
    ];
    const chunks: string[] = [];
    for await (const c of completionChunks(eventStream(events))) chunks.push(c);
    expect(chunks.join("")).toContain('"name":"end_call"');
    expect(chunks.join("")).toContain('"finish_reason":"tool_calls"');
  });
  it("does not mark a truncated upstream stream successful", async () => {
    const chunks: string[] = [];
    await expect((async () => { for await (const c of completionChunks(eventStream(spokenEvents.slice(0, 2)))) chunks.push(c); })())
      .rejects.toThrow("message_stop");
    expect(chunks.join("")).not.toContain("[DONE]");
  });
  it("does not claim success if the voice response exceeds its token budget", async () => {
    await expect((async () => {
      for await (const _ of completionChunks(eventStream([{ type: "message_delta", delta: { stop_reason: "max_tokens" } }]))) { /* drain */ }
    })()).rejects.toThrow("token limit");
  });
});

describe("outbound voice worker", () => {
  let directory: string;
  let app: ReturnType<typeof Fastify>;
  let providerFetch: ReturnType<typeof vi.fn>;
  const auth = { authorization: "Bearer orchestrator-test" };
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "bb-voice-test-"));
    const config = {
      ELEVENLABS_API_KEY: "eleven-test", ANTHROPIC_API_KEY: "anthropic-test", ELEVENLABS_OUTBOUND_AGENT_ID: "outbound-agent",
      ELEVENLABS_PHONE_NUMBER_ID: "phone-1", VOICE_ORCHESTRATOR_TOKEN: "orchestrator-test", VOICE_LLM_TOKEN: "gateway-test",
      VOICE_JOB_DIR: directory, PUBLIC_URL: "https://voice.example", VOICE_CALLS_ENABLED: "true",
      VOICE_ALLOWED_NUMBERS: "+14155550123", ELEVENLABS_WEBHOOK_SECRET: "webhook-test",
      VOICE_TTS_MODEL: "", VOICE_VOICE_PRESET: "", ELEVENLABS_ADVOCATE_VOICE_ID: "",
    };
    for (const [key, value] of Object.entries(config)) vi.stubEnv(key, value);
    providerFetch = vi.fn(async () => new Response(JSON.stringify({ success: true, conversation_id: "conv-1", callSid: "CA-test" })));
    vi.stubGlobal("fetch", providerFetch);
    app = Fastify();
    await app.register(voiceRoutes);
  });
  afterEach(async () => {
    configureVoiceContext(undefined);
    await app.close();
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });
  const signed = (body: string, timestamp = Math.floor(Date.now() / 1000)) => `t=${timestamp},v0=${createHmac("sha256", "webhook-test").update(`${timestamp}.${body}`).digest("hex")}`;
  const submit = (a: typeof app, plan = voicePlan()) => a.inject({ method: "POST", url: "/api/voice/jobs", headers: auth, payload: plan });

  it("requires orchestrator auth and rejects absent client authorization without dialing", async () => {
    const missing = await app.inject({ method: "POST", url: "/api/voice/jobs", payload: voicePlan() });
    expect(missing.statusCode).toBe(401);
    const plan = voicePlan(); (plan.client.authorization.confirmed as boolean) = false;
    expect((await submit(app, plan)).statusCode).toBe(400);
    expect(providerFetch).not.toHaveBeenCalled();
  });
  it("previews a representative brief without keys or external side effects", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    const r = await app.inject({ method: "POST", url: "/api/voice/jobs/preview", headers: auth, payload: voicePlan() });
    expect(r.json()).toMatchObject({ dryRun: true, dialed: false });
    expect(r.body).toContain("NO authority to accept a binding settlement");
    expect(r.body).toContain("maxOfferUsd");
    expect(providerFetch).not.toHaveBeenCalled();
  });
  it("offers authenticated choices and previews a selected voice/model without dialing", async () => {
    expect((await app.inject({ url: "/api/voice/options" })).statusCode).toBe(401);
    const choices = (await app.inject({ url: "/api/voice/options", headers: auth })).json();
    expect(choices.default.model).toBe("eleven_v4_turbo");
    expect(choices.voices.map((voice: { id: string }) => voice.id)).toEqual(["bella", "river", "eric"]);
    const plan = { ...voicePlan(), speech: { model: "eleven_v4", voice: "river" } };
    const preview = (await app.inject({ method: "POST", url: "/api/voice/jobs/preview", headers: auth, payload: plan })).json();
    expect(preview.speech).toMatchObject({ model: "eleven_v4", voiceName: "River" });
    expect(preview.initiation.conversation_config_override.tts).toMatchObject({ model_id: "eleven_v4", voice_id: "SAz9YHcvj6GT2YYXdXww" });
    expect(preview.deliveryInstructions).toContain("at most one [pause]");
    expect(providerFetch).not.toHaveBeenCalled();
  });
  it("rejects invalid speech selections at HTTP and direct-function boundaries", async () => {
    for (const speech of [{ model: "eleven_v9" }, { voice: "unknown" }, { speed: 10 }, null]) {
      const plan = { ...voicePlan(), speech } as unknown as VoicePlan;
      expect((await submit(app, plan)).statusCode).toBe(400);
      expect(() => validateVoicePlan(plan)).toThrow();
    }
    expect(providerFetch).not.toHaveBeenCalled();
  });
  it("persists speech selection, rejects changes on retry, and keeps gateway instructions stable after env changes", async () => {
    const plan: VoicePlan = { ...voicePlan(), speech: { model: "eleven_v4", voice: "eric" } };
    const job = (await submit(app, plan)).json();
    expect(job.speech).toMatchObject({ model: "eleven_v4", voiceName: "Eric" });
    const dial = JSON.parse(providerFetch.mock.calls[0][1].body);
    expect(dial.conversation_initiation_client_data.conversation_config_override.tts).toMatchObject({ model_id: "eleven_v4", voice_id: job.speech.voiceId });
    expect((await submit(app, { ...plan, speech: { voice: "river" } })).statusCode).toBe(409);
    vi.stubEnv("VOICE_TTS_MODEL", "invalid-new-default");
    providerFetch.mockResolvedValueOnce(new Response(eventStream(spokenEvents)));
    const r = await app.inject({ method: "POST", url: "/api/voice/llm/v1/chat/completions", headers: { authorization: "Bearer gateway-test" },
      payload: { stream: true, voice_job_id: job.jobId, messages: [{ role: "user", content: "Hello" }] } });
    expect(r.statusCode).toBe(200);
    const llm = JSON.parse(providerFetch.mock.calls.at(-1)![1].body);
    expect(llm.system[0].text).toContain("active speech engine: eleven_v4.");
    expect(new CallJobStore(directory).get(job.jobId)?.speech).toEqual(job.speech);
  });
  it("keeps legacy journal calls tag-free because they were dispatched with Flash", async () => {
    await submit(app);
    const store = new CallJobStore(directory), job = store.get("job-1")!;
    delete job.speech; store.save(job);
    providerFetch.mockResolvedValueOnce(new Response(eventStream(spokenEvents)));
    await app.inject({ method: "POST", url: "/api/voice/llm/v1/chat/completions", headers: { authorization: "Bearer gateway-test" },
      payload: { stream: true, voice_job_id: job.jobId, messages: [{ role: "user", content: "Hello" }] } });
    const llm = JSON.parse(providerFetch.mock.calls.at(-1)![1].body);
    expect(llm.system[0].text).toContain("plain spoken text");
    expect(llm.system[0].text).not.toContain("[pause]");
  });
  it("blocks calls until config, live switch and destination allowlist permit them", async () => {
    vi.stubEnv("VOICE_CALLS_ENABLED", "false");
    expect((await submit(app)).statusCode).toBe(503);
    vi.stubEnv("VOICE_CALLS_ENABLED", "true"); vi.stubEnv("VOICE_ALLOWED_NUMBERS", "+14155550999");
    expect((await submit(app)).statusCode).toBe(403);
    vi.stubEnv("VOICE_ALLOWED_NUMBERS", ""); // fail closed: live calls with no allowlist never dial
    expect((await submit(app)).statusCode).toBe(403);
    vi.stubEnv("VOICE_ALLOWED_NUMBERS", "+14155550123"); vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect((await submit(app)).statusCode).toBe(503);
    expect(providerFetch).not.toHaveBeenCalled();
  });
  it("dials once for simultaneous identical jobs and persists idempotency across store instances", async () => {
    const responses = await Promise.all([submit(app), submit(app)]);
    expect(responses.map((r) => r.statusCode)).toEqual([202, 202]);
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(new CallJobStore(directory).get("job-1")).toMatchObject({ status: "submitted", conversationId: "conv-1" });
    expect((await submit(app)).json().conversationId).toBe("conv-1");
    expect(providerFetch).toHaveBeenCalledOnce();
    const sent = JSON.parse(providerFetch.mock.calls[0][1].body);
    expect(sent).toMatchObject({ agent_phone_number_id: "phone-1", to_number: "+14155550123", call_recording_enabled: false });
    expect(sent.conversation_initiation_client_data.custom_llm_extra_body).toEqual({ voice_job_id: "job-1" });
  });
  it("rejects changed job content and a second active job for the same case", async () => {
    await submit(app);
    const changed = voicePlan(); changed.objective = "Different task";
    expect((await submit(app, changed)).statusCode).toBe(409);
    changed.jobId = "job-2";
    expect((await submit(app, changed)).statusCode).toBe(409);
    expect(providerFetch).toHaveBeenCalledOnce();
  });
  it("keeps uncertain dispatches for reconciliation and never automatically redials", async () => {
    providerFetch.mockRejectedValueOnce(new Error("network timeout"));
    expect((await submit(app)).json().status).toBe("unknown");
    expect((await submit(app)).json().status).toBe("unknown");
    expect(providerFetch).toHaveBeenCalledOnce();
    providerFetch.mockResolvedValueOnce(new Response(JSON.stringify(conversation())));
    const r = await app.inject({ method: "POST", url: "/api/voice/jobs/job-1/reconcile", headers: auth, payload: { conversationId: "conv-1" } });
    expect(r.json().status).toBe("completed");
  });
  it("polls completed calls into evidence requiring review, without accepting an offer", async () => {
    await submit(app);
    providerFetch.mockResolvedValueOnce(new Response(JSON.stringify(conversation())));
    const r = await app.inject({ method: "POST", url: "/api/voice/jobs/job-1/refresh", headers: auth });
    expect(r.json()).toMatchObject({ status: "completed", result: { requiresReview: true, proposal: "$2,000 pending client approval" } });
    expect(r.json()).not.toHaveProperty("agreedAmount");
  });
  it("rejects bad webhook signatures and applies authentic callbacks idempotently", async () => {
    await submit(app);
    const body = JSON.stringify({ type: "post_call_transcription", data: conversation() });
    const send = (signature: string) => app.inject({ method: "POST", url: "/api/voice/webhooks/elevenlabs",
      headers: { "content-type": "application/json", "elevenlabs-signature": signature }, payload: body });
    expect((await send("bad")).statusCode).toBe(401);
    expect((await send(signed(body))).statusCode).toBe(200);
    const original = new CallJobStore(directory).get("job-1");
    expect((await send(signed(body))).statusCode).toBe(200);
    expect(new CallJobStore(directory).get("job-1")).toEqual(original);
    expect(() => verifyWebhook(Buffer.from(body), signed(body, 1), "webhook-test")).toThrow("expired");
  });
  it("records busy/no-answer failures and rejects a callback for a different agent", async () => {
    await submit(app);
    const send = (data: unknown) => {
      const body = JSON.stringify({ type: "call_initiation_failure", data });
      return app.inject({ method: "POST", url: "/api/voice/webhooks/elevenlabs", headers: {
        "content-type": "application/json", "elevenlabs-signature": signed(body),
      }, payload: body });
    };
    expect((await send(conversation({ agent_id: "wrong" }))).statusCode).toBe(409);
    expect((await send(conversation({ failure_reason: "busy" }))).statusCode).toBe(200);
    expect(new CallJobStore(directory).get("job-1")).toMatchObject({ status: "failed", error: "busy" });
  });
  it("uses direct orchestrator references, reads live memory each turn and writes results back", async () => {
    let authorized = true;
    const read = vi.fn(async () => ({ revision: "r2", facts: ["Updated shared fact"], notes: [], authorized }));
    const writeResult = vi.fn(async () => {});
    configureVoiceContext({ resolveTask: async () => voicePlan(), read, writeResult });
    const plan = voicePlan();
    expect((await runVoiceTask(plan)).status).toBe("submitted");
    providerFetch.mockResolvedValueOnce(new Response(eventStream(spokenEvents)));
    const llm = () => app.inject({ method: "POST", url: "/api/voice/llm/v1/chat/completions",
      headers: { authorization: "Bearer gateway-test" }, payload: { stream: true, voice_job_id: "job-1", messages: [
        { role: "system", content: "Stable instructions" }, { role: "user", content: "What next?" },
      ] } });
    const response = await llm();
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("[DONE]");
    const request = JSON.parse(providerFetch.mock.calls.at(-1)![1].body);
    expect(request.messages.at(-1).content[0].text).toContain("Updated shared fact");
    authorized = false;
    providerFetch.mockResolvedValueOnce(new Response(eventStream(spokenEvents)));
    await llm();
    expect(JSON.parse(providerFetch.mock.calls.at(-1)![1].body).messages.at(-1).content[0].text).toContain("authorization has been revoked");
    providerFetch.mockResolvedValueOnce(new Response(JSON.stringify(conversation())));
    await syncVoiceTask("job-1");
    expect(writeResult).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-1" }), expect.objectContaining({ requiresReview: true }));
  });
  it("blocks a revoked shared authorization before dialing", async () => {
    configureVoiceContext({ resolveTask: async () => voicePlan(), read: async () => ({ revision: "r3", facts: [], notes: [], authorized: false }), writeResult: async () => {} });
    await expect(runVoiceTask(voicePlan())).rejects.toThrow("revoked");
    expect(providerFetch).not.toHaveBeenCalled();
  });
  it("requires a separate gateway token and never exposes Anthropic provider error bodies", async () => {
    const payload = { stream: true, messages: [{ role: "user", content: "Hello" }] };
    expect((await app.inject({ method: "POST", url: "/api/voice/llm/v1/chat/completions", headers: auth, payload })).statusCode).toBe(401);
    providerFetch.mockResolvedValueOnce(new Response("sensitive provider diagnostic", { status: 401 }));
    const r = await app.inject({ method: "POST", url: "/api/voice/llm/v1/chat/completions", headers: { authorization: "Bearer gateway-test" }, payload });
    expect(r.statusCode).toBe(502);
    expect(r.body).not.toContain("sensitive");
  });
  it("configures v4 Turbo, voice/model overrides, a protected Haiku gateway, IVR tools and no settlement tools", () => {
    const config = outboundAgentConfig("https://voice.example", "secret-1");
    expect(config.conversation_config.agent.prompt.custom_llm.model_id).toBe("claude-haiku-5-5");
    expect(config.conversation_config.tts.model_id).toBe("eleven_v4_turbo");
    expect(config.conversation_config.tts.expressive_mode).toBe(true);
    expect(config.platform_settings.overrides.conversation_config_override.tts).toMatchObject({ model_id: true, voice_id: true });
    expect(config.conversation_config.agent.prompt.tool_ids).toEqual([]);
    expect(config.conversation_config.agent.prompt.built_in_tools).toHaveProperty("play_keypad_touch_tone");
    expect(JSON.stringify(config)).not.toContain("anthropic-test");
  });
});
