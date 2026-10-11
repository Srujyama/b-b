// No-key robustness audit. Boots the REAL app (buildApp: every route plugin, the real handlers) with every
// key/seed/token env var removed, and probes every registered route with an unknown case id, malformed input
// and a demo-ish case. Each answer must be a real success or a JSON `{error}` 4xx/503 that names the missing
// config or the bad input: never a 500, a hang, an HTML error page, a stack trace or a leaked secret.
//
// Outbound network is cut, not faked into success: global fetch rejects (Gemini, FRED, ElevenLabs, Anthropic,
// Context.dev, viem's HTTP transport all use it) and the xrpl Client cannot connect. A route that needs the
// network therefore has to fail *cleanly* (502 naming the upstream), which is exactly what we assert.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Every route the app registers, recorded as it is registered, so the audit fails if a route is added
// without a probe here.
const registered = vi.hoisted(() => [] as { method: string; url: string }[]);
vi.mock("fastify", async (orig) => {
  const real = await orig<typeof import("fastify")>();
  const factory = ((opts?: unknown) => {
    const app = (real.default as unknown as (o?: unknown) => any)(opts);
    app.addHook("onRoute", (r: { method: string | string[]; url: string }) => {
      for (const m of [r.method].flat()) registered.push({ method: m, url: r.url });
    });
    return app;
  }) as unknown as typeof real.default;
  return { ...real, default: factory, fastify: factory };
});

vi.mock("xrpl", async (orig) => {
  const real = await orig<typeof import("xrpl")>();
  class Client {
    constructor(public url: string) {}
    isConnected() {
      return false;
    }
    async connect() {
      throw new Error("XRPL devnet is unreachable (outbound network disabled in this test)");
    }
    async request() {
      throw new Error("XRPL devnet is unreachable (outbound network disabled in this test)");
    }
    async disconnect() {}
    on() {
      return this;
    }
  }
  return { ...real, Client };
});

// Anything that is a credential, an id of a provisioned resource, or deploy-specific wiring.
const KEY_ENV = /KEY|SECRET|SEED|TOKEN|_ID$|ADDRESS|PRIVATE|^VOICE_JOB_DIR$|^PUBLIC_URL$|^PUBLIC_WS_ORIGIN$|^XRPL_NETWORK$|^ELEVENLABS_|^GEMINI_|^BSC_|^AUSD_|^BASE_SEPOLIA_/;
const saved: Record<string, string> = {};
const secrets: string[] = [];
let app: any;
let fetchCalls = 0;

const T = vi.hoisted(() => ({ ids: {} as Record<string, string> }));

beforeAll(async () => {
  vi.stubGlobal("fetch", async (url: unknown) => {
    fetchCalls++;
    throw new TypeError(`fetch failed (outbound network disabled in this test): ${String(url).slice(0, 60)}`);
  });
  // Import first: src/index.ts runs dotenv/config, which would refill anything deleted before it loads.
  const { buildApp } = await import("../src/index.js");
  for (const k of Object.keys(process.env)) {
    if (!KEY_ENV.test(k)) continue;
    saved[k] = process.env[k]!;
    if (saved[k].length >= 8) secrets.push(saved[k]);
    delete process.env[k];
  }
  app = await buildApp();
  await app.ready();

  const { createCase } = await import("../src/store.js");
  const bill = {
    provider: { name: "Demo General Hospital" },
    lineItems: [{ code: "99285", description: "ER visit level 5", charge: 3200, units: 1 }],
    totalCharges: 3200,
    patientBalance: 3200,
  } as any;
  const patient = { name: "Lin Mei", language: "zh" as const, maxPay: 2500, consent: true };
  T.ids.agreed = createCase({ mode: "patient", status: "agreed", bill, patient, agreedAmount: 1800 }).id;
  T.ids.neg = createCase({ mode: "patient", status: "researched", bill, patient, target: 1500, walkaway: 2500 }).id;
  T.ids.run = createCase({ mode: "patient", status: "audited", bill, patient }).id;
  T.ids.cached = createCase({ mode: "patient", status: "audited", bill: { ...bill, provider: { name: "STANFORD HEALTH CARE" } }, patient }).id;
  T.ids.noConsent = createCase({ mode: "patient", status: "audited", bill, patient: { ...patient, consent: false } }).id;
  T.ids.empty = createCase({ mode: "patient" }).id;
  T.ids.clinic = createCase({ mode: "clinic", status: "agreed", agreedAmount: 10 }).id;
  T.ids.intake = createCase({ mode: "patient" }).id;
});

afterAll(async () => {
  await app?.close();
  Object.assign(process.env, saved);
  vi.unstubAllGlobals();
});

const UNKNOWN = "00000000-0000-0000-0000-000000000000";
const LOAN = "A".repeat(64);
const JSON_CT = { "content-type": "application/json" };
const STACK = /\n\s+at\s|\bat \S+ \(|\.ts:\d+:\d+|node_modules\//;

type Probe = {
  route: string; // "METHOD /registered/:pattern"
  url: string | (() => string);
  payload?: unknown;
  headers?: Record<string, string>;
  status: number;
  match?: RegExp; // must match `error` (or, for a 2xx, the raw body)
};

async function hit(p: Probe) {
  const [method] = p.route.split(" ");
  const url = typeof p.url === "function" ? p.url() : p.url;
  const t0 = Date.now();
  const res = await app.inject({ method, url, ...(p.payload !== undefined ? { payload: p.payload as any } : {}), ...(p.headers ? { headers: p.headers } : {}) });
  return { res, ms: Date.now() - t0, url };
}

/** The invariants every answer must meet, whatever the route. */
function assertClean(res: any, ms: number, label: string) {
  expect(ms, `${label} took ${ms}ms`).toBeLessThan(10_000);
  expect(res.statusCode, `${label}: unhandled 500`).not.toBe(500);
  for (const s of secrets) expect(res.body.includes(s), `${label} leaked a configured secret`).toBe(false);
  expect(res.body, `${label} leaked a stack trace`).not.toMatch(STACK);
  if (res.statusCode >= 400) {
    expect(String(res.headers["content-type"]), `${label}: error must be JSON, not HTML`).toMatch(/application\/json/);
    const body = res.json();
    expect(typeof body.error, `${label}: error body must be {error: string}, got ${res.body}`).toBe("string");
    expect(body.error.length).toBeGreaterThan(3);
    expect(body.error).not.toMatch(/^(Bad Request|Internal Server Error|Service Unavailable|Not Found|Conflict)$/);
  }
}

const caseUrl = (k: string, tail = "") => () => `/api/cases/${k === "unknown" ? UNKNOWN : T.ids[k]}${tail}`;
const NOT_CONFIGURED = (name: string) => new RegExp(`${name}.*not configured|not configured.*${name}`);

// One row per (route, situation). `status` is what the route really answers with no keys and no network.
const PROBES: Probe[] = [
  // ---- index.ts core (+ @fastify/cors preflight)
  { route: "OPTIONS *", url: "/api/cases", headers: { origin: "https://vellum-advocate.vercel.app", "access-control-request-method": "POST" }, status: 204 },
  { route: "GET /health", url: "/health", status: 200, match: /"anthropic":false.*"elevenlabs":false.*"contextDev":false.*"xrpl":false/ },
  { route: "GET /api/config", url: "/api/config", status: 200, match: /"wsOrigin":null/ },
  { route: "GET /api/cases", url: "/api/cases", status: 200 },
  { route: "GET /api/cases/:id", url: caseUrl("unknown"), status: 404, match: /unknown case/ },
  { route: "GET /api/cases/:id", url: caseUrl("agreed"), status: 200, match: /"agreedAmount":1800/ },
  { route: "GET /api/cases/:id", url: "/api/cases/..%2F..%2Fetc%2Fpasswd", status: 404, match: /unknown case/ },

  // ---- bill.ts (intake needs Claude)
  { route: "POST /api/cases", url: "/api/cases", payload: {}, status: 400, match: /No bill provided/ },
  { route: "POST /api/cases", url: "/api/cases", payload: { billText: "x", patient: "notjson" }, status: 400, match: /patient must be a JSON object/ },
  { route: "POST /api/cases", url: "/api/cases", payload: { billText: "x", patient: { name: 5 } }, status: 400, match: /patient\.name is required/ },
  { route: "POST /api/cases", url: "/api/cases", payload: { billText: "ER visit 99285 $3200", patient: { name: "Lin" } }, status: 503, match: NOT_CONFIGURED("ANTHROPIC_API_KEY") },
  // the bundled demo statement is read by the deterministic reader: no key needed
  { route: "POST /api/cases/demo", url: "/api/cases/demo", status: 200, match: /"status":"audited"/ },

  // ---- research.ts (Context.dev + Claude)
  { route: "POST /api/cases/:id/research", url: caseUrl("unknown", "/research"), status: 404, match: /unknown case/ },
  { route: "POST /api/cases/:id/research", url: caseUrl("empty", "/research"), status: 409, match: /no parsed bill/ },
  { route: "POST /api/cases/:id/research", url: caseUrl("run", "/research"), status: 503, match: NOT_CONFIGURED("CONTEXT_DEV_API_KEY") },
  // a hospital with cached research (the seed cache: Stanford) still researches with no keys, in milliseconds
  { route: "POST /api/cases/:id/research", url: caseUrl("cached", "/research"), status: 200, match: /"status":"researched"/ },

  // ---- clinic.ts (Context.dev + Claude)
  { route: "POST /api/claims", url: "/api/claims", payload: {}, status: 400, match: /claim\.payer is required/ },
  { route: "POST /api/claims", url: "/api/claims", payload: { claim: "str" }, status: 400, match: /claim must be an object/ },
  { route: "POST /api/claims", url: "/api/claims", payload: "{bad", headers: JSON_CT, status: 400, match: /not valid JSON/ },
  { route: "POST /api/claims/demo", url: "/api/claims/demo", payload: { fixture: "zzz" }, status: 400, match: /unknown demo denial "zzz"/ },
  { route: "POST /api/claims/demo", url: "/api/claims/demo", payload: {}, status: 503, match: NOT_CONFIGURED("CONTEXT_DEV_API_KEY") },
  { route: "POST /api/claims/demo", url: "/api/claims/demo", payload: { fixture: "sleep" }, status: 503, match: NOT_CONFIGURED("CONTEXT_DEV_API_KEY") },

  // ---- voice.ts (ElevenLabs)
  { route: "GET /api/intake/signed-url", url: "/api/intake/signed-url", status: 503, match: NOT_CONFIGURED("ELEVENLABS_INTAKE_AGENT_ID") },
  { route: "GET /api/intake/signed-url", url: () => `/api/intake/signed-url?case=${UNKNOWN}`, status: 404, match: /unknown case/ },
  { route: "POST /api/cases/:id/negotiate", url: caseUrl("unknown", "/negotiate"), payload: {}, status: 404, match: /unknown case/ },
  { route: "POST /api/cases/:id/negotiate", url: caseUrl("neg", "/negotiate"), payload: { counterparty: "x" }, status: 400, match: /counterparty must be/ },
  { route: "POST /api/cases/:id/negotiate", url: caseUrl("noConsent", "/negotiate"), payload: {}, status: 409, match: /not consented/ },
  // no ElevenLabs AND no Claude: neither voice nor the live-text fallback can run
  { route: "POST /api/cases/:id/negotiate", url: caseUrl("neg", "/negotiate"), payload: { counterparty: "agent" }, status: 503, match: /ANTHROPIC_API_KEY/ },
  { route: "POST /api/cases/:id/negotiate", url: caseUrl("neg", "/negotiate"), payload: { counterparty: "text" }, status: 503, match: /ANTHROPIC_API_KEY/ },
  { route: "POST /api/cases/:id/negotiate", url: caseUrl("neg", "/negotiate"), payload: { counterparty: "human" }, status: 503, match: NOT_CONFIGURED("ELEVENLABS_ADVOCATE_AGENT_ID") },
  { route: "POST /api/cases/:id/negotiate/stop", url: caseUrl("neg", "/negotiate/stop"), status: 404, match: /no negotiation call is running/ },
  { route: "POST /api/cases/:id/voice/transcript", url: caseUrl("neg", "/voice/transcript"), payload: { role: "hospital", text: "Synthetic billing reply", at: "2026-10-11T22:00:00Z" }, status: 401, match: /session is missing or expired/ },
  { route: "POST /api/cases/:id/voice/transcript", url: caseUrl("unknown", "/voice/transcript"), payload: { role: "hospital", text: "Synthetic billing reply", at: "2026-10-11T22:00:00Z" }, status: 401, match: /session is missing or expired/ },
  { route: "POST /api/cases/:id/voice/transcript", url: caseUrl("neg", "/voice/transcript"), payload: {}, status: 400, match: /required property/ },
  { route: "POST /api/eleven/tools/:name", url: "/api/eleven/tools/log_offer", payload: {}, status: 400, match: /case_id is required/ },
  { route: "POST /api/eleven/tools/:name", url: "/api/eleven/tools/log_offer", payload: "null", headers: JSON_CT, status: 400, match: /case_id is required/ },
  { route: "POST /api/eleven/tools/:name", url: "/api/eleven/tools/log_offer", payload: { case_id: 7 }, status: 400, match: /case_id is required/ },
  { route: "POST /api/eleven/tools/:name", url: "/api/eleven/tools/log_offer", payload: "{bad", headers: JSON_CT, status: 400, match: /not valid JSON/ },
  { route: "POST /api/eleven/tools/:name", url: "/api/eleven/tools/log_offer", payload: { case_id: UNKNOWN, amount: 1 }, status: 404, match: /unknown case/ },

  // ---- haiku.ts custom-LLM endpoints (bearer token + Anthropic)
  { route: "POST /api/voice/llm/v1/chat/completions", url: "/api/voice/llm/v1/chat/completions", payload: {}, status: 503, match: NOT_CONFIGURED("VOICE_LLM_TOKEN") },
  { route: "POST /api/voice/llm/v1/chat/completions", url: "/api/voice/llm/v1/chat/completions", payload: "{bad", headers: JSON_CT, status: 400, match: /not valid JSON/ },
  { route: "POST /api/voice/browser/llm/v1/chat/completions", url: "/api/voice/browser/llm/v1/chat/completions", payload: {}, status: 503, match: NOT_CONFIGURED("VOICE_LLM_TOKEN") },

  // ---- calls.ts phone-call orchestration (bearer token, job dir, ElevenLabs)
  { route: "GET /api/voice/ready", url: "/api/voice/ready", status: 503, match: NOT_CONFIGURED("VOICE_ORCHESTRATOR_TOKEN") },
  { route: "GET /api/voice/options", url: "/api/voice/options", status: 503, match: NOT_CONFIGURED("VOICE_ORCHESTRATOR_TOKEN") },
  { route: "POST /api/voice/jobs/preview", url: "/api/voice/jobs/preview", payload: {}, status: 503, match: NOT_CONFIGURED("VOICE_ORCHESTRATOR_TOKEN") },
  { route: "POST /api/voice/jobs", url: "/api/voice/jobs", payload: {}, status: 503, match: NOT_CONFIGURED("VOICE_ORCHESTRATOR_TOKEN") },
  { route: "GET /api/voice/jobs/:id", url: "/api/voice/jobs/x", status: 503, match: NOT_CONFIGURED("VOICE_ORCHESTRATOR_TOKEN") },
  { route: "POST /api/voice/jobs/:id/refresh", url: "/api/voice/jobs/x/refresh", status: 503, match: NOT_CONFIGURED("VOICE_ORCHESTRATOR_TOKEN") },
  { route: "POST /api/voice/jobs/:id/reconcile", url: "/api/voice/jobs/x/reconcile", payload: {}, status: 503, match: NOT_CONFIGURED("VOICE_ORCHESTRATOR_TOKEN") },
  { route: "POST /api/voice/webhooks/elevenlabs", url: "/api/voice/webhooks/elevenlabs", payload: {}, status: 503, match: NOT_CONFIGURED("ELEVENLABS_WEBHOOK_SECRET") },
  { route: "POST /api/voice/webhooks/elevenlabs", url: "/api/voice/webhooks/elevenlabs", payload: "{bad", headers: JSON_CT, status: 503, match: NOT_CONFIGURED("ELEVENLABS_WEBHOOK_SECRET") },

  // ---- xrpl.ts (XRPL seeds)
  { route: "POST /api/cases/:id/credential", url: caseUrl("unknown", "/credential"), status: 404, match: /unknown case/ },
  { route: "POST /api/cases/:id/credential", url: caseUrl("agreed", "/credential"), status: 503, match: NOT_CONFIGURED("XRPL_FUND_ISSUER_SEED") },
  { route: "POST /api/cases/:id/settle", url: caseUrl("unknown", "/settle"), status: 404, match: /unknown case/ },
  { route: "POST /api/cases/:id/settle", url: caseUrl("empty", "/settle"), status: 409, match: /no agreedAmount/ },
  { route: "POST /api/cases/:id/settle", url: caseUrl("agreed", "/settle"), status: 503, match: NOT_CONFIGURED("XRPL_FUND_ISSUER_SEED") },
  { route: "POST /api/cases/:id/confirm-zero-balance", url: caseUrl("unknown", "/confirm-zero-balance"), status: 404, match: /unknown case/ },
  { route: "POST /api/cases/:id/confirm-zero-balance", url: caseUrl("agreed", "/confirm-zero-balance"), status: 409, match: /no open escrow/ },
  { route: "POST /api/cases/:id/loan", url: caseUrl("unknown", "/loan"), payload: {}, status: 404, match: /unknown case/ },
  { route: "POST /api/cases/:id/loan", url: caseUrl("agreed", "/loan"), payload: { months: 0 }, status: 400, match: /months must be an integer 1-60/ },
  { route: "POST /api/cases/:id/loan", url: caseUrl("agreed", "/loan"), payload: { months: "abc" }, status: 400, match: /months must be an integer 1-60/ },
  { route: "POST /api/cases/:id/loan", url: caseUrl("agreed", "/loan"), payload: "{bad", headers: JSON_CT, status: 400, match: /not valid JSON/ },
  { route: "POST /api/cases/:id/loan", url: caseUrl("empty", "/loan"), payload: {}, status: 409, match: /no agreedAmount/ },
  { route: "POST /api/cases/:id/loan", url: caseUrl("agreed", "/loan"), payload: { months: 6 }, status: 503, match: NOT_CONFIGURED("XRPL_VAULT_ID") },

  // ---- bnb.ts (BSC key + deployed contract)
  { route: "POST /api/cases/:id/mandate", url: caseUrl("unknown", "/mandate"), status: 404, match: /unknown case/ },
  { route: "POST /api/cases/:id/mandate", url: caseUrl("agreed", "/mandate"), status: 503, match: NOT_CONFIGURED("ADVOCATE_LEDGER_ADDRESS") },
  { route: "GET /api/cases/:id/ledger", url: caseUrl("unknown", "/ledger"), status: 404, match: /unknown case/ },
  { route: "GET /api/cases/:id/ledger", url: caseUrl("agreed", "/ledger"), status: 503, match: NOT_CONFIGURED("ADVOCATE_LEDGER_ADDRESS") },

  // ---- x402.ts (payee key)
  { route: "GET /api/x402/payments", url: "/api/x402/payments", status: 200, match: /^\[/ },
  { route: "GET /x402/fair-price", url: "/x402/fair-price", status: 400, match: /code is required/ },
  { route: "GET /x402/fair-price", url: "/x402/fair-price?code=99285", status: 503, match: /PAYEE_EVM_PRIVATE_KEY/ },
  { route: "GET /x402/fair-price", url: "/x402/fair-price?code=99285", headers: { "payment-signature": "!!not-base64" }, status: 503, match: /PAYEE_EVM_PRIVATE_KEY/ },
  { route: "POST /x402/appeal", url: "/x402/appeal", payload: {}, status: 400, match: /must be a ClaimCase/ },
  { route: "POST /x402/appeal", url: "/x402/appeal", payload: "{bad", headers: JSON_CT, status: 400, match: /not valid JSON/ },
  { route: "POST /x402/appeal", url: "/x402/appeal", payload: { payer: "Aetna", procedure: { code: "72148" } }, status: 503, match: /PAYEE_EVM_PRIVATE_KEY/ },

  // ---- markets.ts (public Gemini + FRED: keyless, but the network is cut here -> clean 502)
  { route: "GET /api/markets/fed", url: "/api/markets/fed", status: 502, match: /Gemini prediction-markets API is unreachable/ },
  { route: "POST /api/cases/:id/financing", url: caseUrl("unknown", "/financing"), payload: {}, status: 404, match: /unknown case/ },
  { route: "POST /api/cases/:id/financing", url: caseUrl("empty", "/financing"), payload: {}, status: 409, match: /no agreedAmount, target or bill balance/ },
  { route: "POST /api/cases/:id/financing", url: caseUrl("agreed", "/financing"), payload: { lumpSumDiscountPct: "abc" }, status: 400, match: /lumpSumDiscountPct must be/ },
  { route: "POST /api/cases/:id/financing", url: caseUrl("agreed", "/financing"), payload: { planMonths: -3 }, status: 400, match: /planMonths must be an integer/ },
  { route: "POST /api/cases/:id/financing", url: caseUrl("agreed", "/financing"), payload: { fundLumpSumWith: "crypto" }, status: 400, match: /fundLumpSumWith/ },
  { route: "POST /api/cases/:id/financing", url: caseUrl("agreed", "/financing"), payload: "[1]", headers: JSON_CT, status: 400, match: /body must be a JSON object/ },
  { route: "POST /api/cases/:id/financing", url: caseUrl("agreed", "/financing"), payload: "{bad", headers: JSON_CT, status: 400, match: /not valid JSON/ },
  { route: "POST /api/cases/:id/financing", url: caseUrl("agreed", "/financing"), payload: {}, status: 502, match: /is unreachable/ },
  { route: "POST /api/cases/:id/hedge", url: caseUrl("unknown", "/hedge"), payload: {}, status: 404, match: /unknown case/ },
  { route: "POST /api/cases/:id/hedge", url: caseUrl("agreed", "/hedge"), payload: {}, status: 503, match: NOT_CONFIGURED("GEMINI_API_KEY") },

  // ---- fund.ts (XRPL vault ids)
  { route: "GET /api/fund", url: "/api/fund", status: 503, match: NOT_CONFIGURED("XRPL_VAULT_ID") },
  { route: "GET /api/fund/donors", url: "/api/fund/donors", status: 503, match: NOT_CONFIGURED("XRPL_VAULT_ID") },
  { route: "POST /api/fund/loans/:loanId/pay", url: "/api/fund/loans/bad/pay", payload: {}, status: 400, match: /64-hex/ },
  { route: "POST /api/fund/loans/:loanId/pay", url: `/api/fund/loans/${LOAN}/pay`, payload: {}, status: 400, match: /caseId is required/ },
  { route: "POST /api/fund/loans/:loanId/pay", url: `/api/fund/loans/${LOAN}/pay`, payload: { caseId: UNKNOWN }, status: 404, match: /unknown case/ },
  { route: "POST /api/fund/loans/:loanId/pay", url: `/api/fund/loans/${LOAN}/pay`, payload: "{bad", headers: JSON_CT, status: 400, match: /not valid JSON/ },
  { route: "POST /api/fund/loans/:loanId/pay", url: () => `/api/fund/loans/${LOAN}/pay`, payload: undefined, status: 400, match: /caseId is required/ },

  // ---- summary.ts (text is keyless; audio needs ElevenLabs)
  { route: "GET /api/cases/:id/summary", url: caseUrl("unknown", "/summary"), status: 404, match: /unknown case/ },
  { route: "GET /api/cases/:id/leverage", url: caseUrl("unknown", "/leverage"), status: 404, match: /unknown case/ },
  { route: "GET /api/cases/:id/leverage", url: caseUrl("agreed", "/leverage"), status: 200, match: /score/ },
  { route: "GET /api/cases/:id/summary", url: caseUrl("agreed", "/summary"), status: 200, match: /1,?800/ },
  { route: "GET /api/cases/:id/summary", url: caseUrl("empty", "/summary"), status: 200, match: /No price has been agreed/ },
  { route: "GET /api/cases/:id/summary.mp3", url: caseUrl("unknown", "/summary.mp3"), status: 404, match: /unknown case/ },
  { route: "GET /api/cases/:id/summary.mp3", url: caseUrl("agreed", "/summary.mp3"), status: 503, match: NOT_CONFIGURED("ELEVENLABS_API_KEY") },

  // ---- proof.ts (keyless: on-chain head is reported as not deployed)
  { route: "GET /api/cases/:id/proof", url: caseUrl("unknown", "/proof"), status: 404, match: /unknown case/ },
  { route: "GET /api/cases/:id/proof", url: caseUrl("agreed", "/proof"), status: 200, match: /vellum-proof\/v1/ },
  { route: "GET /api/cases/:id/proof", url: () => `/api/cases/${T.ids.agreed}/proof?download=1`, status: 200, match: /vellum-proof\/v1/ },
  { route: "GET /api/cases/:id/proof", url: caseUrl("clinic", "/proof"), status: 200, match: /vellum-proof\/v1/ },

  // ---- hospital.ts (portal reads are local; ledger check + release need XRPL)
  { route: "GET /api/hospital/cases", url: "/api/hospital/cases", status: 200, match: /^\[/ },
  { route: "GET /api/hospital/cases/:id", url: () => `/api/hospital/cases/${UNKNOWN}`, status: 404, match: /unknown case/ },
  { route: "GET /api/hospital/cases/:id", url: () => `/api/hospital/cases/${T.ids.empty}`, status: 409, match: /no agreed amount/ },
  { route: "GET /api/hospital/cases/:id", url: () => `/api/hospital/cases/${T.ids.agreed}`, status: 200, match: /"stage":"awaiting_escrow"/ },
  { route: "GET /api/hospital/cases/:id/ledger", url: () => `/api/hospital/cases/${UNKNOWN}/ledger`, status: 404, match: /unknown case/ },
  { route: "GET /api/hospital/cases/:id/ledger", url: () => `/api/hospital/cases/${T.ids.agreed}/ledger`, status: 503, match: NOT_CONFIGURED("XRPL_FUND_ISSUER_SEED") },
  { route: "POST /api/hospital/cases/:id/confirm-zero-balance", url: () => `/api/hospital/cases/${UNKNOWN}/confirm-zero-balance`, payload: { attest: true }, status: 404, match: /unknown case/ },
  { route: "POST /api/hospital/cases/:id/confirm-zero-balance", url: () => `/api/hospital/cases/${T.ids.agreed}/confirm-zero-balance`, payload: { attest: false }, status: 400, match: /attest must be true/ },
  { route: "POST /api/hospital/cases/:id/confirm-zero-balance", url: () => `/api/hospital/cases/${T.ids.agreed}/confirm-zero-balance`, payload: '"x"', headers: JSON_CT, status: 400, match: /attest must be true/ },
  { route: "POST /api/hospital/cases/:id/confirm-zero-balance", url: () => `/api/hospital/cases/${T.ids.agreed}/confirm-zero-balance`, payload: "{bad", headers: JSON_CT, status: 400, match: /not valid JSON/ },
  { route: "POST /api/hospital/cases/:id/confirm-zero-balance", url: () => `/api/hospital/cases/${T.ids.agreed}/confirm-zero-balance`, payload: { attest: true }, status: 409, match: /no open escrow/ },

  // ---- pipeline.ts (validation; the async run itself is checked separately below)
  { route: "POST /api/cases/:id/run", url: caseUrl("unknown", "/run"), payload: {}, status: 404, match: /unknown case/ },
  { route: "POST /api/cases/:id/run", url: caseUrl("run", "/run"), payload: { counterparty: "bad" }, status: 400, match: /counterparty must be/ },
  { route: "POST /api/cases/:id/run", url: caseUrl("run", "/run"), payload: { confirm: "maybe" }, status: 400, match: /confirm must be/ },
  { route: "POST /api/cases/:id/run", url: caseUrl("run", "/run"), payload: { hospitalTimeoutMs: -1 }, status: 400, match: /hospitalTimeoutMs/ },
  { route: "POST /api/cases/:id/run", url: caseUrl("empty", "/run"), payload: {}, status: 409, match: /no parsed bill/ },
  { route: "GET /api/cases/:id/run", url: caseUrl("unknown", "/run"), status: 404, match: /no pipeline run/ },
];

describe("no API keys: every route answers cleanly", () => {
  it.each(PROBES.map((p, i) => [`${p.route} #${i}`, p] as const))("%s", async (_label, p) => {
    const { res, ms, url } = await hit(p);
    const label = `${p.route} (${url})`;
    assertClean(res, ms, label);
    expect(res.statusCode, `${label} -> ${res.body.slice(0, 300)}`).toBe(p.status);
    if (p.match) expect(res.statusCode >= 400 ? res.json().error : res.body).toMatch(p.match);
  });

  it("covers every route the server registers", () => {
    const routes = new Set(registered.filter((r) => r.method !== "HEAD").map((r) => `${r.method} ${r.url}`));
    // not API: the @fastify/static catch-all and the websocket upgrade route are checked in their own test
    routes.delete("GET /*");
    routes.delete("GET /ws");
    const probed = new Set(PROBES.map((p) => p.route).concat(["POST /api/cases/:id/run", "GET /api/cases/:id/run"]));
    expect([...routes].filter((r) => !probed.has(r)), "registered routes with no probe").toEqual([]);
    expect(routes.size).toBeGreaterThanOrEqual(45); // 48 at the time of the audit
  });

  it("the tool webhook records a negotiation end to end with no keys (how a human/agent logs offers)", async () => {
    const post = (name: string, body: Record<string, unknown>) =>
      app.inject({ method: "POST", url: `/api/eleven/tools/${name}`, payload: { case_id: T.ids.neg, ...body } });
    const steps = [
      [await post("log_offer", { amount: "abc" }), false, /non-negative numeric amount/],
      [await post("log_offer", { amount: 2900 }), true, /above your ceiling/],
      [await post("accept_offer", { amount: 2900 }), false, /REFUSED/],
      [await post("log_offer", { amount: 1400 }), true, /at or below your goal/],
      [await post("accept_offer", { amount: 1400 }), true, /Accepted at 1400/],
      [await post("accept_offer", { amount: 1300 }), false, /already recorded at 1400/],
      [await post("end_call", {}), false, /outcome/],
      [await post("end_call", { outcome: "deal" }), true, /deal/],
      [await post("bogus_tool", {}), false, /unknown tool/],
    ] as const;
    for (const [res, ok, msg] of steps) {
      assertClean(res, 0, "tool webhook");
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(ok);
      expect(res.json().message).toMatch(msg);
    }
    const c = (await app.inject({ method: "GET", url: `/api/cases/${T.ids.neg}` })).json();
    expect(c.agreedAmount).toBe(1400);
    expect(c.status).toBe("agreed");

    const intake = await app.inject({ method: "POST", url: "/api/eleven/tools/submit_intake", payload: { case_id: T.ids.intake, name: "Lin", max_pay: "abc" } });
    expect(intake.json()).toMatchObject({ ok: false, message: expect.stringMatching(/positive max_pay/) });
    const intake2 = await app.inject({ method: "POST", url: "/api/eleven/tools/submit_intake", payload: { case_id: T.ids.intake, name: "Lin", max_pay: 900, consent: true } });
    expect(intake2.json().ok).toBe(true);
  });

  it("POST /run with no keys is accepted, then fails fast with the missing config named (no hang)", async () => {
    const start = await app.inject({ method: "POST", url: `/api/cases/${T.ids.run}/run`, payload: {} });
    assertClean(start, 0, "POST /run");
    expect(start.statusCode).toBe(202);
    const t0 = Date.now();
    let run: any;
    do {
      run = (await app.inject({ method: "GET", url: `/api/cases/${T.ids.run}/run` })).json();
      if (run.status !== "running") break;
      await new Promise((r) => setTimeout(r, 20));
    } while (Date.now() - t0 < 10_000);
    expect(run.status).toBe("failed");
    const failed = run.steps.find((s: any) => s.status === "failed");
    expect(failed.name).toBe("research");
    expect(failed.message).toMatch(/CONTEXT_DEV_API_KEY|not configured/);
    expect(JSON.stringify(run)).not.toMatch(STACK);
  });

  it("static files serve; an unknown path is a JSON 404, not an HTML page; /ws refuses plain HTTP", async () => {
    const index = await app.inject({ method: "GET", url: "/" });
    expect(index.statusCode).toBe(200);
    expect(index.headers["content-type"]).toMatch(/text\/html/);
    const missing = await app.inject({ method: "GET", url: "/no-such-page.js" });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["content-type"]).toMatch(/application\/json/);
    const missingApi = await app.inject({ method: "POST", url: "/api/no-such-route" });
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.json().message).toMatch(/not found/i);
    // @fastify/websocket answers a non-upgrade GET with an empty 404 (see bugsFound: no JSON body).
    const ws = await app.inject({ method: "GET", url: "/ws?case=x" });
    expect(ws.statusCode).toBe(404);
    expect(ws.body).not.toMatch(STACK);
  });

  // Known bugs in files this audit may not edit (bill.ts / index.ts). `it.fails` passes while the bug is there and
  // turns red once it is fixed, so whoever fixes it flips these to plain `it`. The JSON one (and the unknown-route
  // `.message` assertion above) is fixed by one line in index.ts buildApp(), right after Fastify():
  //   rootJsonErrors(app);   // import { rootJsonErrors } from "./routes/errors.js"
  // test/errors.test.ts already proves that helper on a root-plus-plugin app shaped like this one.
  it.fails("POST /api/cases with a truncated multipart body is a 400, not a 500 (bill.ts readIntake)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/cases", payload: "garbage", headers: { "content-type": "multipart/form-data; boundary=zz" } });
    assertClean(res, 0, "POST /api/cases multipart");
    expect(res.statusCode).toBe(400);
  });
  it.fails("POST /api/cases with invalid JSON answers {error: <reason>} (bill.ts / index.ts have no {error} handler)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/cases", payload: "{bad", headers: JSON_CT });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not valid JSON/);
  });

  it("no route reached the internet except the keyless public market feeds", () => {
    // Only /api/markets/fed and /financing (Gemini + FRED, both public) may even try; everything else must stop at config.
    expect(fetchCalls).toBeLessThanOrEqual(4);
  });
});

describe("XRPL seeds configured but devnet unreachable: chain routes fail as a clean 502", () => {
  const XRPL_ENV = ["XRPL_FUND_ISSUER_SEED", "XRPL_PATIENT_SEED", "XRPL_HOSPITAL_SEED", "XRPL_CLINIC_SEED", "XRPL_ADVOCATE_SEED", "XRPL_VAULT_ID", "XRPL_LOAN_BROKER_ID"];
  beforeAll(async () => {
    const { Wallet } = await import("xrpl");
    // Throwaway wallets and ids: this suite never depends on (or prints) the real .env.
    for (const k of XRPL_ENV) process.env[k] = k.endsWith("_SEED") ? Wallet.generate().seed! : "B".repeat(64);
  });
  afterAll(() => {
    for (const k of XRPL_ENV) delete process.env[k];
  });

  const CHAIN: Probe[] = [
    { route: "POST /api/cases/:id/credential", url: caseUrl("agreed", "/credential"), status: 502 },
    { route: "POST /api/cases/:id/settle", url: caseUrl("agreed", "/settle"), status: 502 },
    { route: "POST /api/cases/:id/loan", url: caseUrl("agreed", "/loan"), payload: { months: 6 }, status: 502 },
    { route: "GET /api/hospital/cases/:id/ledger", url: () => `/api/hospital/cases/${T.ids.agreed}/ledger`, status: 502 },
    { route: "GET /api/fund", url: "/api/fund", status: 502 },
    { route: "GET /api/fund/donors", url: "/api/fund/donors", status: 502 },
    { route: "POST /api/fund/loans/:loanId/pay", url: `/api/fund/loans/${LOAN}/pay`, payload: { caseId: "set-below" }, status: 502 },
  ];
  it.each(CHAIN.map((p) => [p.route, p] as const))("%s", async (_l, p) => {
    if (p.route.includes("/pay")) p.payload = { caseId: T.ids.agreed };
    const { res, ms, url } = await hit(p);
    assertClean(res, ms, `${p.route} (${url})`);
    expect(res.statusCode, res.body).toBe(p.status);
    expect(res.json().error).toMatch(/XRPL devnet is unreachable/);
  });

  it("/health reports XRPL configured while the other integrations stay false", async () => {
    const h = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(h).toMatchObject({ xrpl: true, anthropic: false, elevenlabs: false, contextDev: false, bnb: false, ausd: false, geminiTrading: false });
  });
});
