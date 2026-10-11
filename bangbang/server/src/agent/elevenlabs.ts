// ElevenLabs Agents Platform (Conversational AI) glue: REST calls (signed URLs, agent + tool
// create/update) and PURE builders for agent configs and per-conversation initiation payloads.
//
// Verified against the live docs (2026-10-11):
//   - GET  /v1/convai/conversation/get-signed-url?agent_id=…  → {signed_url}     (header xi-api-key)
//   - POST /v1/convai/agents/create → {agent_id};  PATCH /v1/convai/agents/{agent_id}
//   - POST /v1/convai/tools {tool_config} → {id};  PATCH /v1/convai/tools/{id};  GET /v1/convai/tools
//   - WS   wss://api.elevenlabs.io/v1/convai/conversation?agent_id=… (or the signed URL). First client
//     message: {type:"conversation_initiation_client_data", conversation_config_override:{agent:{prompt:{prompt},
//     first_message, language}, tts:{voice_id}}, dynamic_variables:{…}}. Overrides only apply when the agent
//     enables them in platform_settings.overrides.conversation_config_override (same nesting, `true` flags).
//   - Built-in system tool `end_call` lives in conversation_config.agent.prompt.built_in_tools.end_call and
//     HANGS UP the call. Our own "report the outcome" tool therefore must NOT be named end_call (two functions
//     with one name). On the ElevenLabs side it is `report_outcome`; the server maps it back to the
//     handler's `end_call` (see elevenToolName/internalToolName).
import { need, opt } from "../env.js";
import type { CasePacket } from "../types.js";
import {
  advocateFirstMessage,
  advocatePrompt,
  hospitalFirstMessage,
  hospitalPrompt,
  insurerFirstMessage,
  insurerPrompt,
  intakeFirstMessage,
  intakePrompt,
} from "./prompts.js";
import { elevenClientTool, elevenWebhookTool, toolNamesFor, type AgentRole, type ToolName } from "./tools.js";

export const OUTCOME_TOOL = "report_outcome";

/** Name the tool has on the ElevenLabs side (avoids the built-in end_call system tool). */
export function elevenToolName(name: ToolName): string {
  return name === "end_call" ? OUTCOME_TOOL : name;
}

/** Name tools.ts handleTool understands. Accepts both report_outcome and the legacy end_call. */
export function internalToolName(name: string): string {
  return name === OUTCOME_TOOL ? "end_call" : name;
}

export function apiBase(): string {
  return (opt("ELEVENLABS_API_BASE", "https://api.elevenlabs.io") as string).replace(/\/$/, "");
}

export type FetchLike = typeof fetch;

async function eleven<T>(path: string, init: RequestInit = {}, f: FetchLike = fetch): Promise<T> {
  const key = need("ELEVENLABS_API_KEY");
  const res = await f(`${apiBase()}${path}`, {
    ...init,
    headers: { "xi-api-key": key, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ElevenLabs ${init.method ?? "GET"} ${path} failed ${res.status}: ${text.slice(0, 400)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** Stores only the gateway token in ElevenLabs, never the Anthropic API key. */
export async function createVoiceGatewaySecret(token: string, f: FetchLike = fetch): Promise<string> {
  const result = await eleven<{ secret_id?: string }>("/v1/convai/secrets", {
    method: "POST", body: JSON.stringify({ type: "new", name: "BangBang Voice Gateway", value: token }),
  }, f);
  if (!result.secret_id) throw new Error("ElevenLabs returned no secret_id");
  return result.secret_id;
}

// ---------- agent ids ----------
export type VoiceRole = "advocate" | "hospital" | "insurer" | "intake";

export function agentIdFor(role: VoiceRole): string {
  if (role === "advocate") return need("ELEVENLABS_ADVOCATE_AGENT_ID");
  if (role === "intake") return need("ELEVENLABS_INTAKE_AGENT_ID");
  // The insurer is the same counterparty agent with an insurer prompt override unless a dedicated one exists.
  if (role === "insurer") return opt("ELEVENLABS_INSURER_AGENT_ID") ?? need("ELEVENLABS_HOSPITAL_AGENT_ID");
  return need("ELEVENLABS_HOSPITAL_AGENT_ID");
}

/** Short-lived signed WebSocket URL for a private agent (browser or server connects with it). */
export async function getSignedUrl(agentId: string, f: FetchLike = fetch): Promise<string> {
  const r = await eleven<{ signed_url?: string }>(
    `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
    {},
    f,
  );
  if (!r.signed_url) throw new Error("ElevenLabs get-signed-url returned no signed_url");
  return r.signed_url;
}

// ---------- per-conversation initiation (overrides + dynamic variables) ----------
export type ConversationInit = {
  type: "conversation_initiation_client_data";
  conversation_config_override: {
    agent: { prompt: { prompt: string }; first_message?: string; language: "en" | "zh" };
    tts?: { voice_id: string };
  };
  dynamic_variables: Record<string, string | number | boolean>;
};

/** The outcome tool is report_outcome on ElevenLabs; rewrite T4's prompt text and explain hanging up. */
export function elevenizePrompt(prompt: string): string {
  return (
    prompt.replace(/\bend_call\b/g, OUTCOME_TOOL) +
    `\n\nTOOLS ON THIS CALL: record the final outcome with ${OUTCOME_TOOL} (outcome "deal" or "no_deal"). ` +
    `After ${OUTCOME_TOOL} and your goodbye, use the end_call system tool to hang up.`
  );
}

export function conversationInit(role: VoiceRole, packet: CasePacket | undefined, caseId?: string): ConversationInit {
  const dyn: Record<string, string> = { case_id: caseId ?? packet?.id ?? "" };
  if (role === "intake") {
    return {
      type: "conversation_initiation_client_data",
      conversation_config_override: { agent: { prompt: { prompt: intakePrompt() }, first_message: intakeFirstMessage(), language: "zh" } },
      dynamic_variables: dyn,
    };
  }
  if (!packet) throw new Error(`conversationInit(${role}) needs a case`);
  if (role === "advocate") {
    return {
      type: "conversation_initiation_client_data",
      // first_message "" = wait for the other side (the billing office answers the phone first)
      conversation_config_override: { agent: { prompt: { prompt: elevenizePrompt(advocatePrompt(packet)) }, first_message: "", language: "en" } },
      dynamic_variables: dyn,
    };
  }
  const prompt = role === "insurer" ? insurerPrompt(packet) : hospitalPrompt(packet);
  const first = role === "insurer" ? insurerFirstMessage(packet) : hospitalFirstMessage(packet);
  return {
    type: "conversation_initiation_client_data",
    conversation_config_override: { agent: { prompt: { prompt }, first_message: first, language: "en" } },
    dynamic_variables: dyn,
  };
}

/** Used when the advocate talks to a human in the browser: it should open, since the human waits. */
export function advocateInitForHuman(packet: CasePacket): ConversationInit {
  const init = conversationInit("advocate", packet);
  init.conversation_config_override.agent.first_message = advocateFirstMessage(packet);
  return init;
}

// ---------- agent configs (setup script) ----------
export type ToolMode = "client" | "webhook";

export function toolMode(): ToolMode {
  const m = opt("ELEVENLABS_TOOL_MODE");
  if (m === "webhook" || m === "client") return m;
  // client tools work without a public URL (the bridge answers them over the WebSocket, the browser forwards
  // them to /api/eleven/tools/:name); webhook tools need PUBLIC_URL reachable by ElevenLabs.
  return "client";
}

/** ElevenLabs tool_config for one of our tools in the given mode, with the end_call→report_outcome rename. */
export function toolConfig(name: ToolName, mode: ToolMode, baseUrl?: string): Record<string, unknown> {
  const eName = elevenToolName(name);
  if (mode === "client") return { ...elevenClientTool(name), name: eName };
  if (!baseUrl) throw new Error("PUBLIC_URL is not configured — set it (ngrok URL) for ELEVENLABS_TOOL_MODE=webhook");
  const t = elevenWebhookTool(name, baseUrl);
  const secret = opt("ELEVENLABS_TOOL_SECRET");
  return {
    ...t,
    name: eName,
    api_schema: {
      ...t.api_schema,
      url: `${baseUrl.replace(/\/$/, "")}/api/eleven/tools/${eName}`,
      ...(secret ? { request_headers: { "x-bangbang-secret": secret } } : {}),
    },
  };
}

export type AgentSpec = { role: "advocate" | "hospital" | "intake"; name: string; envVar: string; toolRole: AgentRole };
export const AGENTS: AgentSpec[] = [
  { role: "advocate", name: "BangBang Advocate (en)", envVar: "ELEVENLABS_ADVOCATE_AGENT_ID", toolRole: "advocate" },
  { role: "hospital", name: "BangBang Hospital Billing (en, demo counterparty)", envVar: "ELEVENLABS_HOSPITAL_AGENT_ID", toolRole: "hospital" },
  { role: "intake", name: "BangBang Intake 帮帮 (zh)", envVar: "ELEVENLABS_INTAKE_AGENT_ID", toolRole: "intake" },
];

// Premade voices (override with env). Intake uses a multilingual TTS model so it speaks natural Mandarin.
export function voiceFor(role: AgentSpec["role"]): string {
  if (role === "advocate") return opt("ELEVENLABS_ADVOCATE_VOICE_ID", "hpp4J3VqNfWAUOO0d1Us")!; // Bella, current premade voice
  if (role === "hospital") return opt("ELEVENLABS_HOSPITAL_VOICE_ID", "pNInz6obpgDQGcFmaJgB")!; // Adam
  return opt("ELEVENLABS_INTAKE_VOICE_ID", "EXAVITQu4vr4xnAvoBy")!; // Sarah (multilingual)
}

/** Placeholder prompts — the real per-case prompts arrive as conversation overrides. */
const BASE_PROMPT: Record<AgentSpec["role"], string> = {
  advocate:
    "You are BangBang, an AI patient advocate negotiating a hospital bill in English. Your full case brief is supplied when the call starts.",
  hospital:
    "You are a hospital patient-accounts representative (a demo persona). Your full case brief is supplied when the call starts.",
  intake: intakePrompt(),
};

export function agentConfig(spec: AgentSpec, toolIds: string[]): Record<string, unknown> {
  const zh = spec.role === "intake";
  return {
    name: spec.name,
    tags: ["bangbang"],
    conversation_config: {
      agent: {
        first_message: zh ? intakeFirstMessage() : "",
        language: zh ? "zh" : "en",
        dynamic_variables: { dynamic_variable_placeholders: { case_id: "" } },
        prompt: {
          prompt: BASE_PROMPT[spec.role],
          llm: opt("ELEVENLABS_LLM", "gpt-4o"),
          tool_ids: toolIds,
          built_in_tools: { end_call: { type: "system", name: "end_call", description: "", params: { system_tool_type: "end_call" } } },
        },
      },
      tts: {
        voice_id: voiceFor(spec.role),
        // non-English agents need a multilingual model
        model_id: zh ? opt("ELEVENLABS_ZH_TTS_MODEL", "eleven_flash_v2_5") : opt("ELEVENLABS_TTS_MODEL", "eleven_flash_v2"),
        agent_output_audio_format: "pcm_16000",
      },
      asr: { user_input_audio_format: "pcm_16000" },
    },
    platform_settings: {
      overrides: {
        conversation_config_override: {
          agent: { prompt: { prompt: true }, first_message: true, language: true },
          tts: { voice_id: true },
        },
      },
    },
  };
}

// ---------- REST: tools + agents ----------
type ToolRow = { id: string; tool_config?: { name?: string } };

export async function upsertTool(config: Record<string, unknown>, existing: ToolRow[], f: FetchLike = fetch): Promise<string> {
  const hit = existing.find((t) => t.tool_config?.name === config.name);
  if (hit) {
    await eleven(`/v1/convai/tools/${hit.id}`, { method: "PATCH", body: JSON.stringify({ tool_config: config }) }, f);
    return hit.id;
  }
  const r = await eleven<{ id: string }>(`/v1/convai/tools`, { method: "POST", body: JSON.stringify({ tool_config: config }) }, f);
  return r.id;
}

export async function listTools(f: FetchLike = fetch): Promise<ToolRow[]> {
  const r = await eleven<{ tools?: ToolRow[] }>(`/v1/convai/tools`, {}, f);
  return r.tools ?? [];
}

/** PATCH the agent if `agentId` is given, else create it. Returns the agent id. */
export async function upsertAgent(config: Record<string, unknown>, agentId: string | undefined, f: FetchLike = fetch): Promise<string> {
  if (agentId) {
    await eleven(`/v1/convai/agents/${agentId}`, { method: "PATCH", body: JSON.stringify(config) }, f);
    return agentId;
  }
  const r = await eleven<{ agent_id: string }>(`/v1/convai/agents/create`, { method: "POST", body: JSON.stringify(config) }, f);
  return r.agent_id;
}

export function toolNamesForSpec(spec: AgentSpec): ToolName[] {
  return toolNamesFor(spec.toolRole);
}

// ---------- audio ----------
/** "pcm_16000" → 16000. Only PCM16 is supported by the bridge (agents are configured for pcm_16000). */
export function pcmRate(format: string | undefined, fallback = 16000): number {
  if (!format) return fallback;
  const m = /^pcm_(\d+)$/.exec(format);
  if (!m) throw new Error(`unsupported ElevenLabs audio format ${format} — configure the agent for pcm_16000`);
  return Number(m[1]);
}

/** Linear-interpolation resample of mono PCM16 little-endian. */
export function resamplePcm16(buf: Buffer, from: number, to: number): Buffer {
  if (from === to || buf.length < 2) return buf;
  const n = Math.floor(buf.length / 2);
  const outN = Math.max(1, Math.round((n * to) / from));
  const out = Buffer.alloc(outN * 2);
  for (let i = 0; i < outN; i++) {
    const pos = (i * from) / to;
    const i0 = Math.min(n - 1, Math.floor(pos));
    const i1 = Math.min(n - 1, i0 + 1);
    const t = pos - i0;
    const s = buf.readInt16LE(i0 * 2) * (1 - t) + buf.readInt16LE(i1 * 2) * t;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s))), i * 2);
  }
  return out;
}
