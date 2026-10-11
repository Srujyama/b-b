import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { ingestListing } from "./ingest.js";
import { startNegotiation } from "./negotiate.js";
import { handleVapiWebhook } from "./webhook.js";
import { addClient } from "./dashboard.js";
import { getCar, listListings } from "./listings.js";
import { handleSearch, packetCache } from "./search.js";
import type { Car } from "./types.js";

const WEB_DIR = fileURLToPath(new URL("../../web", import.meta.url));

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(websocket);

app.get("/health", async () => ({
  ok: true,
  calls: process.env.CALLS_ENABLED === "true",
  vapi: Boolean(process.env.VAPI_API_KEY),
  vapiPhone: Boolean(process.env.VAPI_PHONE_NUMBER_ID),
  apify: Boolean(process.env.APIFY_TOKEN && process.env.APIFY_ACTOR_ID),
  openai: Boolean(process.env.OPENAI_API_KEY),
  publicDomain: process.env.PUBLIC_DOMAIN ?? null,
  scraper: process.env.SCRAPER_URL ?? "http://localhost:8090",
}));

app.get("/", async (_req, reply) => {
  reply.type("text/html").send(readFileSync(`${WEB_DIR}/index.html`, "utf8"));
});
app.get("/styles.css", async (_req, reply) => {
  reply.type("text/css").send(readFileSync(`${WEB_DIR}/styles.css`, "utf8"));
});
app.get("/intro.js", async (_req, reply) => {
  reply.type("text/javascript").send(readFileSync(`${WEB_DIR}/intro.js`, "utf8"));
});
for (const png of ["lowball.png", "favicon.png", "apple-touch-icon.png"]) {
  app.get(`/${png}`, async (_req, reply) => {
    reply.type("image/png").send(readFileSync(`${WEB_DIR}/${png}`));
  });
}

app.post<{ Body: { query: string; client?: string } }>("/search", async (req, reply) => {
  const query = req.body?.query?.trim();
  if (!query) return reply.code(400).send({ error: "query is required" });
  try {
    const result = await handleSearch(query);
    // Dashboard-compat aliases: web/intro.js renders `criteria` + `cars`
    // (mileage/location/why/hot/target), while the API's native shape is
    // `params` + `cards`. Serve both so neither client breaks.
    const cars = result.cards.map((c) => ({
      id: c.id,
      year: c.year,
      make: c.make,
      model: c.model,
      trim: c.trim,
      price: c.price,
      mileage: c.miles,
      dealer: c.dealer,
      phone: c.phone,
      location: c.city,
      photo: c.photo,
      url: c.url,
      hot: Boolean(c.badge),
      why: (c.badge?.reasons ?? c.reasons)?.join(" · ") || undefined,
      target: packetCache.get(c.id)?.target,
      priceCuts: c.negotiability.priceDrops,
      totalDrop: c.negotiability.totalDrop,
      marketDelta: c.negotiability.marketDelta,
    }));
    return { ...result, criteria: result.params, cars };
  } catch (err) {
    req.log.error(err);
    return reply.code(502).send({ error: (err as Error).message });
  }
});

app.post<{ Body: { url: string } }>("/ingest", async (req, reply) => {
  if (!req.body?.url) return reply.code(400).send({ error: "url is required" });
  return ingestListing(req.body.url);
});

app.get("/listings", async () => listListings());

app.post<{
  Body: { listingId?: string; clientName?: string; dealerPhone?: string; car?: Car };
}>("/negotiate", async (req, reply) => {
  // Calling is switched off on this deployment; the full code path below still
  // works — set CALLS_ENABLED=true (and DEMO_CALL_NUMBER) in server/.env.
  if (process.env.CALLS_ENABLED !== "true") {
    return reply
      .code(503)
      .send({ error: "Phone calling is disabled on this deployment — the demo number has been turned off." });
  }

  const { listingId, clientName, dealerPhone, car: bodyCar } = req.body ?? {};

  // Packet from the last /search wins; fall back to the scraped dataset on
  // disk, then to an inline car body.
  let car: Car | undefined;
  if (listingId) car = packetCache.get(listingId) ?? getCar(listingId);
  car ??= bodyCar;
  if (car && clientName) car = { ...car, clientName };
  if (!car) return reply.code(400).send({ error: "listingId or car is required" });

  try {
    return await startNegotiation(car, dealerPhone);
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: (err as Error).message });
  }
});

app.post("/vapi-webhook", async (req) => handleVapiWebhook(req.body));

app.register(async (scope) => {
  scope.get("/dashboard", { websocket: true }, (conn: any) => {
    addClient(conn.socket ?? conn); // v8 SocketStream vs v10+ WebSocket
  });
});

const port = Number(process.env.PORT) || 8081;
await app.listen({ port, host: "0.0.0.0" });
