// Explicit setup checks. No call dispatch, Claude requests, or account changes.
import { need, opt } from "../env.js";
import { apiBase, type FetchLike } from "./elevenlabs.js";
import { resolveSpeechProfile, speechSmokeText } from "./speech.js";

type Check = { ok: boolean; status?: number; detail: string };
class SetupCheckError extends Error {}

async function request(path: string, init: RequestInit, f: FetchLike): Promise<Response> {
  return f(`${apiBase()}${path}`, {
    ...init,
    headers: { "xi-api-key": need("ELEVENLABS_API_KEY"), "content-type": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
}

function failure(status: number): string {
  if (status === 401) return "API key was rejected or lacks the required endpoint permission.";
  if (status === 402) return "Selected voice or feature requires a paid plan or credits; try an included premade voice.";
  if (status === 403) return "Account or key permissions do not allow this operation.";
  if (status === 404) return "The configured resource was not found.";
  if (status === 429) return "Provider rate or quota limit reached; retry the check later.";
  return `Provider returned HTTP ${status}.`;
}

/** Read-only probes work before Claude, a public URL, or a phone number is configured. */
export async function checkElevenLabsConnection(f: FetchLike = fetch) {
  need("ELEVENLABS_API_KEY");
  const speech = resolveSpeechProfile();
  const voiceId = speech.voiceId;
  const agentId = opt("ELEVENLABS_OUTBOUND_AGENT_ID");
  const probes = {
    voice: {
      path: `/v1/voices/${encodeURIComponent(voiceId)}`,
      describe: () => `Selected voice ${voiceId} is accessible.`,
    },
    agents: {
      path: agentId ? `/v1/convai/agents/${encodeURIComponent(agentId)}` : "/v1/convai/agents?page_size=1",
      describe: () => agentId ? "Configured outbound agent is accessible." : "Agent API is accessible; outbound agent is not configured yet.",
    },
    phoneNumbers: {
      path: "/v1/convai/v2/phone-numbers?provider=twilio&supports_outbound=true&page_size=100",
      describe: (data: { phone_numbers?: Array<{ phone_number_id?: string }>; has_more?: boolean }) => {
        if (!Array.isArray(data.phone_numbers)) throw new Error("Invalid phone inventory response");
        const configured = opt("ELEVENLABS_PHONE_NUMBER_ID");
        const present = data.phone_numbers.some((number) => number.phone_number_id === configured);
        return `${data.phone_numbers.length}${data.has_more ? "+" : ""} outbound Twilio numbers visible. ` +
          (configured ? (present ? "Configured number is present." : "Configured number was not found on this page.") : "No number configured locally.");
      },
    },
  };
  const checks = Object.fromEntries(await Promise.all(Object.entries(probes).map(async ([name, probe]) => {
    let check: Check;
    try {
      const response = await request(probe.path, {}, f);
      if (!response.ok) {
        await response.body?.cancel();
        check = { ok: false, status: response.status, detail: failure(response.status) };
      } else {
        check = { ok: true, status: response.status, detail: probe.describe(await response.json()) };
      }
    } catch {
      // Never log provider bodies, headers, transcripts, or raw transport errors (may contain secrets).
      check = { ok: false, detail: "Connection timed out, failed, or returned an unexpected response." };
    }
    return [name, check];
  }))) as Record<keyof typeof probes, Check>;
  return {
    checkedAt: new Date().toISOString(),
    connected: Object.values(checks).every((check) => check.ok),
    speech,
    checks,
    callsReady: false,
    note: "API access only. Selected model synthesis, phone routing, Claude, shared memory, and full call latency are not verified by this check. Run --smoke-test to test the selected model and voice.",
  };
}

/** One short, synthetic TTS request. Explicitly invoked; uses credits but never places a call. */
export async function smokeTestElevenLabs(f: FetchLike = fetch) {
  need("ELEVENLABS_API_KEY");
  const speech = resolveSpeechProfile();
  const started = performance.now();
  let firstAudioByteMs: number | undefined;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    const response = await request(`/v1/text-to-speech/${encodeURIComponent(speech.voiceId)}/stream?output_format=mp3_44100_128`, {
      method: "POST",
      body: JSON.stringify({ text: speechSmokeText(speech), model_id: speech.model, voice_settings: { stability: 0.5, speed: 1 } }),
    }, f);
    if (!response.ok) {
      await response.body?.cancel();
      throw new SetupCheckError(failure(response.status));
    }
    if (!response.headers.get("content-type")?.startsWith("audio/") || !response.body) {
      await response.body?.cancel();
      throw new SetupCheckError("Provider did not return an audio stream.");
    }
    const reader = response.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!chunk.value.length) continue;
        firstAudioByteMs ??= Math.round(performance.now() - started);
        bytes += chunk.value.length;
        if (bytes > 2_000_000) throw new SetupCheckError("Audio sample exceeded the expected size.");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (firstAudioByteMs === undefined) throw new SetupCheckError("Provider returned an empty audio stream.");
  } catch (error) {
    // Only our fixed diagnostics leave this boundary; provider error payloads may echo credentials.
    throw new Error(error instanceof SetupCheckError ? error.message : "ElevenLabs speech request timed out or failed.");
  }
  return { audio: Buffer.concat(chunks), voiceId: speech.voiceId, voiceName: speech.voiceName, modelId: speech.model, firstAudioByteMs,
    totalMs: Math.round(performance.now() - started), bytes };
}
