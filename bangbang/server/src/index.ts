import "dotenv/config";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { getCase, listCases, subscribe } from "./store.js";
import billRoutes from "./routes/bill.js";
import researchRoutes from "./routes/research.js";
import voiceRoutes from "./routes/voice.js";
import xrplRoutes from "./routes/xrpl.js";
import bnbRoutes from "./routes/bnb.js";
import x402Routes from "./routes/x402.js";
import marketRoutes from "./routes/markets.js";
import clinicRoutes from "./routes/clinic.js";
import pipelineRoutes from "./routes/pipeline.js";
import fundRoutes from "./routes/fund.js";
import summaryRoutes from "./routes/summary.js";
import proofRoutes from "./routes/proof.js";
import hospitalRoutes from "./routes/hospital.js";
import previewRoutes from "./dev/preview.js"; // UI design harness, mounted only when DEV_PREVIEW=1

const WEB_DIR = fileURLToPath(new URL("../../web", import.meta.url));

export async function buildApp() {
  const app = Fastify({ logger: true, bodyLimit: 20 * 1024 * 1024 });
  await app.register(cors, { origin: true });
  await app.register(websocket);
  await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024 } });
  await app.register(fastifyStatic, { root: WEB_DIR });

  const has = (k: string) => Boolean(process.env[k]);
  // Public client config. PUBLIC_WS_ORIGIN (e.g. wss://bangbang-bab.fly.dev) is set when the web app is served
  // from a different host (Vercel) than this server, because static hosts can't proxy WebSockets.
  app.get("/api/config", async () => ({ wsOrigin: process.env.PUBLIC_WS_ORIGIN || null }));

  app.get("/health", async () => ({
    ok: true,
    anthropic: has("ANTHROPIC_API_KEY"),
    elevenlabs: has("ELEVENLABS_API_KEY"),
    contextDev: has("CONTEXT_DEV_API_KEY"),
    xrpl: has("XRPL_FUND_ISSUER_SEED"),
    bnb: has("BSC_PRIVATE_KEY") && has("ADVOCATE_LEDGER_ADDRESS"),
    ausd: has("AGENT_EVM_PRIVATE_KEY") && has("PAYEE_EVM_PRIVATE_KEY"),
    geminiTrading: has("GEMINI_API_KEY"),
  }));

  app.get("/api/cases", async () => listCases());
  app.get<{ Params: { id: string } }>("/api/cases/:id", async (req, reply) => {
    const c = getCase(req.params.id);
    return c ?? reply.code(404).send({ error: "unknown case" });
  });
  app.register(async (scope) => {
    scope.get<{ Querystring: { case: string } }>("/ws", { websocket: true }, (socket, req) => {
      subscribe(req.query.case, socket);
    });
  });

  for (const r of [billRoutes, researchRoutes, voiceRoutes, xrplRoutes, bnbRoutes, x402Routes, marketRoutes, clinicRoutes, pipelineRoutes, fundRoutes, summaryRoutes, proofRoutes, hospitalRoutes, previewRoutes]) {
    await app.register(r);
  }
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = await buildApp();
  await app.listen({ port: Number(process.env.PORT) || 8787, host: "0.0.0.0" });
}
