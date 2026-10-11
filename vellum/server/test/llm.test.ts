import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Anthropic SDK is mocked at the boundary: no key, no network.
const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    beta = { messages: { create } };
  },
}));

const { llmJson, llmText, attachmentBlock, extractJson } = await import("../src/llm.js");

const reply = (text: string, extra: Record<string, unknown> = {}) => ({ content: [{ type: "text", text }], stop_reason: "end_turn", stop_details: null, ...extra });

describe("llm (Claude)", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    create.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("sends a valid Opus 5.5 request: no sampling params, effort set, server-side fallbacks on", async () => {
    create.mockResolvedValue(reply('{"ok":true}'));
    expect(await llmJson<{ ok: boolean }>("sys", "user", { temperature: 0.2 })).toEqual({ ok: true });
    const req = create.mock.calls[0][0];
    expect(req.model).toBe("claude-opus-5-5");
    expect(req).not.toHaveProperty("temperature");
    expect(req).not.toHaveProperty("thinking"); // can't be disabled on Opus 5.5; effort is the control
    expect(req.output_config).toEqual({ effort: "medium" });
    expect(req.fallbacks).toBe("default");
    expect(req.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(req.system).toMatch(/single JSON object/);
  });

  it("translation runs at low effort and honors ANTHROPIC_MODEL", async () => {
    vi.stubEnv("ANTHROPIC_MODEL", "claude-haiku-5-5");
    create.mockResolvedValue(reply("  你好  "));
    expect(await llmText("translate", "hello", 0.3)).toBe("你好");
    expect(create.mock.calls[0][0]).toMatchObject({ model: "claude-haiku-5-5", output_config: { effort: "low" } });
  });

  it("puts a PDF bill in as a document block and a photo as an image block, before the text", async () => {
    create.mockResolvedValue(reply("{}"));
    await llmJson("s", "read this bill", { image: "data:application/pdf;base64,JVBERi0=" });
    const content = create.mock.calls[0][0].messages[0].content;
    expect(content[0]).toEqual({ type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } });
    expect(content[1]).toEqual({ type: "text", text: "read this bill" });
    expect(attachmentBlock("data:image/jpeg;base64,/9j/")).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/" } });
    expect(attachmentBlock("https://x.org/bill.png")).toEqual({ type: "image", source: { type: "url", url: "https://x.org/bill.png" } });
    expect(() => attachmentBlock("data:image/heic;base64,AAAA")).toThrow(/unsupported attachment/);
  });

  it("extracts JSON from fenced or chatty replies and fails loudly otherwise", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here it is: {"a":{"b":2}} done')).toEqual({ a: { b: 2 } });
    expect(() => extractJson("no json here")).toThrow(/did not return JSON/);
  });

  it("surfaces a refusal as an error instead of returning empty output", async () => {
    create.mockResolvedValue(reply("", { stop_reason: "refusal", stop_details: { type: "refusal", category: "bio", explanation: "" } }));
    await expect(llmText("s", "u")).rejects.toThrow(/declined.*bio/);
  });

  it("says exactly which key is missing", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.resetModules();
    const fresh = await import("../src/llm.js");
    await expect(fresh.llmText("s", "u")).rejects.toThrow(/ANTHROPIC_API_KEY is not configured/);
  });
});
