// Narrow, temporary demo ingress. The product server and all case/money routes stay private.
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import Fastify from "fastify";
import { checkBearer } from "./haiku.js";

export function buildVoiceGateway(upstream: typeof fetch = fetch, serverPort = 8787) {
  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) throw new Error("Invalid local server port");
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  app.setErrorHandler((error: Error & { statusCode?: number }, _req, reply) => {
    const status = error.statusCode ?? 502;
    reply.code(status).send({ error: status === 401 ? "Unauthorized" : "Voice gateway request failed" });
  });
  app.get("/health", async () => ({ ok: true, service: "vellum-voice-gateway", scope: "browser-rehearsal-only" }));
  app.post("/api/voice/browser/llm/v1/chat/completions", {
    onRequest: async (req) => checkBearer(req.headers.authorization, "VOICE_LLM_TOKEN"),
  }, async (req, reply) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const abort = () => controller.abort();
    reply.raw.once("close", abort);
    try {
      const response = await upstream(`http://127.0.0.1:${serverPort}/api/voice/browser/llm/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", authorization: req.headers.authorization! },
        body: JSON.stringify(req.body), signal: controller.signal,
      });
      reply.code(response.status).header("content-type", response.headers.get("content-type") ?? "application/json")
        .header("cache-control", "no-store").header("x-accel-buffering", "no");
      if (!response.body) { clearTimeout(timer); reply.raw.off("close", abort); return reply.send(); }
      const stream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
      const finish = () => { clearTimeout(timer); reply.raw.off("close", abort); controller.abort(); };
      stream.once("close", finish);
      return reply.send(stream);
    } catch { clearTimeout(timer); reply.raw.off("close", abort); throw new Error("Local voice service unavailable"); }
  });
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await import("dotenv/config");
  const app = buildVoiceGateway(fetch, Number(process.env.PORT) || 8787);
  await app.listen({ host: "127.0.0.1", port: Number(process.env.VOICE_GATEWAY_PORT) || 8788 });
  console.log("Voice-only gateway listening on loopback. Tunnel this port, not the product server.");
}
