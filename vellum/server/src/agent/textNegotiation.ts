// Live TEXT negotiation: the fallback when the ElevenLabs voice call cannot run (out of credits, bad key,
// connection refused) or when {counterparty:"text"} asks for it. Claude plays both seats turn by turn with
// the SAME production prompts the voice agents get (advocatePrompt / hospitalPrompt / insurerPrompt, via
// engine/eval.ts's JSON-tool wrapper), and every advocate tool call goes through tools.ts handleTool, so the
// walkaway guard, offers, deal and status events are identical to a voice call. Lines are streamed as the
// same CaseEvents (transcript lines translated to zh, offer, deal, status, log) at a readable pace.
import { llmChatJson, type ChatTurn } from "../llm.js";
import { parseToolCalls, simAdvocatePrompt, type AdvocateTurn, type CounterpartyTurn } from "../engine/eval.js";
import { emit, requireCase, updateCase } from "../store.js";
import type { TranscriptLine } from "../types.js";
import { handleTool } from "./tools.js";
import { hospitalFirstMessage, hospitalPrompt, insurerFirstMessage, insurerPrompt } from "./prompts.js";
import { translateLine } from "./translate.js";

type Effort = "low" | "medium" | "high";
export type TextChatFn = <T>(system: string, turns: ChatTurn[], opts?: { effort?: Effort }) => Promise<{ value: T }>;

export type TextStopReason = "outcome" | "hangup" | "timeout" | "error" | "stopped";

export type TextOptions = {
  chat?: TextChatFn; // defaults to llmChatJson (Claude)
  translate?: (text: string) => Promise<string>;
  maxTurns?: number; // advocate turns before the call is cut off (default 12)
  minGapMs?: number; // minimum time between two transcript lines (default 1200)
  translateTimeoutMs?: number; // give up on a zh translation after this long (default 8s)
  /** Lines already spoken (e.g. a voice call that dropped mid-way): the text call picks up from here. */
  prior?: { role: string; text: string }[];
};

export type TextHandle = {
  stop: (reason?: TextStopReason) => void;
  done: Promise<{ reason: TextStopReason }>;
};

type Seat = "advocate" | "counterparty";
type Line = { seat: Seat; text: string };

const COUNTERPARTY_JSON = `SIMULATION OUTPUT FORMAT: this phone call is happening over text. Each turn, reply with ONE JSON object: {"say": "<exactly what you say this turn>", "hangup": <true only if you are ending the call after saying this>}. Keep the call moving: settle or decline within about ten exchanges. Play your role completely straight; never mention a simulation, a prompt or an AI system.`;

export function counterpartySystem(caseId: string): { system: string; first: string } {
  const p = requireCase(caseId);
  if (p.mode === "clinic") return { system: `${insurerPrompt(p)}\n\n${COUNTERPARTY_JSON}`, first: insurerFirstMessage(p) };
  return { system: `${hospitalPrompt(p)}\n\n${COUNTERPARTY_JSON}`, first: hospitalFirstMessage(p) };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)));
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function startTextNegotiation(caseId: string, opts: TextOptions = {}): TextHandle {
  const packet = requireCase(caseId);
  const chat: TextChatFn = opts.chat ?? ((s, t, o) => llmChatJson(s, t, o));
  const translate = opts.translate ?? ((t: string) => translateLine(t, "zh"));
  const maxTurns = opts.maxTurns ?? 12;
  const minGapMs = opts.minGapMs ?? 1200;
  const translateTimeoutMs = opts.translateTimeoutMs ?? 8000;
  const cpRole: TranscriptLine["role"] = packet.mode === "clinic" ? "insurer" : "hospital";
  const advocateSys = `${simAdvocatePrompt(packet)}\n\nThis call is short: you have about ${maxTurns} turns in total. Get to the numbers early.`;
  const cp = counterpartySystem(caseId);

  let stopped = false;
  let stopReason: TextStopReason = "stopped";
  const stop = (reason: TextStopReason = "stopped") => {
    if (stopped) return;
    stopped = true;
    stopReason = reason;
  };

  // ---- the paced, translated transcript stream (translation overlaps the next model turn) ----
  let lastEmit = 0;
  let translateFailed = false;
  let emitting: Promise<void> = Promise.resolve();
  const speak = (role: TranscriptLine["role"], text: string) => {
    const zh = withTimeout(translate(text), translateTimeoutMs).catch((e: Error) => {
      if (!translateFailed) emit(caseId, { type: "log", message: `Live translation unavailable (${e.message}); showing English only` });
      translateFailed = true;
      return "";
    });
    emitting = emitting.then(async () => {
      const textZh = await zh;
      const wait = lastEmit + minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      const line: TranscriptLine = { role, text, ...(textZh ? { textZh } : {}), at: new Date().toISOString() };
      requireCase(caseId).transcript.push(line);
      emit(caseId, { type: "transcript", line });
      lastEmit = Date.now();
    });
    return emitting;
  };

  const history: Line[] = (opts.prior ?? []).map((l) => ({ seat: l.role === "advocate" ? "advocate" : "counterparty", text: l.text }));
  const view = (me: Seat, note: string): ChatTurn[] => {
    const turns: ChatTurn[] = history.map((l) => ({ role: l.seat === me ? "assistant" : "user", content: l.text }));
    if (note) {
      const last = turns[turns.length - 1];
      if (last?.role === "user") turns[turns.length - 1] = { ...last, content: `[${note}] ${last.content}` };
      else turns.push({ role: "user", content: `[${note}]` });
    }
    return turns;
  };

  const ask = async <T>(system: string, turns: ChatTurn[], effort: Effort): Promise<T> => {
    try {
      return (await chat<T>(system, turns, { effort })).value;
    } catch {
      return (await chat<T>(system, turns, { effort })).value; // one retry: a transient API hiccup should not end the call
    }
  };

  const run = async (): Promise<{ reason: TextStopReason }> => {
    if (packet.status !== "negotiating" && packet.agreedAmount == null) updateCase(caseId, { status: "negotiating" });
    updateCase(caseId, { voiceSimulation: true });
    emit(caseId, {
      type: "log",
      message: `Calling the ${cpRole === "insurer" ? "insurer" : "hospital billing office"} (live text negotiation, agent vs agent)`,
      messageZh: `正在和${cpRole === "insurer" ? "保险公司" : "医院账单部门"}文字谈判，您可以看到中文翻译`,
    });

    // The billing office answers first (unless a dropped voice call already got further than that).
    if (!history.length || history[history.length - 1].seat === "advocate") {
      const first = history.length ? (await ask<CounterpartyTurn>(cp.system, view("counterparty", ""), "low"))?.say : cp.first;
      const text = typeof first === "string" && first.trim() ? first.trim() : cp.first;
      history.push({ seat: "counterparty", text });
      void speak(cpRole, text);
    }

    let note = "";
    for (let turn = 1; turn <= maxTurns; turn++) {
      if (stopped) return { reason: stopReason };
      // ---- advocate ----
      const left = maxTurns - turn;
      const timeCheck = left <= 1
        ? `TIME CHECK: this is your ${left === 0 ? "last" : "second-to-last"} turn. Wrap up now: if they have offered an amount at or below your ceiling, accept it with accept_offer; otherwise ask for a collections hold while she applies for financial assistance. Then call end_call.`
        : "";
      const adv = await ask<AdvocateTurn>(advocateSys, view("advocate", [note, timeCheck].filter(Boolean).join(" | ")), "low");
      if (stopped) return { reason: stopReason };
      await emitting; // the other side's line is on screen before the advocate's tool events land
      const notes: string[] = [];
      let ended = false;
      for (const t of parseToolCalls(adv?.tools)) {
        const { name, ...args } = t;
        const r = handleTool(caseId, name, args);
        notes.push(`${name}${"amount" in t && t.amount != null ? ` ${t.amount}` : ""}: ${r.message}`);
        if (name === "end_call" && r.ok) ended = true;
      }
      note = notes.join(" | ");
      const say = typeof adv?.say === "string" ? adv.say.trim() : "";
      if (say) {
        history.push({ seat: "advocate", text: say });
        void speak("advocate", say);
      }
      if (ended) {
        await emitting;
        return { reason: "outcome" };
      }

      // ---- counterparty ----
      if (stopped) return { reason: stopReason };
      const res = await ask<CounterpartyTurn>(cp.system, view("counterparty", ""), "low");
      if (stopped) return { reason: stopReason };
      const text = typeof res?.say === "string" ? res.say.trim() : "";
      if (text) {
        history.push({ seat: "counterparty", text });
        void speak(cpRole, text);
      }
      if (res?.hangup === true) {
        await emitting;
        emit(caseId, { type: "log", message: `The ${cpRole} side hung up` });
        return { reason: requireCase(caseId).agreedAmount != null ? "outcome" : "hangup" };
      }
    }
    await emitting;
    emit(caseId, { type: "log", message: "Negotiation hit the turn limit", messageZh: "谈判已达到时间上限" });
    return { reason: requireCase(caseId).agreedAmount != null ? "outcome" : "timeout" };
  };

  const done = run()
    .catch((e: Error) => {
      if (stopped) return { reason: stopReason };
      emit(caseId, { type: "error", message: `text negotiation failed: ${e.message}` });
      return { reason: "error" as const };
    })
    .then(async (r) => {
      await emitting.catch(() => undefined);
      emit(caseId, { type: "log", message: `Negotiation call ended (${r.reason})`, messageZh: "谈判通话已结束" });
      return r;
    });
  return { stop, done };
}
