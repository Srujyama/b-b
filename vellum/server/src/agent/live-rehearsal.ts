// Explicit live smoke test: synthetic microphone -> ElevenLabs ASR -> Haiku -> v4 audio -> saved transcript.
// Run from server/: node --import tsx src/agent/live-rehearsal.ts <synthetic-case-id>
// Uses provider credits. Never dials a phone, accesses a microphone, or executes negotiation tools.
import "dotenv/config";
import WebSocket from "ws";
import { need, opt } from "../env.js";

const caseId = process.argv[2];
if (!caseId || !/^[\w-]+$/.test(caseId)) throw new Error("Pass a synthetic demo case ID");
const origin = new URL(opt("LIVE_DEMO_URL", "http://127.0.0.1:8787")!);
if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(origin.hostname)))
  throw new Error("LIVE_DEMO_URL must use HTTPS, or local HTTP");

async function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(new URL(path, origin), {
    method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Demo API returned HTTP ${response.status}`);
  return response.json();
}

const c = await request(`/api/cases/${caseId}`);
if (c.patient?.name !== "Lin Mei (林美)" || c.patient?.consent !== true)
  throw new Error("Use the consenting Lin Mei synthetic demo fixture only");
const inputText = "This is the simulated hospital billing desk. Which charge needs review, and what assistance should we check?";
const inputResponse = await fetch("https://api.elevenlabs.io/v1/text-to-speech/cjVigY5qzO86Huf0OWal?output_format=pcm_16000", {
  method: "POST", headers: { "xi-api-key": need("ELEVENLABS_API_KEY"), "content-type": "application/json" },
  body: JSON.stringify({ text: inputText, model_id: "eleven_flash_v2_5" }), signal: AbortSignal.timeout(20_000),
});
if (!inputResponse.ok) throw new Error(`Synthetic microphone generation failed: HTTP ${inputResponse.status}`);
const input = Buffer.from(await inputResponse.arrayBuffer());
const config = await request(`/api/cases/${caseId}/negotiate`, { counterparty: "human" });
config.advocateInit.conversation_config_override.agent.first_message = "";
const ws = new WebSocket(config.advocateSignedUrl);
let offset = 0, inputEnded = 0, audioBytes = 0, firstAudioAfterInputMs: number | undefined;
let recognized = 0, replies = 0, saved = 0;
let ticker: ReturnType<typeof setInterval> | undefined;
let finish: ReturnType<typeof setTimeout> | undefined;
const pending: Promise<unknown>[] = [];
const timeout = setTimeout(() => { process.exitCode = 1; ws.close(); }, 45_000);
const save = (role: string, text: string) => {
  pending.push(request(`/api/cases/${caseId}/voice/transcript`, { role, text, at: new Date().toISOString() }, {
    "x-voice-session": config.transcriptToken,
  }).then(() => { saved++; }).catch(() => { process.exitCode = 1; }));
};
ws.on("open", () => ws.send(JSON.stringify(config.advocateInit)));
ws.on("error", () => { console.error("Voice WebSocket transport failed"); process.exitCode = 1; });
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === "conversation_initiation_metadata") {
    if (m.conversation_initiation_metadata_event.user_input_audio_format !== "pcm_16000") {
      process.exitCode = 1; ws.close(); return;
    }
    ticker = setInterval(() => {
      const chunk = Buffer.alloc(3200);
      if (offset < input.length) {
        input.copy(chunk, 0, offset, offset + 3200); offset += 3200;
        if (offset >= input.length) inputEnded = Date.now();
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ user_audio_chunk: chunk.toString("base64") }));
    }, 100);
  }
  if (m.type === "ping") ws.send(JSON.stringify({ type: "pong", event_id: m.ping_event.event_id }));
  if (m.type === "user_transcript") {
    recognized++; save("hospital", m.user_transcription_event.user_transcript);
    console.log(JSON.stringify({ recognized: m.user_transcription_event.user_transcript }));
  }
  if (m.type === "agent_response") {
    replies++; save("advocate", m.agent_response_event.agent_response);
    console.log(JSON.stringify({ reply: m.agent_response_event.agent_response }));
    finish ??= setTimeout(() => ws.close(), 8000);
  }
  if (m.type === "audio") {
    audioBytes += Buffer.from(m.audio_event.audio_base_64, "base64").length;
    if (firstAudioAfterInputMs === undefined && inputEnded) firstAudioAfterInputMs = Date.now() - inputEnded;
  }
  if (m.type === "client_tool_call") ws.send(JSON.stringify({ type: "client_tool_result",
    tool_call_id: m.client_tool_call.tool_call_id, result: "Smoke test only: no state-changing tool is executed.", is_error: true }));
});
await new Promise<void>((resolve) => ws.on("close", async (code) => {
  clearTimeout(timeout); clearTimeout(finish); clearInterval(ticker);
  await Promise.all(pending);
  const ok = recognized > 0 && replies > 0 && audioBytes > 0 && saved >= 2 && !process.exitCode;
  console.log(JSON.stringify({ ok, closeCode: code, recognized, replies, saved, audioBytes, firstAudioAfterInputMs }));
  if (!ok) process.exitCode = 1;
  resolve();
}));
