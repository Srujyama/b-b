import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// The XRPL boundary is mocked: an in-memory escrow book that behaves like chain/xrpl.ts (escrowFor strips the
// fulfillment; releaseOnZeroBalance closes the escrow and returns the Batch receipts). No network.
const book = vi.hoisted(() => ({
  escrows: new Map<string, Record<string, unknown>>(),
  releases: [] as string[],
  releaseImpl: undefined as undefined | ((id: string) => Promise<unknown>),
  ledger: { escrowFound: true, credential: true },
}));
vi.mock("../src/chain/xrpl.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/chain/xrpl.js")>();
  const rc = (kind: string, txHash: string, detail: Record<string, unknown>) => ({
    chain: "xrpl" as const,
    kind,
    txHash,
    explorerUrl: `https://devnet.xrpl.org/transactions/${txHash}`,
    detail,
    at: new Date().toISOString(),
  });
  return {
    ...real,
    escrowFor: (id: string) => {
      const e = book.escrows.get(id);
      if (!e) return undefined;
      const { fulfillment: _f, ...pub } = e;
      return pub;
    },
    releaseOnZeroBalance: vi.fn(async (id: string) => {
      if (book.releaseImpl) await book.releaseImpl(id);
      const e = book.escrows.get(id);
      if (!e) throw Object.assign(new Error("no open escrow"), { statusCode: 409 });
      book.escrows.delete(id);
      book.releases.push(id);
      return [
        rc("Batch", "BATCHTX", { mode: "AllOrNothing", inner: ["FINISHTX", "FEETX"], confirmedBy: "rHospital" }),
        rc("EscrowFinish", "FINISHTX", { amount: e.amount, to: "rHospital", inBatch: "BATCHTX" }),
        rc("Payment", "FEETX", { advocateFee: 6, to: "rAdvocate", inBatch: "BATCHTX" }),
      ];
    }),
    defaultCtx: vi.fn(async () => ({
      network: real.DEVNET_URL,
      actors: {},
      client: {
        request: async () => {
          if (!book.ledger.escrowFound) throw Object.assign(new Error("entryNotFound"), { data: { error: "entryNotFound" } });
          return { result: { node: { Amount: { currency: "USD", value: "600" }, Destination: "rHospital" } } };
        },
      },
    })),
    hasHardshipCredential: vi.fn(async () => book.ledger.credential),
  };
});

import { createCase, requireCase, subscribe, updateCase } from "../src/store.js";
import type { CaseEvent, CasePacket, Receipt } from "../src/types.js";
import hospitalRoutes, { _resetHospital } from "../src/routes/hospital.js";
import xrplRoutes from "../src/routes/xrpl.js";
import pipelineRoutes, { _resetRuns, defaultConfirmMode, getRun, runPipeline, type PipelineDeps } from "../src/routes/pipeline.js";
import { escrowFor, releaseOnZeroBalance } from "../src/chain/xrpl.js";

const SECRET = "A0228020" + "F".repeat(64);
const CONDITION = "A0258020" + "C".repeat(64) + "810120";

const rcpt = (kind: string, txHash: string, detail: Record<string, unknown> = {}): Receipt => ({
  chain: "xrpl",
  kind,
  txHash,
  explorerUrl: `https://devnet.xrpl.org/transactions/${txHash}`,
  detail,
  at: new Date().toISOString(),
});

function agreedCase(over: Partial<CasePacket> = {}) {
  return createCase({
    mode: "patient",
    status: "agreed",
    bill: {
      provider: { name: "Stanford Health Care" },
      patientName: "LIN, MEI",
      accountNumber: "ACCT-07",
      lineItems: [],
      totalCharges: 14296,
      patientBalance: 14296,
    },
    patient: { name: "Lin Mei", language: "zh", maxPay: 2500, consent: true },
    agreedAmount: 600,
    ...over,
  });
}

/** What POST /settle does, against the fake book. */
function lockEscrow(id: string, amount = 600) {
  book.escrows.set(id, {
    owner: "rPatient",
    destination: "rHospital",
    offerSequence: 42,
    condition: CONDITION,
    fulfillment: SECRET,
    amount,
    cancelAfter: 900000000,
    txHash: "ESCROWTX",
  });
  requireCase(id).receipts.push(
    rcpt("CredentialCreate", "CREDTX", { issuer: "rClinic", subject: "rPatient", credentialType: "FinancialHardship" }),
    rcpt("CredentialAccept", "ACCEPTTX", { credentialType: "FinancialHardship" }),
    rcpt("EscrowCreate", "ESCROWTX", { amount, owner: "rPatient", destination: "rHospital", offerSequence: 42, condition: CONDITION, cancelAfter: 900000000 }),
  );
}

function events(id: string) {
  const got: CaseEvent[] = [];
  subscribe(id, { readyState: 1, send: (d: string) => got.push(JSON.parse(d)), on() {} } as any);
  return got;
}

let app: FastifyInstance;
beforeEach(async () => {
  book.escrows.clear();
  book.releases.length = 0;
  book.releaseImpl = undefined;
  book.ledger = { escrowFound: true, credential: true };
  _resetHospital();
  _resetRuns();
  vi.mocked(releaseOnZeroBalance).mockClear();
  app = Fastify();
  await app.register(xrplRoutes);
  await app.register(hospitalRoutes);
});
afterEach(async () => {
  await app.close();
  delete process.env.PIPELINE_HOSPITAL_CONFIRM;
});

describe("hospital portal routes", () => {
  it("lists only patient cases with an agreed amount, open escrows first, never the fulfillment", async () => {
    const intake = createCase({ mode: "patient", status: "audited" });
    const clinic = createCase({ mode: "clinic", status: "agreed", agreedAmount: 10 });
    const waiting = agreedCase();
    const open = agreedCase();
    lockEscrow(open.id);
    const res = await app.inject({ method: "GET", url: "/api/hospital/cases" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET);
    const list = res.json() as { id: string; stage: string; patientName: string; provider: string; agreedAmount: number }[];
    const ids = list.map((x) => x.id);
    expect(ids).not.toContain(intake.id);
    expect(ids).not.toContain(clinic.id);
    expect(ids.indexOf(open.id)).toBeLessThan(ids.indexOf(waiting.id));
    const row = list.find((x) => x.id === open.id)!;
    expect(row).toMatchObject({ stage: "awaiting_confirmation", patientName: "Lin Mei", provider: "Stanford Health Care", agreedAmount: 600 });
    expect(list.find((x) => x.id === waiting.id)!.stage).toBe("awaiting_escrow");
  });

  it("shows the escrow (amount, tx, condition), the hardship credential, and no secret", async () => {
    const c = agreedCase();
    lockEscrow(c.id);
    const res = await app.inject({ method: "GET", url: `/api/hospital/cases/${c.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toMatch(/fulfillment/i);
    const d = res.json();
    expect(d.escrow).toMatchObject({ state: "open", amount: 600, txHash: "ESCROWTX", condition: CONDITION, offerSequence: 42, destination: "rHospital" });
    expect(d.escrow.explorerUrl).toBe("https://devnet.xrpl.org/transactions/ESCROWTX");
    expect(d.escrow.cancelAfter).toBe(new Date((900000000 + 946684800) * 1000).toISOString());
    expect(d.credential).toMatchObject({ type: "FinancialHardship", accepted: true, issuer: "rClinic", subject: "rPatient" });
    expect(d.credential.accept.txHash).toBe("ACCEPTTX");
    expect(d.release).toEqual([]);
  });

  it("404s an unknown case and 409s one that has not reached a deal", async () => {
    expect((await app.inject({ method: "GET", url: "/api/hospital/cases/nope" })).statusCode).toBe(404);
    const c = createCase({ mode: "patient", status: "negotiating" });
    expect((await app.inject({ method: "GET", url: `/api/hospital/cases/${c.id}` })).statusCode).toBe(409);
  });

  it("confirm requires an explicit attestation and an open escrow", async () => {
    const c = agreedCase();
    const noAttest = await app.inject({ method: "POST", url: `/api/hospital/cases/${c.id}/confirm-zero-balance`, payload: {} });
    expect(noAttest.statusCode).toBe(400);
    expect(noAttest.json().error).toMatch(/attest/);
    const noEscrow = await app.inject({ method: "POST", url: `/api/hospital/cases/${c.id}/confirm-zero-balance`, payload: { attest: true } });
    expect(noEscrow.statusCode).toBe(409);
    expect(noEscrow.json().error).toMatch(/no open escrow/);
    expect(releaseOnZeroBalance).not.toHaveBeenCalled();
  });

  it("confirm releases through the same path as /confirm-zero-balance: Batch receipts recorded, case settled, logged en+zh", async () => {
    const c = agreedCase();
    lockEscrow(c.id);
    const ev = events(c.id);
    const res = await app.inject({
      method: "POST",
      url: `/api/hospital/cases/${c.id}/confirm-zero-balance`,
      payload: { attest: true, staffName: "  Dana   (PFS) " },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.confirmedBy).toBe("Dana (PFS)");
    expect(body.receipts.map((r: Receipt) => r.kind)).toEqual(["Batch", "EscrowFinish", "Payment"]);
    expect(body.case.stage).toBe("released");
    expect(body.case.escrow).toMatchObject({ state: "released", txHash: "ESCROWTX", amount: 600 });
    expect(body.case.release.map((r: Receipt) => r.txHash)).toEqual(["BATCHTX", "FINISHTX", "FEETX"]);
    expect(releaseOnZeroBalance).toHaveBeenCalledTimes(1);
    expect(requireCase(c.id).status).toBe("settled");
    expect(requireCase(c.id).receipts.filter((r) => r.kind === "Batch")).toHaveLength(1);
    const logs = ev.filter((e): e is Extract<CaseEvent, { type: "log" }> => e.type === "log");
    expect(logs.some((l) => /hospital portal by Dana \(PFS\)/.test(l.message) && /医院端/.test(l.messageZh ?? ""))).toBe(true);
    expect(ev.some((e) => e.type === "receipt" && e.receipt.kind === "Batch")).toBe(true);

    const again = await app.inject({ method: "POST", url: `/api/hospital/cases/${c.id}/confirm-zero-balance`, payload: { attest: true } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/already settled/);
  });

  it("refuses a double-click while a release is in flight", async () => {
    const c = agreedCase();
    lockEscrow(c.id);
    let let_go!: () => void;
    book.releaseImpl = () => new Promise<void>((r) => (let_go = r));
    const first = app.inject({ method: "POST", url: `/api/hospital/cases/${c.id}/confirm-zero-balance`, payload: { attest: true } });
    await vi.waitFor(() => expect(releaseOnZeroBalance).toHaveBeenCalledTimes(1));
    const second = await app.inject({ method: "POST", url: `/api/hospital/cases/${c.id}/confirm-zero-balance`, payload: { attest: true } });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatch(/already being submitted/);
    let_go();
    expect((await first).statusCode).toBe(200);
  });

  it("surfaces a chain failure from the release path as an error (escrow stays open)", async () => {
    const c = agreedCase();
    lockEscrow(c.id);
    book.releaseImpl = async () => {
      throw new Error("XRPL Batch failed: tecNO_PERMISSION");
    };
    const res = await app.inject({ method: "POST", url: `/api/hospital/cases/${c.id}/confirm-zero-balance`, payload: { attest: true } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/tecNO_PERMISSION/);
    expect(escrowFor(c.id)).toBeTruthy();
    expect(requireCase(c.id).status).toBe("agreed");
  });

  it("ledger check reports the escrow and credential as found on XRPL", async () => {
    const c = agreedCase();
    lockEscrow(c.id);
    const res = await app.inject({ method: "GET", url: `/api/hospital/cases/${c.id}/ledger` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ escrow: { onLedger: true, amount: "600", destination: "rHospital" }, credential: { onLedger: true } });
    book.ledger = { escrowFound: false, credential: false };
    expect((await app.inject({ method: "GET", url: `/api/hospital/cases/${c.id}/ledger` })).json()).toMatchObject({
      escrow: { onLedger: false },
      credential: { onLedger: false },
    });
  });
});

// ---------------------------------------------------------------- pipeline: confirm:"portal"

function pipelineDeps(over: Partial<PipelineDeps> = {}) {
  const calls: string[] = [];
  const deps: PipelineDeps = {
    research: async () => calls.push("research"),
    financing: async () => ({ recommendation: "lump_sum", reason: "x", sources: [] }),
    mandate: async () => calls.push("mandate"),
    credential: async () => calls.push("credential"),
    negotiate: async () => void calls.push("negotiate"),
    loan: async () => calls.push("loan"),
    settle: async (id) => {
      calls.push("settle");
      lockEscrow(id);
      return [rcpt("EscrowCreate", "ESCROWTX")];
    },
    recordDeal: async () => calls.push("recordDeal"),
    confirm: async () => void calls.push("simulated-confirm"),
    openEscrow: (id) => escrowFor(id)?.txHash,
    appendLog: async () => undefined,
    bnbConfigured: () => false,
    fundConfigured: () => false,
    ...over,
  };
  return { deps, calls };
}

describe("pipeline confirm:\"portal\"", () => {
  const researched = () =>
    agreedCase({ status: "agreed", target: 500, opening: 400, walkaway: 2500, facts: ["f"] });

  it("waits for the hospital portal, then finishes once billing staff release the escrow", async () => {
    const c = researched();
    const ev = events(c.id);
    const { deps, calls } = pipelineDeps();
    const done = runPipeline(c.id, deps, { confirm: "portal", hospitalTimeoutMs: 5_000 });

    await vi.waitFor(() => expect(getRun(c.id)?.awaiting).toBe("hospital-portal"));
    const logs = () => ev.filter((e): e is Extract<CaseEvent, { type: "log" }> => e.type === "log");
    const waitLog = logs().find((l) => /waiting for the hospital to confirm in the hospital portal/i.test(l.message));
    expect(waitLog?.messageZh).toMatch(/等医院在医院端确认/);
    expect(getRun(c.id)?.steps.find((s) => s.name === "confirm")).toMatchObject({ status: "running" });

    // the portal sees the run waiting on it
    const row = (await app.inject({ method: "GET", url: "/api/hospital/cases" })).json().find((x: { id: string }) => x.id === c.id);
    expect(row).toMatchObject({ stage: "awaiting_confirmation", waitingOnPortal: true });

    const res = await app.inject({ method: "POST", url: `/api/hospital/cases/${c.id}/confirm-zero-balance`, payload: { attest: true, staffName: "Dana" } });
    expect(res.statusCode).toBe(200);

    const run = await done;
    expect(run.status).toBe("done");
    expect(run.awaiting).toBeUndefined();
    expect(run.steps.find((s) => s.name === "confirm")).toMatchObject({ status: "ok", message: "confirmed by the hospital in the hospital portal" });
    expect(calls).not.toContain("simulated-confirm");
    expect(book.releases).toEqual([c.id]);
    expect(logs().some((l) => /confirmed a \$0 balance in the hospital portal/.test(l.message))).toBe(true);
  });

  it("times out loudly, leaves the escrow locked, and the hospital can still confirm afterwards", async () => {
    const c = researched();
    const { deps, calls } = pipelineDeps();
    const run = await runPipeline(c.id, deps, { confirm: "portal", hospitalTimeoutMs: 60 });
    const step = run.steps.find((s) => s.name === "confirm")!;
    expect(step.status).toBe("failed");
    expect(step.message).toMatch(/did not confirm in the hospital portal/);
    expect(run.awaiting).toBeUndefined();
    expect(calls).not.toContain("simulated-confirm");
    expect(escrowFor(c.id)).toBeTruthy();
    const late = await app.inject({ method: "POST", url: `/api/hospital/cases/${c.id}/confirm-zero-balance`, payload: { attest: true } });
    expect(late.statusCode).toBe(200);
  });

  it("keeps the simulated confirmation as the default", async () => {
    const c = researched();
    const { deps, calls } = pipelineDeps({
      confirm: async (id) => {
        calls.push("simulated-confirm");
        await releaseOnZeroBalance(id);
      },
    });
    const run = await runPipeline(c.id, deps, {});
    expect(run.status).toBe("done");
    expect(calls).toContain("simulated-confirm");
    expect(run.steps.find((s) => s.name === "confirm")?.status).toBe("ok");
  });

  it("PIPELINE_HOSPITAL_CONFIRM picks the default mode; POST /run validates confirm", async () => {
    expect(defaultConfirmMode()).toBe(true);
    process.env.PIPELINE_HOSPITAL_CONFIRM = "portal";
    expect(defaultConfirmMode()).toBe("portal");
    process.env.PIPELINE_HOSPITAL_CONFIRM = "simulate";
    expect(defaultConfirmMode()).toBe(true);
    process.env.PIPELINE_HOSPITAL_CONFIRM = "maybe";
    expect(() => defaultConfirmMode()).toThrow(/simulate.*portal/);
    delete process.env.PIPELINE_HOSPITAL_CONFIRM;

    const papp = Fastify();
    const { deps } = pipelineDeps();
    await papp.register(pipelineRoutes, { deps });
    const c = researched();
    const bad = await papp.inject({ method: "POST", url: `/api/cases/${c.id}/run`, payload: { confirm: "later" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/portal/);

    process.env.PIPELINE_HOSPITAL_CONFIRM = "portal";
    const ok = await papp.inject({ method: "POST", url: `/api/cases/${c.id}/run`, payload: { hospitalTimeoutMs: 50 } });
    expect(ok.statusCode).toBe(202);
    expect(ok.json().confirm).toBe("portal");
    await vi.waitFor(() => expect(getRun(c.id)?.status).not.toBe("running"));
    await papp.close();
  });
});

// ---------------------------------------------------------------- the portal page (static, English first, zh parity)

describe("web: hospital.html", () => {
  it("is served with its controls, its own module + stylesheet, and every string in en and zh", async () => {
    const { buildApp } = await import("../src/index.js");
    const web = await buildApp();
    try {
      const html = (await web.inject({ method: "GET", url: "/hospital.html" })).body;
      expect(html).toContain('data-default-lang="en"');
      for (const id of ["hospital-app", "lang-toggle", "error", "case-list", "detail", "escrow", "credential", "attest", "staff-name", "confirm-btn", "release-receipts", "activity", "ledger-check"])
        expect(html, id).toContain(`id="${id}"`);
      expect(html).toContain('src="/hospital.js"');
      expect(html.indexOf('href="/styles.css"')).toBeLessThan(html.indexOf('href="/hospital.css"'));
      const js = (await web.inject({ method: "GET", url: "/hospital.js" })).body;
      for (const p of ["/api/hospital/cases", "/confirm-zero-balance", "/ledger", "connectCase("]) expect(js, p).toContain(p);
      expect(js).not.toMatch(/\.fulfillment/); // the page never reads a release key
      expect((await web.inject({ method: "GET", url: "/hospital.css" })).statusCode).toBe(200);

      const g = globalThis as Record<string, unknown>;
      g.location ??= { pathname: "/", href: "http://localhost:8787/", protocol: "http:", host: "localhost:8787", hash: "" };
      g.document ??= { body: undefined, getElementById: () => null, querySelectorAll: () => [] };
      const { I18N } = (await import(/* @vite-ignore */ new URL("../../web/app.js", import.meta.url).href)) as Record<string, any>;
      await import(/* @vite-ignore */ new URL("../../web/hospital.js", import.meta.url).href);
      const keys = Object.keys(I18N.en).filter((k) => k.startsWith("hosp"));
      expect(keys.length).toBeGreaterThan(25);
      for (const k of keys) expect(I18N.zh[k], k).toBeDefined();
      for (const k of Object.keys(I18N.zh).filter((k) => k.startsWith("hosp"))) expect(I18N.en[k], k).toBeDefined();
      for (const m of html.matchAll(/data-i18n="(\w+)"/g)) {
        expect(I18N.zh[m[1]], m[1]).toBeDefined();
        expect(I18N.en[m[1]], m[1]).toBeDefined();
      }
    } finally {
      await web.close();
    }
  });
});
