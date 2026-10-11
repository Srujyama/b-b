import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { generatePrivateKey } from "viem/accounts";

// No network: the paid research call is mocked at the boundary; x402 settlement is injected.
vi.mock("../src/research/fairprice.js", () => ({
  lookupFairPrice: vi.fn(async (code: string, description: string) => ({
    code,
    description,
    medicareRate: 400,
    sources: [{ title: "CMS PFS", url: "https://www.cms.gov/x", via: "cms" }],
  })),
}));

import { createCase, emit, requireCase, subscribe } from "../src/store.js";
import type { CaseEvent, CasePacket, FinancingAdvice, Receipt } from "../src/types.js";
import { handleTool } from "../src/agent/tools.js";
import pipelineRoutes, {
  _resetRuns,
  assertRunnable,
  getRun,
  injectFetch,
  ledgerSink,
  paidFairPrice,
  runPipeline,
  type PipelineDeps,
} from "../src/routes/pipeline.js";
import x402Routes from "../src/routes/x402.js";
import voiceRoutes from "../src/routes/voice.js";
import * as x402 from "../src/chain/x402.js";

const bill = {
  provider: { name: "Stanford Health Care" },
  lineItems: [{ code: "99285", description: "ED VISIT LEVEL 5", qty: 1, charge: 3412 }],
  totalCharges: 3412,
  patientBalance: 3412,
};

function patientCase(over: Partial<CasePacket> = {}): CasePacket {
  return createCase({
    mode: "patient",
    status: "audited",
    bill,
    patient: { name: "Lin Mei", language: "zh", householdSize: 3, annualIncome: 41000, maxPay: 2500, consent: true },
    ...over,
  });
}

function events(id: string) {
  const got: CaseEvent[] = [];
  subscribe(id, { readyState: 1, send: (d: string) => got.push(JSON.parse(d)), on() {} } as any);
  return got;
}

const rcpt = (chain: Receipt["chain"], kind: string, txHash: string): Receipt => ({ chain, kind, txHash, explorerUrl: `https://x/${txHash}`, at: new Date().toISOString() });

/** Fake deps that behave like the real modules (state changes + receipts) without any network. */
function fakeDeps(over: Partial<PipelineDeps> = {}) {
  const calls: string[] = [];
  const appended: { kind: string; by: string; amount?: number; text?: string }[] = [];
  const escrows = new Map<string, string>();
  const deps: PipelineDeps = {
    async research(id) {
      calls.push("research");
      const c = requireCase(id);
      c.target = 1200;
      c.opening = 900;
      c.walkaway = 2500;
      c.facts = ["fact"];
      c.status = "researched";
    },
    async financing(id) {
      calls.push("financing");
      const a: FinancingAdvice = { recommendation: "lump_sum", reason: "rates expected to fall", sources: [] };
      requireCase(id).financing = a;
      return a;
    },
    async mandate(id) {
      calls.push("mandate");
      requireCase(id).receipts.push(rcpt("bsc", "openMandate", "0xm"));
    },
    async credential(id) {
      calls.push("credential");
      requireCase(id).receipts.push(rcpt("xrpl", "CredentialAccept", "CA"));
    },
    async negotiate(id, counterparty) {
      calls.push(`negotiate:${counterparty}`);
      const at = new Date().toISOString();
      const line = { role: "hospital", text: "We can do 1800.", at };
      requireCase(id).transcript.push(line);
      emit(id, { type: "transcript", line });
      handleTool(id, "log_offer", { amount: 1800 });
      handleTool(id, "accept_offer", { amount: 1800 });
    },
    async loan() {
      calls.push("loan");
    },
    async settle(id) {
      calls.push("settle");
      escrows.set(id, "ESCROWTX");
      return [rcpt("xrpl", "EscrowCreate", "ESCROWTX")];
    },
    async recordDeal(_id, amount, ref) {
      calls.push(`recordDeal:${amount}:${ref}`);
    },
    async confirm(id) {
      calls.push("confirm");
      escrows.delete(id);
      requireCase(id).status = "settled";
    },
    openEscrow: (id) => escrows.get(id),
    async appendLog(_id, body) {
      appended.push(body);
    },
    bnbConfigured: () => true,
    fundConfigured: () => false,
    ...over,
  };
  return { deps, calls, appended };
}

beforeEach(() => _resetRuns());

describe("assertRunnable", () => {
  it("refuses without consent, a mandate or a bill", () => {
    expect(() => assertRunnable(patientCase({ patient: { name: "x", language: "zh", maxPay: 2500, consent: false } }))).toThrow(/consented/);
    expect(() => assertRunnable(patientCase({ patient: { name: "x", language: "zh", maxPay: 0, consent: true } }))).toThrow(/maxPay/);
    expect(() => assertRunnable(patientCase({ bill: undefined }))).toThrow(/bill/);
    expect(() => assertRunnable(createCase({ mode: "clinic" }))).toThrow(/claim/);
    expect(() => assertRunnable(patientCase())).not.toThrow();
  });
});

describe("runPipeline", () => {
  it("runs every step in order, hash-chains the negotiation onto BNB, records the deal with the escrow ref, settles", async () => {
    const c = patientCase();
    const ev = events(c.id);
    const { deps, calls, appended } = fakeDeps();
    const run = await runPipeline(c.id, deps, { counterparty: "agent" });

    expect(run.status).toBe("done");
    expect(calls).toEqual(["research", "financing", "mandate", "credential", "negotiate:agent", "settle", "recordDeal:1800:ESCROWTX", "confirm"]);
    expect(run.steps.map((s) => [s.name, s.status])).toEqual([
      ["research", "ok"],
      ["financing", "ok"],
      ["mandate", "ok"],
      ["credential", "ok"],
      ["negotiate", "ok"],
      ["loan", "skipped"],
      ["settle", "ok"],
      ["recordDeal", "ok"],
      ["confirm", "ok"],
    ]);
    // transcript turn + hospital offer + advocate acceptance all went to the ledger, in order
    expect(appended.map((a) => `${a.kind}:${a.by}:${a.amount ?? a.text}`)).toEqual([
      "transcript:hospital:We can do 1800.",
      "offer:hospital:1800",
      "offer:advocate:1800",
    ]);
    expect(requireCase(c.id).status).toBe("settled");
    // every step logs in both languages
    const logs = ev.filter((e): e is Extract<CaseEvent, { type: "log" }> => e.type === "log");
    expect(logs.length).toBeGreaterThan(8);
    expect(logs.every((l) => l.message && l.messageZh)).toBe(true);
    expect(getRun(c.id)?.status).toBe("done");
  });

  it("stops loudly when research fails: later steps never run, case is failed", async () => {
    const c = patientCase();
    const ev = events(c.id);
    const { deps, calls } = fakeDeps({
      research: async () => {
        throw new Error("Context.dev is not configured — set CONTEXT_DEV_API_KEY");
      },
    });
    const run = await runPipeline(c.id, deps);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/CONTEXT_DEV_API_KEY/);
    expect(calls).toEqual([]);
    expect(run.steps.find((s) => s.name === "research")?.status).toBe("failed");
    expect(run.steps.filter((s) => s.name !== "research").every((s) => s.status === "skipped")).toBe(true);
    expect(requireCase(c.id).status).toBe("failed");
    expect(ev.some((e) => e.type === "error" && /CONTEXT_DEV_API_KEY/.test(e.message))).toBe(true);
  });

  it("reports a failed BNB mandate, keeps negotiating under the off-chain guard, and skips the on-chain deal record", async () => {
    const c = patientCase();
    const ev = events(c.id);
    const { deps, calls, appended } = fakeDeps({
      mandate: async () => {
        throw new Error("BSC_PRIVATE_KEY is not configured");
      },
    });
    const run = await runPipeline(c.id, deps);
    expect(run.status).toBe("done");
    expect(run.steps.find((s) => s.name === "mandate")).toMatchObject({ status: "failed", message: expect.stringMatching(/BSC_PRIVATE_KEY/) });
    expect(run.steps.find((s) => s.name === "recordDeal")?.status).toBe("skipped");
    expect(appended).toEqual([]); // no mandate => no ledger to append to
    expect(calls).toContain("confirm");
    expect(ev.some((e) => e.type === "error" && /mandate/i.test(e.message))).toBe(true);
  });

  it("BNB not live: the mandate step is skipped (not a failure) and the deal still settles on XRPL", async () => {
    const c = patientCase();
    const { deps, calls } = fakeDeps({ bnbConfigured: () => false });
    const run = await runPipeline(c.id, deps);
    expect(run.status).toBe("done");
    expect(calls).not.toContain("mandate");
    expect(run.steps.find((s) => s.name === "mandate")).toMatchObject({ status: "skipped", message: expect.stringMatching(/not live/) });
    expect(run.steps.filter((s) => s.status === "failed")).toEqual([]);
    expect(calls).toContain("settle");
  });

  it("a call without a deal fails the run and nothing settles", async () => {
    const c = patientCase();
    const { deps, calls } = fakeDeps({ negotiate: async () => {} });
    const run = await runPipeline(c.id, deps);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/without a deal/);
    expect(calls).not.toContain("settle");
    // never stuck in "negotiating": back to researched so the user can simply run it again
    expect(requireCase(c.id).status).toBe("researched");
    const ev = events(c.id);
    const retry = await runPipeline(c.id, fakeDeps().deps);
    expect(retry.status).toBe("done");
    expect(retry.steps.find((s) => s.name === "research")?.status).toBe("skipped");
    expect(requireCase(c.id).status).toBe("settled");
    expect(ev.some((e) => e.type === "deal")).toBe(true);
  });

  it("a call that errors (e.g. voice credits exhausted) also returns the case to researched with a retry hint", async () => {
    const c = patientCase();
    const ev = events(c.id);
    const { deps } = fakeDeps({
      negotiate: async (id) => {
        requireCase(id).status = "negotiating";
        throw new Error("ElevenLabs quota exceeded");
      },
    });
    const run = await runPipeline(c.id, deps);
    expect(run.status).toBe("failed");
    expect(requireCase(c.id).status).toBe("researched");
    expect(ev.some((e) => e.type === "log" && /back to researched/.test(e.message))).toBe(true);
  });

  it("opens the 0% loan when her wallet cannot cover the deal, even if Gemini says lump sum", async () => {
    const c = patientCase();
    const { deps, calls } = fakeDeps({ fundConfigured: () => true, patientWalletUsd: async () => 500 });
    const run = await runPipeline(c.id, deps);
    expect(run.status).toBe("done");
    expect(calls.indexOf("loan")).toBeGreaterThan(-1);
    expect(calls.indexOf("loan")).toBeLessThan(calls.indexOf("settle"));
    // a full wallet + lump-sum advice: no loan
    const c2 = patientCase();
    const full = fakeDeps({ fundConfigured: () => true, patientWalletUsd: async () => 50_000 });
    await runPipeline(c2.id, full.deps);
    expect(full.calls).not.toContain("loan");
    expect(getRun(c2.id)?.steps.find((s) => s.name === "loan")?.message).toMatch(/wallet covers/);
  });

  it("a $0 deal is a write-off: no loan, no escrow, the hospital confirms and the case settles", async () => {
    const c = patientCase();
    const { deps, calls } = fakeDeps({
      negotiate: async (id) => {
        handleTool(id, "accept_offer", { amount: 0 });
      },
      patientWalletUsd: async () => 0,
      fundConfigured: () => true,
      financing: async (id) => (requireCase(id).financing = { recommendation: "payment_plan", reason: "x", sources: [] }),
      confirm: async (id) => {
        calls.push("confirm");
        requireCase(id).status = "settled";
      },
    });
    const run = await runPipeline(c.id, deps);
    expect(run.status).toBe("done");
    expect(calls).not.toContain("loan");
    expect(calls).not.toContain("settle");
    expect(calls).toContain("recordDeal:0:write-off (no escrow)");
    expect(calls).toContain("confirm");
    expect(run.steps.find((s) => s.name === "settle")?.message).toMatch(/write-off/);
    expect(run.steps.filter((s) => s.status === "failed")).toEqual([]);
    expect(requireCase(c.id).status).toBe("settled");
  });

  it("a $0 deal in portal mode waits for the hospital to confirm (no escrow to watch)", async () => {
    const c = patientCase();
    const { deps } = fakeDeps({ negotiate: async (id) => void handleTool(id, "accept_offer", { amount: 0 }) });
    const p = runPipeline(c.id, deps, { confirm: "portal", hospitalTimeoutMs: 2000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(getRun(c.id)?.awaiting).toBe("hospital-portal");
    requireCase(c.id).status = "settled";
    const run = await p;
    expect(run.status).toBe("done");
    expect(run.steps.find((s) => s.name === "confirm")?.status).toBe("ok");
  });

  it("opens the 0% loan before the escrow when Gemini says payment plan and the fund exists", async () => {
    const c = patientCase();
    const { deps, calls } = fakeDeps({
      fundConfigured: () => true,
      financing: async (id) => (requireCase(id).financing = { recommendation: "payment_plan", reason: "rates expected to rise", sources: [] }),
    });
    await runPipeline(c.id, deps);
    expect(calls.indexOf("loan")).toBeGreaterThan(calls.indexOf("negotiate:agent"));
    expect(calls.indexOf("loan")).toBeLessThan(calls.indexOf("settle"));
  });

  it("resumes: skips research/mandate/credential/negotiation already done", async () => {
    const c = patientCase({ target: 1200, facts: ["f"], agreedAmount: 1500, status: "agreed" });
    c.receipts.push(rcpt("bsc", "openMandate", "0xm"), rcpt("xrpl", "CredentialAccept", "CA"));
    const { deps, calls } = fakeDeps();
    const run = await runPipeline(c.id, deps);
    expect(calls).toEqual(["financing", "settle", "recordDeal:1500:ESCROWTX", "confirm"]);
    expect(run.status).toBe("done");
  });

  it("leaves the zero-balance confirmation to the hospital when confirm:false", async () => {
    const c = patientCase();
    const { deps, calls } = fakeDeps();
    const run = await runPipeline(c.id, deps, { confirm: false });
    expect(calls).not.toContain("confirm");
    expect(run.steps.find((s) => s.name === "confirm")?.status).toBe("skipped");
  });
});

describe("ledgerSink", () => {
  it("reports the first append failure once and keeps going", async () => {
    const c = patientCase();
    const errors: unknown[] = [];
    let n = 0;
    const sink = ledgerSink(c.id, async () => {
      if (n++ === 0) throw new Error("rpc down");
    }, (e) => errors.push(e));
    handleTool(c.id, "log_offer", { amount: 3000 });
    handleTool(c.id, "log_offer", { amount: 2800 });
    emit(c.id, { type: "log", message: "ignored" });
    await sink.drain();
    sink.close();
    handleTool(c.id, "log_offer", { amount: 2700 }); // after close: not appended
    await sink.drain();
    expect(errors).toHaveLength(1);
    expect(sink.stats()).toEqual({ pending: 0, landed: 1, failed: 1 });
  });
});

describe("POST /api/cases/:id/run", () => {
  it("starts in the background (202), exposes progress at GET /run, refuses a second concurrent run", async () => {
    const app = Fastify();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { deps } = fakeDeps();
    const slow = { ...deps, research: async (id: string) => (await gate, deps.research(id)) };
    await app.register(pipelineRoutes, { deps: slow });
    const c = patientCase();
    const r = await app.inject({ method: "POST", url: `/api/cases/${c.id}/run`, payload: { counterparty: "agent" } });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ started: true, counterparty: "agent" });
    expect(r.json().steps).toContain("negotiate");
    expect((await app.inject({ method: "POST", url: `/api/cases/${c.id}/run`, payload: {} })).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: `/api/cases/${c.id}/run` })).json().status).toBe("running");
    release();
    await vi.waitFor(() => expect(getRun(c.id)?.status).toBe("done"));
    await app.close();
  });

  it("validates the counterparty and the patient's consent", async () => {
    const app = Fastify();
    await app.register(pipelineRoutes, { deps: fakeDeps().deps });
    const c = patientCase();
    expect((await app.inject({ method: "POST", url: `/api/cases/${c.id}/run`, payload: { counterparty: "robot" } })).statusCode).toBe(400);
    const nc = patientCase({ patient: { name: "x", language: "zh", maxPay: 2500, consent: false } });
    const r = await app.inject({ method: "POST", url: `/api/cases/${nc.id}/run`, payload: {} });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/consent/);
    expect((await app.inject({ method: "GET", url: `/api/cases/${nc.id}/run` })).statusCode).toBe(404);
    await app.close();
  });
});

describe("advocate pays for research over x402 (AUSD)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    x402.setSettler(null);
  });

  it("buys a fair price from the paywalled endpoint through app.inject and attaches the payment receipt to the case", async () => {
    process.env.PAYEE_EVM_PRIVATE_KEY = generatePrivateKey();
    process.env.AGENT_EVM_PRIVATE_KEY = generatePrivateKey();
    delete process.env.PAYEE_EVM_ADDRESS;
    x402.setSettler(async () => `0x${"ab".repeat(32)}`);
    const app = Fastify();
    await app.register(x402Routes);
    const c = patientCase();
    const fp = await paidFairPrice(c.id, injectFetch(app))("99285", "ED VISIT LEVEL 5", "Stanford Health Care");
    expect(fp).toMatchObject({ code: "99285", medicareRate: 400 });
    const paid = requireCase(c.id).receipts.filter((r) => r.kind === "x402-payment");
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({ chain: "base", detail: { amountAUSD: "0.05" } });
    await app.close();
  });
});

describe("tool webhook secret", () => {
  const saved = process.env.ELEVENLABS_TOOL_SECRET;
  afterEach(() => {
    if (saved === undefined) delete process.env.ELEVENLABS_TOOL_SECRET;
    else process.env.ELEVENLABS_TOOL_SECRET = saved;
  });

  it("requires the secret from ElevenLabs but lets our own same-origin page forward client tools", async () => {
    process.env.ELEVENLABS_TOOL_SECRET = "s3cret";
    const app = Fastify();
    await app.register(voiceRoutes);
    const c = patientCase();
    const post = (headers: Record<string, string>) =>
      app.inject({ method: "POST", url: "/api/eleven/tools/log_offer", payload: { case_id: c.id, amount: 3000 }, headers });
    expect((await post({})).statusCode).toBe(401);
    expect((await post({ "sec-fetch-site": "cross-site" })).statusCode).toBe(401);
    expect((await post({ "x-vellum-secret": "s3cret" })).statusCode).toBe(200);
    expect((await post({ "sec-fetch-site": "same-origin" })).statusCode).toBe(200);
    await app.close();
  });
});
