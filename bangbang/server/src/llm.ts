import OpenAI from "openai";
import { need, opt } from "./env.js";

let client: OpenAI | undefined;
function openai(): OpenAI {
  return (client ??= new OpenAI({ apiKey: need("OPENAI_API_KEY") }));
}
const model = () => opt("OPENAI_MODEL", "gpt-4o")!;

/** Chat completion that must return JSON. `image` is a data: URL or https URL. */
export async function llmJson<T>(system: string, user: string, opts: { image?: string; temperature?: number } = {}): Promise<T> {
  const content: OpenAI.Chat.ChatCompletionContentPart[] = [{ type: "text", text: user }];
  if (opts.image) content.push({ type: "image_url", image_url: { url: opts.image } });
  const res = await openai().chat.completions.create({
    model: model(),
    temperature: opts.temperature ?? 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content },
    ],
  });
  const text = res.choices[0]?.message?.content ?? "{}";
  return JSON.parse(text) as T;
}

export async function llmText(system: string, user: string, temperature = 0.3): Promise<string> {
  const res = await openai().chat.completions.create({
    model: model(),
    temperature,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return res.choices[0]?.message?.content ?? "";
}
