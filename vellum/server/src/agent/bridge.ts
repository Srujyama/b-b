// Server-side agent-vs-agent audio bridge. Opens two ElevenLabs conversation WebSockets (our advocate
// and the hospital-billing / insurer counterparty) and makes each one the other's microphone:
//   agent A `audio` (PCM16, A's output rate) → resample → paced into agent B as `user_audio_chunk`
// Each leg's "microphone" is fed in real time (tickMs frames) with silence when nobody is talking,
// so ElevenLabs' VAD/turn-taking behaves exactly as it does with a human on a mic. Interruptions drop
// the interrupted agent's queued audio. Both voices are streamed to the browser over /ws as `audio`
// events; each agent's own words become transcript lines (translated to zh) on packet.transcript.
// Advocate tool calls (client tools) are answered here via tools.ts handleTool; webhook-mode calls hit
// routes/voice.ts, which reports back through notifyToolResult. The call stops on report_outcome,
// a hang-up (end_call system tool closes the socket), an error, or the timeout.
import WebSocket from "ws";
import { opt } from "../env.js";
import { browserDemoInit } from "./browser-demo.js";
import { hospitalDemoInit } from "./hospital-demo.js";
import { emit, requireCase, updateCase } from "../store.js";
import type { TranscriptLine } from "../types.js";
import { handleTool, type ToolResult } from "./tools.js";
import { translateLine } from "./translate.js";
import { startTextNegotiation, type TextOptions } from "./textNegotiation.js";
import { OUTCOME_TOOL, agentIdFor, conversationInit, getSignedUrl, internalToolName, pcmRate, resamplePcm16, type VoiceRole } from "./elevenlabs.js";

type Who = "advocate" | "hospital" | "insurer";

/** Minimal surface of a `ws` WebSocket we rely on (lets tests inject a fake). */
export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "open", cb: () => void): unknown;
  on(event: "message", cb: (data: unknown) => void): unknown;
  on(event: "close", cb: (code?: number, reason?: unknown) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
}

export type BridgeOptions = {
  connect?: (url: string) => WsLike;
  signedUrl?: (agentId: string) => Promise<string>;
  translate?: (text: string) => Promise<string>;
  tickMs?: number; // mic frame length (default 100ms)
  timeoutMs?: number; // hard stop (default 4 min)
  graceMs?: number; // let the goodbye play after the outcome (default 6s)
  wrapUpMs?: number; // tell the advocate to close out this long before the hard stop (default 45s)
  /** Provider failure (quota, auth, dropped connection). When set it replaces the `error` event, because the
   *  caller (startAgentBridge) is about to recover by falling back to a text negotiation. */
  onFailure?: (reason: string) => void;
};

export type StopReason = "outcome" | "hangup" | "timeout" | "error" | "stopped";

export type BridgeHandle = {
  caseId: string;
  counterparty: "hospital" | "insurer";
  /** How the call is running right now: an ElevenLabs voice call, or the live text negotiation fallback. */
  channel?: "voice" | "text";
  stop: (reason?: StopReason) => void;
  done: Promise<{ reason: StopReason }>;
};

type Leg = {
  who: Who;
  ws: WsLike;
  ready: boolean;
  outRate: number; // what this agent speaks
  inRate: number; // what this agent's mic expects
  mic: Buffer[]; // audio queued INTO this agent (from the other side)
  spoken: boolean; // has said anything yet
};

const bridges = new Map<string, BridgeHandle & { onTool: (name: string, r: ToolResult) => void }>();

const sessions = new Map<string, BridgeHandle>(); // startAgentBridge's voice-or-text sessions

export function activeBridge(caseId: string): BridgeHandle | undefined {
  return sessions.get(caseId) ?? bridges.get(caseId);
}

/** Webhook-mode tool calls land in routes/voice.ts; it tells the bridge so the call can wrap up. */
export function notifyToolResult(caseId: string, name: string, result: ToolResult) {
  bridges.get(caseId)?.onTool(internalToolName(name), result);
}

/**
 * A provider-side failure behind a WebSocket close, or undefined for an ordinary hang-up. ElevenLabs closes
 * with 1000 (normal) when an agent uses end_call; quota/auth/policy failures arrive as 1002/1008/1011 or the
 * 3000+ application range with a reason string. 1005/1006 carry no reason and are treated as a hang-up.
 */
export function closeFailure(code: number | undefined, reason: string): string | undefined {
  const bad = (code != null && (code === 1002 || code === 1008 || code === 1011 || code >= 3000)) ||
    /quota|credit|limit|unauthori[sz]ed|invalid|error/i.test(reason);
  if (!bad) return undefined;
  return `${code ?? "?"}${reason ? ` ${reason.slice(0, 200)}` : ""}`;
}

function toText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return String(data);
}

/** The ElevenLabs voice call only (no fallback). startAgentBridge wraps it with the text fallback. */
export async function startVoiceBridge(
  caseId: string,
  counterparty: "hospital" | "insurer",
  opts: BridgeOptions = {},
): Promise<BridgeHandle> {
  const packet = requireCase(caseId);
  if (packet.mode === "patient" && packet.patient?.consent !== true)
    throw Object.assign(new Error("the patient must consent before the rehearsal"), { statusCode: 409 });
  if (bridges.has(caseId)) throw Object.assign(new Error(`a negotiation call is already running for case ${caseId}`), { statusCode: 409 });

  const connect = opts.connect ?? ((url: string) => new WebSocket(url) as unknown as WsLike);
  const signed = opts.signedUrl ?? ((id: string) => getSignedUrl(id));
  const translate = opts.translate ?? ((t: string) => translateLine(t, "zh"));
  const tickMs = opts.tickMs ?? 100;
  const timeoutMs = opts.timeoutMs ?? 4 * 60_000;
  const graceMs = opts.graceMs ?? 6000;
  const wrapUpMs = Math.min(opts.wrapUpMs ?? 45_000, timeoutMs / 2);
  const debug = opt("VELLUM_BRIDGE_DEBUG") === "1";

  // Resolve config + signed URLs BEFORE touching state, so a missing key fails loudly with nothing half-open.
  const roles: [VoiceRole, VoiceRole] = ["advocate", counterparty];
  const inits = roles.map((r) => conversationInit(r, packet, caseId));
  const browserAgent = opt("ELEVENLABS_BROWSER_AGENT_ID");
  const hospitalAgent = counterparty === "hospital" ? opt("ELEVENLABS_HAIKU_HOSPITAL_AGENT_ID") : undefined;
  if (browserAgent) {
    inits[0] = browserDemoInit(packet);
    inits[0].conversation_config_override.agent.first_message = "";
  }
  if (hospitalAgent) inits[1] = hospitalDemoInit(packet);
  const urls = await Promise.all(roles.map((r) => signed(r === "advocate" && browserAgent ? browserAgent
    : r === "hospital" && hospitalAgent ? hospitalAgent : agentIdFor(r))));
  updateCase(caseId, { voiceSimulation: true });

  let stopped = false;
  let resolveDone!: (v: { reason: StopReason }) => void;
  const done = new Promise<{ reason: StopReason }>((r) => (resolveDone = r));
  const timers: ReturnType<typeof setTimeout>[] = [];
  let ticker: ReturnType<typeof setInterval> | undefined;
  let translating: Promise<void> = Promise.resolve();
  let translateFailed = false;

  const legs: Leg[] = roles.map((who, i) => ({
    who: who as Who,
    ws: connect(urls[i]),
    ready: false,
    outRate: 16000,
    inRate: 16000,
    mic: [],
    spoken: false,
  }));
  const [adv, cp] = legs;
  const other = (l: Leg) => (l === adv ? cp : adv);

  const stop = (reason: StopReason = "stopped") => {
    if (stopped) return;
    stopped = true;
    if (ticker) clearInterval(ticker);
    for (const t of timers) clearTimeout(t);
    for (const l of legs) {
      try {
        l.ws.close();
      } catch {
        /* already closed */
      }
    }
    bridges.delete(caseId);
    emit(caseId, { type: "log", message: `Negotiation call ended (${reason})`, messageZh: "谈判通话已结束" });
    void translating.then(() => resolveDone({ reason }));
  };

  const wrapUp = (reason: StopReason) => {
    if (!stopped) timers.push(setTimeout(() => stop(reason), graceMs));
  };

  let outcomeReported = false;
  const onTool = (name: string, r: ToolResult) => {
    if (name === "end_call" && r.ok) {
      outcomeReported = true;
      wrapUp("outcome");
    }
  };

  const handle = { caseId, counterparty, channel: "voice" as const, stop, done, onTool };
  bridges.set(caseId, handle);

  const send = (l: Leg, msg: unknown) => {
    if (l.ws.readyState === 1) l.ws.send(JSON.stringify(msg));
  };

  const fail = (message: string) => {
    if (opts.onFailure) opts.onFailure(message);
    else emit(caseId, { type: "error", message });
    stop("error");
  };

  const pushTranscript = (who: Who, text: string) => {
    const at = new Date().toISOString();
    translating = translating.then(async () => {
      let textZh: string | undefined;
      try {
        textZh = (await translate(text)) || undefined;
      } catch (e) {
        if (!translateFailed) emit(caseId, { type: "error", message: `live translation failed: ${(e as Error).message}` });
        translateFailed = true;
      }
      const line: TranscriptLine = { role: who, text, ...(textZh ? { textZh } : {}), at };
      requireCase(caseId).transcript.push(line);
      emit(caseId, { type: "transcript", line });
    });
  };

  const onMessage = (l: Leg, raw: unknown) => {
    if (stopped) return;
    let m: any;
    try {
      m = JSON.parse(toText(raw));
    } catch {
      return;
    }
    if (debug && m?.type !== "audio" && m?.type !== "ping" && m?.type !== "vad_score")
      console.error(`[bridge ${l.who}] ${JSON.stringify(m).slice(0, 400)}`);
    switch (m?.type) {
      case "conversation_initiation_metadata": {
        const md = m.conversation_initiation_metadata_event ?? {};
        try {
          l.outRate = pcmRate(md.agent_output_audio_format);
          l.inRate = pcmRate(md.user_input_audio_format);
        } catch (e) {
          emit(caseId, { type: "error", message: (e as Error).message });
          return stop("error");
        }
        l.ready = true;
        return;
      }
      case "ping":
        return send(l, { type: "pong", event_id: m.ping_event?.event_id });
      case "audio": {
        const b64: string | undefined = m.audio_event?.audio_base_64;
        if (!b64) return;
        // The advocate waits for the billing office to answer; drop anything it says before that.
        if (l === adv && !cp.spoken) return;
        l.spoken = true;
        emit(caseId, { type: "audio", who: l.who, sampleRate: l.outRate, chunk: b64 });
        const o = other(l);
        o.mic.push(resamplePcm16(Buffer.from(b64, "base64"), l.outRate, o.inRate));
        return;
      }
      case "interruption":
        // l was cut off: whatever it had queued for the other side is now stale.
        other(l).mic.length = 0;
        return;
      case "agent_response": {
        const text: string | undefined = m.agent_response_event?.agent_response;
        if (!text?.trim()) return;
        if (l === adv && !cp.spoken) return;
        l.spoken = true;
        return pushTranscript(l.who, text.trim());
      }
      case "client_tool_call": {
        const call = m.client_tool_call ?? {};
        const name = internalToolName(String(call.tool_name ?? ""));
        let r: ToolResult;
        try {
          if (l !== adv) throw new Error("Only the advocate may use case tools");
          r = handleTool(caseId, name, call.parameters ?? {});
        } catch (e) {
          r = { ok: false, message: (e as Error).message };
        }
        send(l, { type: "client_tool_result", tool_call_id: call.tool_call_id, result: r.message, is_error: !r.ok });
        onTool(name, r);
        return;
      }
      default:
        return; // user_transcript (the other agent, ASR'd), vad_score, agent_response_correction, …
    }
  };

  for (const [i, l] of legs.entries()) {
    l.ws.on("open", () => send(l, inits[i]));
    l.ws.on("message", (d) => onMessage(l, d));
    l.ws.on("close", (code?: number, reason?: unknown) => {
      if (stopped) return;
      const why = reason == null ? "" : toText(reason).trim();
      const failure = closeFailure(code, why);
      if (failure) {
        // e.g. 3000 "[quota_exceeded] You've run out of credits" or 1002 "exceeds your quota limit" mid-call:
        // that is a provider failure, not the other side hanging up — say so instead of a silent "hangup".
        return fail(`ElevenLabs ended the ${l.who} leg: ${failure}`);
      }
      // The advocate hangs up (end_call system tool) right after report_outcome: that is the outcome, not a drop.
      if (outcomeReported) return stop("outcome");
      emit(caseId, { type: "log", message: `The ${l.who} side hung up${code ? ` (${code})` : ""}` });
      stop("hangup");
    });
    l.ws.on("error", (err) => {
      if (stopped) return;
      fail(`ElevenLabs ${l.who} connection error: ${err.message}`);
    });
  }

  // Real-time "microphones": every tick each ready leg gets exactly tickMs of audio (queued speech or silence).
  ticker = setInterval(() => {
    if (stopped) return;
    for (const l of legs) {
      if (!l.ready || l.ws.readyState !== 1) continue;
      const bytes = Math.round((l.inRate * tickMs) / 1000) * 2;
      let frame = Buffer.alloc(0);
      while (frame.length < bytes && l.mic.length) {
        const head = l.mic[0];
        const take = Math.min(bytes - frame.length, head.length);
        frame = Buffer.concat([frame, head.subarray(0, take)]);
        if (take === head.length) l.mic.shift();
        else l.mic[0] = head.subarray(take);
      }
      if (frame.length < bytes) frame = Buffer.concat([frame, Buffer.alloc(bytes - frame.length)]);
      send(l, { user_audio_chunk: frame.toString("base64") });
    }
  }, tickMs);

  // Near the limit, tell the advocate (silently: a contextual update is context, not a user turn) to close out,
  // so the call ends with a recorded deal or an honest no_deal instead of being cut off mid-sentence.
  timers.push(
    setTimeout(() => {
      if (stopped || outcomeReported) return;
      send(adv, {
        type: "contextual_update",
        text: `TIME CHECK: under ${Math.round(wrapUpMs / 1000)} seconds remain on this call. Wrap up now: if they have offered an amount at or below your ceiling, accept it with accept_offer and confirm it; otherwise ask for a collections hold while she applies for financial assistance. Then call ${OUTCOME_TOOL} and say goodbye.`,
      });
      emit(caseId, { type: "log", message: "Asked the advocate to wrap up before the time limit" });
    }, timeoutMs - wrapUpMs),
  );
  timers.push(
    setTimeout(() => {
      emit(caseId, { type: "log", message: "Negotiation call hit the time limit", messageZh: "谈判通话已达到时间上限" });
      stop("timeout");
    }, timeoutMs),
  );

  if (packet.status !== "negotiating" && packet.agreedAmount == null) updateCase(caseId, { status: "negotiating" });
  emit(caseId, {
    type: "log",
    message: `Calling the ${counterparty === "insurer" ? "insurer" : "hospital billing office"} (agent vs agent)`,
    messageZh: `正在用英语给${counterparty === "insurer" ? "保险公司" : "医院账单部门"}打电话，您可以看到中文翻译`,
  });
  return { caseId, counterparty, channel: "voice", stop, done };
}

// ---------------------------------------------------------------- voice first, text if voice can't run

export type NegotiationOptions = BridgeOptions & {
  /** "text" skips ElevenLabs and runs the live text negotiation directly. */
  channel?: "voice" | "text";
  text?: TextOptions;
};

/** A short, human reason from an ElevenLabs failure message (no response bodies, no keys). */
export function voiceFailureReason(message: string): string {
  if (/quota|credit/i.test(message)) return "out of credits";
  const missing = /ELEVENLABS_[A-Z_]+ is not configured/.exec(message);
  if (missing) return missing[0];
  if (/\b401\b|unauthori[sz]ed|invalid.*key/i.test(message)) return "API key rejected";
  const status = /\b(429|5\d\d)\b/.exec(message);
  if (status) return `service error ${status[0]}`;
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|connection error/i.test(message)) return "could not connect";
  return message.replace(/\s+/g, " ").slice(0, 120);
}

/**
 * Run the negotiation call: an ElevenLabs agent-vs-agent voice call when it can run, otherwise (no API key,
 * quota/credits/auth/connect failure before or during the call) a live TEXT negotiation with the same
 * prompts, tools and events, so the demo never dead-ends. Resolves once a channel is running; `done`
 * settles with the final outcome of whichever channel finished the call.
 */
export async function startAgentBridge(
  caseId: string,
  counterparty: "hospital" | "insurer",
  opts: NegotiationOptions = {},
): Promise<BridgeHandle> {
  const packet = requireCase(caseId);
  if (packet.mode === "patient" && packet.patient?.consent !== true)
    throw Object.assign(new Error("the patient must consent before the rehearsal"), { statusCode: 409 });
  if (activeBridge(caseId)) throw Object.assign(new Error(`a negotiation call is already running for case ${caseId}`), { statusCode: 409 });

  let stopped: StopReason | undefined;
  let current: { stop: (r?: StopReason) => void } | undefined;
  const handle: BridgeHandle = {
    caseId,
    counterparty,
    channel: "voice",
    stop: (reason: StopReason = "stopped") => {
      if (stopped) return;
      stopped = reason;
      current?.stop(reason);
    },
    done: undefined as unknown as BridgeHandle["done"],
  };
  sessions.set(caseId, handle); // reserve the case before any await

  const runText = (why: string | undefined, prior: TextOptions["prior"]) => {
    handle.channel = "text";
    emit(caseId, why
      ? { type: "log", message: `Voice unavailable (ElevenLabs: ${why}) — continuing as a live text negotiation`, messageZh: "语音通话暂时不可用，改为实时文字谈判" }
      : { type: "log", message: "Running a live text negotiation (voice not requested)", messageZh: "正在进行实时文字谈判" });
    const t = startTextNegotiation(caseId, { ...opts.text, ...(prior?.length ? { prior } : {}) });
    current = t;
    return t.done;
  };

  // 1) voice, unless text was asked for or there is no ElevenLabs key at all
  let voice: BridgeHandle | undefined;
  let fallbackWhy: string | undefined;
  let failure: string | undefined;
  const transcriptStart = packet.transcript.length;
  if (opts.channel !== "text") {
    if (!opt("ELEVENLABS_API_KEY") && !opts.signedUrl) fallbackWhy = "ELEVENLABS_API_KEY is not configured";
    else {
      try {
        voice = await startVoiceBridge(caseId, counterparty, { ...opts, onFailure: (m) => (failure = m) });
        current = voice;
        if (stopped) voice.stop(stopped);
      } catch (e) {
        fallbackWhy = voiceFailureReason((e as Error).message);
      }
    }
  }

  handle.done = (async (): Promise<{ reason: StopReason }> => {
    try {
      if (voice) {
        const r = await voice.done;
        const c = requireCase(caseId);
        const spoke = c.transcript.length > transcriptStart;
        // A provider failure before any outcome, or a call that connected and closed without a word, is not
        // "the hospital said no": carry on in text from wherever the voice call got to.
        const recover = (r.reason === "error" && failure != null) || (r.reason === "hangup" && !spoke);
        if (stopped || c.agreedAmount != null || !recover) return r;
        const prior = c.transcript.slice(transcriptStart).map((l) => ({ role: l.role, text: l.text }));
        return await runText(voiceFailureReason(failure ?? "the call closed before anyone spoke"), prior);
      }
      if (stopped) return { reason: stopped };
      return await runText(fallbackWhy, undefined);
    } finally {
      if (sessions.get(caseId) === handle) sessions.delete(caseId);
    }
  })();
  return handle;
}
