import type { FastifyInstance } from "fastify";
import { opt } from "../env.js";
import { getCase, requireCase, updateCase } from "../store.js";
import { activeBridge, notifyToolResult, startAgentBridge } from "../agent/bridge.js";
import { advocateInitForHuman, agentIdFor, conversationInit, getSignedUrl, internalToolName } from "../agent/elevenlabs.js";
import { handleTool } from "../agent/tools.js";
import { haikuRoutes } from "../agent/haiku.js";
import { callRoutes } from "../agent/calls.js";
import { browserDemoInit } from "../agent/browser-demo.js";
import { BrowserTranscripts } from "../agent/browser-transcript.js";
import type { TranscriptLine } from "../types.js";

// Voice routes (see docs/API.md):
//   GET  /api/intake/signed-url[?case=]   → {signedUrl, init}  browser opens the Mandarin intake agent
//   POST /api/cases/:id/negotiate          {counterparty:"agent"|"human"|"text"} → {mode, channel?, advocateSignedUrl?, advocateInit?}
//                                          "agent" = ElevenLabs voice call, falling back to a live text negotiation
//                                          when voice can't run; "text" = the live text negotiation directly
//   POST /api/eleven/tools/:name           ElevenLabs webhook tools AND browser-forwarded client tools
// `init` = the conversation_initiation_client_data the browser must send first (per-case prompt overrides +
// dynamic_variables {case_id}).
export default async function voiceRoutes(app: FastifyInstance) {
  const browserTranscripts = new BrowserTranscripts();
  app.addHook("onClose", async () => browserTranscripts.clear());
  // missing config -> 503 {error}, explicit statusCode (404/409) as-is, upstream (ElevenLabs) failure -> 502
  app.setErrorHandler((e: Error & { statusCode?: number }, _req, reply) => {
    const code = e.statusCode ?? (/is not configured/i.test(e.message) ? 503 : 502);
    reply.code(code).send({ error: e.message });
  });

  await app.register(haikuRoutes);
  await app.register(callRoutes);

  app.get<{ Querystring: { case?: string } }>("/api/intake/signed-url", async (req) => {
    const caseId = req.query.case;
    const packet = caseId ? requireCase(caseId) : undefined;
    const signedUrl = await getSignedUrl(agentIdFor("intake"));
    return { signedUrl, init: conversationInit("intake", packet, caseId) };
  });

  app.post<{ Params: { id: string }; Body: { counterparty?: "agent" | "human" | "text" } }>("/api/cases/:id/negotiate", async (req, reply) => {
    const packet = requireCase(req.params.id);
    const mode = req.body?.counterparty ?? "agent";
    if (mode !== "agent" && mode !== "human" && mode !== "text") return reply.code(400).send({ error: "counterparty must be 'agent', 'human' or 'text'" });
    if (packet.mode === "patient" && packet.patient?.consent !== true)
      return reply.code(409).send({ error: "the patient has not consented — Vellum will not negotiate" });

    if (mode === "human") {
      // A teammate plays the billing office in the browser, talking to our advocate agent.
      const browserAgent = opt("ELEVENLABS_BROWSER_AGENT_ID");
      if (browserAgent && packet.mode === "patient" && packet.patient?.consent !== true)
        return reply.code(409).send({ error: "the demo patient must consent before the rehearsal" });
      const advocateSignedUrl = await getSignedUrl(browserAgent ?? agentIdFor("advocate"));
      updateCase(packet.id, { voiceSimulation: true,
        ...(packet.agreedAmount == null ? { status: "negotiating" as const } : {}) });
      return { mode, simulated: true, advocateSignedUrl,
        transcriptToken: browserTranscripts.start(packet.id),
        advocateInit: browserAgent ? browserDemoInit(packet) : advocateInitForHuman(packet) };
    }

    if (activeBridge(packet.id)) return reply.code(409).send({ error: "a negotiation call is already running for this case" });
    const handle = await startAgentBridge(packet.id, packet.mode === "clinic" ? "insurer" : "hospital", mode === "text" ? { channel: "text" } : {});
    return { mode, counterparty: handle.counterparty, channel: handle.channel };
  });

  app.post<{ Params: { id: string }; Body: TranscriptLine }>("/api/cases/:id/voice/transcript", {
    bodyLimit: 12_000,
    schema: { body: { type: "object", additionalProperties: false, required: ["role", "text", "at"], properties: {
      role: { type: "string", enum: ["advocate", "hospital", "insurer"] },
      text: { type: "string", minLength: 1, maxLength: 2000 },
      at: { type: "string", maxLength: 40 },
    } } },
  }, async (req) => {
    const { role, text, at } = req.body;
    browserTranscripts.append(req.params.id, req.headers["x-voice-session"], { role, text, at });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/cases/:id/negotiate/stop", async (req, reply) => {
    const b = activeBridge(req.params.id);
    if (!b) return reply.code(404).send({ error: "no negotiation call is running for this case" });
    b.stop("stopped");
    return { ok: true };
  });

  app.post<{ Params: { name: string }; Body: Record<string, unknown> }>("/api/eleven/tools/:name", async (req, reply) => {
    const secret = opt("ELEVENLABS_TOOL_SECRET");
    // The secret guards the ElevenLabs webhook. Our own page (intake form + client-tool forwarding) cannot hold it,
    // so a same-origin browser call is exempt: browsers set Sec-Fetch-Site themselves and page JS cannot forge it.
    // This is a guard against blind webhook spoofing, not auth — the case UUID is the capability either way.
    const sameOrigin = req.headers["sec-fetch-site"] === "same-origin";
    // x-bangbang-secret: ElevenLabs agents configured before the Vellum rename still send the old header name.
    const sent = req.headers["x-vellum-secret"] ?? req.headers["x-bangbang-secret"];
    if (secret && !sameOrigin && sent !== secret) return reply.code(401).send({ error: "bad tool secret" });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { case_id, ...args } = body;
    const caseId = typeof case_id === "string" && case_id ? case_id : (req.headers["x-case-id"] as string | undefined);
    if (!caseId) return reply.code(400).send({ error: "case_id is required (pass dynamic_variables {case_id} when starting the conversation)" });
    if (!getCase(caseId)) return reply.code(404).send({ error: `unknown case ${caseId}` });
    const name = internalToolName(req.params.name);
    const r = handleTool(caseId, name, args);
    notifyToolResult(caseId, name, r);
    return { ok: r.ok, message: r.message };
  });
}
