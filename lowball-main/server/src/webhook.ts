import { broadcast } from "./dashboard.js";

type ToolCall = {
  id: string;
  name?: string;
  arguments?: unknown;
  function?: { name?: string; arguments?: unknown };
};

function parseArgs(raw: unknown): Record<string, any> {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return (raw as Record<string, any>) ?? {};
}

export async function handleVapiWebhook(body: any) {
  const message = body?.message;
  switch (message?.type) {
    case "transcript":
      broadcast({
        type: "transcript",
        role: message.role,
        text: message.transcript,
        final: message.transcriptType === "final",
      });
      return {};

    case "tool-calls": {
      const toolCalls: ToolCall[] = message.toolCallList ?? message.toolCalls ?? [];
      const results = [];
      for (const tc of toolCalls) {
        const name = tc.name ?? tc.function?.name;
        const args = parseArgs(tc.arguments ?? tc.function?.arguments);
        if (name === "log_offer") broadcast({ type: "offer", price: args.price });
        if (name === "accept_offer") broadcast({ type: "deal", price: args.price });
        if (name === "end_call")
          broadcast({ type: "call-ended", outcome: args.outcome, price: args.price });
        results.push({ toolCallId: tc.id, result: "ok" });
      }
      return { results };
    }

    case "status-update":
      broadcast({ type: "status", status: message.status });
      return {};

    case "end-of-call-report":
      broadcast({
        type: "report",
        summary: message.summary,
        endedReason: message.endedReason,
      });
      return {};

    default:
      return {};
  }
}
