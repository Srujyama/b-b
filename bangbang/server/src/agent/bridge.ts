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
import { emit, requireCase, updateCase } from "../store.js";
import type { TranscriptLine } from "../types.js";
import { handleTool, type ToolResult } from "./tools.js";
import { translateLine } from "./translate.js";
import { agentIdFor, conversationInit, getSignedUrl, internalToolName, pcmRate, resamplePcm16, type VoiceRole } from "./elevenlabs.js";

type Who = "advocate" | "hospital" | "insurer";

/** Minimal surface of a `ws` WebSocket we rely on (lets tests inject a fake). */
export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "open", cb: () => void): unknown;
  on(event: "message", cb: (data: unknown) => void): unknown;
  on(event: "close", cb: () => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
}

export type BridgeOptions = {
  connect?: (url: string) => WsLike;
  signedUrl?: (agentId: string) => Promise<string>;
  translate?: (text: string) => Promise<string>;
  tickMs?: number; // mic frame length (default 100ms)
  timeoutMs?: number; // hard stop (default 4 min)
  graceMs?: number; // let the goodbye play after the outcome (default 6s)
};

export type StopReason = "outcome" | "hangup" | "timeout" | "error" | "stopped";

export type BridgeHandle = {
  caseId: string;
  counterparty: "hospital" | "insurer";
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

export function activeBridge(caseId: string): BridgeHandle | undefined {
  return bridges.get(caseId);
}

/** Webhook-mode tool calls land in routes/voice.ts; it tells the bridge so the call can wrap up. */
export function notifyToolResult(caseId: string, name: string, result: ToolResult) {
  bridges.get(caseId)?.onTool(internalToolName(name), result);
}

function toText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return String(data);
}

export async function startAgentBridge(
  caseId: string,
  counterparty: "hospital" | "insurer",
  opts: BridgeOptions = {},
): Promise<BridgeHandle> {
  const packet = requireCase(caseId);
  if (bridges.has(caseId)) throw Object.assign(new Error(`a negotiation call is already running for case ${caseId}`), { statusCode: 409 });

  const connect = opts.connect ?? ((url: string) => new WebSocket(url) as unknown as WsLike);
  const signed = opts.signedUrl ?? ((id: string) => getSignedUrl(id));
  const translate = opts.translate ?? ((t: string) => translateLine(t, "zh"));
  const tickMs = opts.tickMs ?? 100;
  const timeoutMs = opts.timeoutMs ?? 4 * 60_000;
  const graceMs = opts.graceMs ?? 6000;

  // Resolve config + signed URLs BEFORE touching state, so a missing key fails loudly with nothing half-open.
  const roles: [VoiceRole, VoiceRole] = ["advocate", counterparty];
  const inits = roles.map((r) => conversationInit(r, packet, caseId));
  const urls = await Promise.all(roles.map((r) => signed(agentIdFor(r))));

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

  const onTool = (name: string, r: ToolResult) => {
    if (name === "end_call" && r.ok) wrapUp("outcome");
  };

  const handle = { caseId, counterparty, stop, done, onTool };
  bridges.set(caseId, handle);

  const send = (l: Leg, msg: unknown) => {
    if (l.ws.readyState === 1) l.ws.send(JSON.stringify(msg));
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
    l.ws.on("close", () => stop("hangup"));
    l.ws.on("error", (err) => {
      if (stopped) return;
      emit(caseId, { type: "error", message: `ElevenLabs ${l.who} connection error: ${err.message}` });
      stop("error");
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
  return { caseId, counterparty, stop, done };
}
