import Anthropic from "@anthropic-ai/sdk";
import { need, opt } from "./env.js";

// Shared LLM helper (Claude). Signatures are unchanged from the OpenAI version so callers don't change.
// Claude Opus 5.5 is the default; set ANTHROPIC_MODEL to override (e.g. claude-haiku-5-5 for cheaper/faster).
let client: Anthropic | undefined;
function anthropic(): Anthropic {
  return (client ??= new Anthropic({ apiKey: need("ANTHROPIC_API_KEY") }));
}
const model = () => opt("ANTHROPIC_MODEL", "claude-opus-5-5")!;

type Effort = "low" | "medium" | "high";
type Block = Anthropic.Beta.Messages.BetaContentBlockParam;

/** A data: URL (image or PDF) or an https image URL -> the matching Claude content block. */
export function attachmentBlock(ref: string): Block {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(ref);
  if (!m) return { type: "image", source: { type: "url", url: ref } };
  const [, mediaType, data] = m;
  if (mediaType === "application/pdf") return { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
  const images = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
  const img = images.find((t) => t === mediaType);
  if (!img) throw Object.assign(new Error(`unsupported attachment type ${mediaType}: send a photo (jpeg/png/webp/gif) or a PDF`), { statusCode: 415 });
  return { type: "image", source: { type: "base64", media_type: img, data } };
}

/** Pull the JSON object out of a reply (tolerates ```json fences or a sentence around it). */
export function extractJson<T>(text: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const body = (fenced ?? text).trim();
  try {
    return JSON.parse(body) as T;
  } catch {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1)) as T;
    throw new Error(`LLM did not return JSON: ${text.slice(0, 200)}`);
  }
}

async function ask(system: string, content: Block[], effort: Effort): Promise<string> {
  return (await send(system, [{ role: "user", content }], effort)).text;
}

type Usage = { inputTokens: number; outputTokens: number };
async function send(system: string, messages: Anthropic.Beta.Messages.BetaMessageParam[], effort: Effort): Promise<{ text: string; usage: Usage }> {
  const res = await anthropic().beta.messages.create({
    model: model(),
    max_tokens: 16000,
    system,
    messages,
    output_config: { effort },
    // On a safety decline the API re-runs the request on a fallback model it picks by category.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  if (res.stop_reason === "refusal") {
    throw new Error(`Claude declined this request${res.stop_details?.category ? ` (${res.stop_details.category})` : ""}`);
  }
  return {
    text: res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
    usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 },
  };
}

/** Completion that must return JSON. `image` is a data: URL (photo or PDF) or an https image URL.
 *  `temperature` is accepted for compatibility but ignored: current Claude models reject sampling params. */
export async function llmJson<T>(system: string, user: string, opts: { image?: string; temperature?: number; effort?: Effort } = {}): Promise<T> {
  const content: Block[] = [];
  if (opts.image) content.push(attachmentBlock(opts.image)); // documents/images go before the text
  content.push({ type: "text", text: user });
  const sys = `${system}\n\nRespond with a single JSON object only: no prose, no code fences.`;
  return extractJson<T>(await ask(sys, content, opts.effort ?? "medium"));
}

/** Plain-text completion (used for live line-by-line translation, so it runs at low effort). */
export async function llmText(system: string, user: string, _temperature?: number): Promise<string> {
  return (await ask(system, [{ type: "text", text: user }], "low")).trim();
}

/** One turn of a multi-turn conversation, from the caller's point of view. */
export type ChatTurn = { role: "user" | "assistant"; content: string };

/**
 * Multi-turn completion that must return JSON (the negotiation eval plays both sides of a call with Claude).
 * Consecutive same-role turns are merged, a leading assistant turn gets a "(the call connects)" user turn in
 * front, and a trailing assistant turn gets a "your turn" nudge, so any transcript slice is a valid history
 * (no assistant prefill). Returns the parsed JSON, the raw text and the token usage the API reported.
 */
export async function llmChatJson<T>(
  system: string,
  turns: ChatTurn[],
  opts: { effort?: Effort } = {},
): Promise<{ value: T; text: string; usage: Usage }> {
  const merged: ChatTurn[] = [];
  for (const t of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) last.content += `\n\n${t.content}`;
    else merged.push({ ...t });
  }
  if (!merged.length || merged[0].role !== "user") merged.unshift({ role: "user", content: "(the call connects)" });
  if (merged[merged.length - 1].role !== "user") merged.push({ role: "user", content: "(silence on the line; it is your turn)" });
  const sys = `${system}\n\nRespond with a single JSON object only: no prose, no code fences.`;
  const { text, usage } = await send(sys, merged, opts.effort ?? "medium");
  return { value: extractJson<T>(text), text, usage };
}
