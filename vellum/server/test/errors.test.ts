// The shared `{error}` contract (src/routes/errors.ts): what status and what text a client gets for each kind of
// failure, and that an unclassified 500 never hands the client a library's raw message.
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { errorMessage, errorStatus, jsonErrors, redact, rootJsonErrors, upstream } from "../src/routes/errors.js";

const STACK = /\n\s+at |\.ts:\d+:\d+/;

function appWith(install: (a: ReturnType<typeof Fastify>) => void, throwing: unknown) {
  const app = Fastify({ logger: false });
  install(app);
  app.get("/boom", async () => {
    throw throwing;
  });
  app.post("/echo", async (req) => req.body);
  return app;
}

describe("errorStatus / errorMessage", () => {
  it("an unclassified throw is a 500 with a generic message — the library's text (URL, key) is not sent", () => {
    const err = new Error("connect ECONNREFUSED https://api.example.com/v1?api_key=sk-live-abcdefghijklmnopqrstuvwxyz");
    expect(errorStatus(err)).toBe(500);
    const msg = errorMessage(err, 500, "req-7");
    expect(msg).toMatch(/^internal error \(request req-7\)/);
    expect(msg).not.toMatch(/example|api_key|sk-live/);
  });

  it("explicit statusCode and 'not configured' errors keep their (authored) message", () => {
    const notConf = new Error("Claude is not configured — set ANTHROPIC_API_KEY in vellum/server/.env");
    expect(errorStatus(notConf)).toBe(503);
    expect(errorMessage(notConf, 503)).toBe(notConf.message);
    // chain/xrpl.ts deliberately throws a 500 carrying operator instructions (escrow key could not be saved).
    const locked = Object.assign(new Error("100 USD IS LOCKED on-chain in XRPL escrow ABC"), { statusCode: 500 });
    expect(errorStatus(locked)).toBe(500);
    expect(errorMessage(locked, 500)).toBe(locked.message);
    const bad = Object.assign(new Error("months must be 1-24"), { statusCode: 400 });
    expect(errorMessage(bad, errorStatus(bad))).toBe("months must be 1-24");
  });

  it("an upstream() 502 keeps the upstream name but loses URL credentials and query strings", () => {
    const err = upstream("Gemini", new TypeError("fetch failed: https://user:hunter22@api.gemini.com/v1/x?key=SECRET123 refused"));
    expect(errorStatus(err)).toBe(502);
    const msg = errorMessage(err, 502);
    expect(msg).toMatch(/^Gemini is unreachable: fetch failed: https:\/\/api\.gemini\.com\/v1\/x\?…/);
    expect(msg).not.toMatch(/hunter22|SECRET123|user:/);
  });

  it("redact strips bearer tokens and key-shaped strings, leaves ordinary text alone", () => {
    expect(redact("Authorization: Bearer abcdefghijklmnop failed")).toBe("Authorization: Bearer … failed");
    // built at runtime so secret scanners don't flag a fake key in source
    const fakeKey = ["sk", "ant", "api03", "A".repeat(20)].join("-");
    expect(redact(`bad key ${fakeKey}`)).toBe("bad key …");
    expect(redact("unknown case 1234; see https://vellum-app.fly.dev/health")).toBe("unknown case 1234; see https://vellum-app.fly.dev/health");
  });
});

describe("jsonErrors on a live Fastify instance", () => {
  it("an unclassified throw answers JSON 500 {error: generic}, no message, no stack", async () => {
    const app = appWith(jsonErrors, new Error("ENOENT: /secret/path/to/.env?token=abc"));
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.json().error).toMatch(/^internal error \(request [^)]+\) — details are in the server log$/);
    expect(res.body).not.toMatch(/ENOENT|secret|token/);
    expect(res.body).not.toMatch(STACK);
  });

  it("invalid JSON is a 400 {error: reason}", async () => {
    const app = appWith(jsonErrors, new Error("x"));
    const res = await app.inject({ method: "POST", url: "/echo", payload: "{bad", headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not valid JSON/);
  });
});

describe("rootJsonErrors: the one-line buildApp() fix for routes and 404s outside the route plugins", () => {
  // This reproduces what index.ts would do: rootJsonErrors(app) on the root, then register a plugin that does NOT
  // install jsonErrors itself (like bill.ts). Until index.ts calls it, test/no-keys.test.ts pins the old behaviour.
  async function root() {
    const app = Fastify({ logger: false });
    rootJsonErrors(app);
    await app.register(async (child) => {
      child.post("/api/cases", async (req) => req.body);
      child.get("/api/throws", async () => {
        throw new Error("raw library text https://x.test/?k=1");
      });
    });
    return app;
  }

  it("covers invalid JSON in a plugin without its own handler", async () => {
    const app = await root();
    const res = await app.inject({ method: "POST", url: "/api/cases", payload: "{bad", headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: expect.stringMatching(/not valid JSON/) });
  });

  it("covers unclassified throws in that plugin with the generic 500", async () => {
    const app = await root();
    const res = await app.inject({ method: "GET", url: "/api/throws" });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatch(/^internal error/);
  });

  it("an unknown route is a JSON 404 {error}, not Fastify's {statusCode, error:'Not Found', message}", async () => {
    const app = await root();
    const res = await app.inject({ method: "POST", url: "/api/no-such-route?x=1" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "no route POST /api/no-such-route" });
  });
});
