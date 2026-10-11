import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// LLM is mocked at the boundary: these tests need NO API keys.
vi.mock("../src/llm.js", () => ({ llmJson: vi.fn(), llmText: vi.fn() }));
// emit is wrapped (still the real one) so the keyless test can see the route's log events.
vi.mock("../src/store.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../src/store.js")>();
  return { ...m, emit: vi.fn(m.emit) };
});

import { llmJson } from "../src/llm.js";
import { emit, listCases } from "../src/store.js";
import { auditBill, totalAtStake } from "../src/bill/audit.js";
import { explainZh, normalizeBill, parseBill, parseStatementText } from "../src/bill/parse.js";
import type { Bill } from "../src/types.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/lin-er-bill.json", import.meta.url), "utf8"));
const statement: string = fixture.statementLines.join("\n");
const mocked = vi.mocked(llmJson);

/** What a vision model plausibly returns for the fixture: strings with $/commas, MM/DD dates. */
function fakeLlmTranscription() {
  const b = parseStatementText(statement);
  return {
    provider: { name: "Stanford Health Care", address: "300 Pasteur Drive, Stanford, CA 94305", website: "stanfordhealthcare.org" },
    patientName: "LIN, MEI",
    accountNumber: "4418-20931-07",
    serviceDate: "08/14/2026",
    insurer: "NONE ON FILE",
    lineItems: b.lineItems.map((li) => ({ ...li, charge: `$${li.charge.toLocaleString("en-US", { minimumFractionDigits: 2 })}`, date: "08/14/2026" })),
    totalCharges: "14,296.00",
    insurancePaid: 0,
    adjustments: 0,
    patientBalance: "$14,296.00",
  };
}

function installLlm() {
  mocked.mockImplementation(async (system: string, user: string) => {
    if (system.includes("transcribe US hospital bills")) return fakeLlmTranscription() as never;
    const n = (user.match(/^\d+\. /gm) ?? []).length;
    return { items: Array.from({ length: n }, (_, i) => ({ index: i, zh: `第${i + 1}项的中文解释` })) } as never;
  });
}

describe("audit (pure)", () => {
  const bill = parseStatementText(statement);

  it("does not flag repeated nominal reporting lines (G1004 at $0.01, once per scan) as duplicates", () => {
    const line = (code: string, charge: number) => ({ code, description: "x", qty: 1, charge, date: "2024-01-17" });
    const b: Bill = { provider: { name: "H" }, lineItems: [line("G1004", 0.01), line("G1004", 0.01), line("70450", 2111), line("70450", 2111)], totalCharges: 4222.02, patientBalance: 4222.02 };
    const dups = auditBill(b).filter((f) => f.kind === "duplicate");
    expect(dups.map((f) => [f.lineIndex, f.amountAtStake])).toEqual([[3, 2111]]);
  });

  it("fixture parses deterministically into a ~$14k self-pay bill", () => {
    expect(bill.lineItems).toHaveLength(17);
    expect(bill.totalCharges).toBe(14296);
    expect(bill.patientBalance).toBe(14296);
    expect(bill.lineItems.reduce((s, l) => s + l.charge, 0)).toBeCloseTo(14296, 2);
    expect(bill.provider.name).toBe("STANFORD HEALTH CARE");
  });

  it("finds the 3 planted errors with exact dollar amounts", () => {
    const flags = auditBill(bill);
    const dup = flags.filter((f) => f.kind === "duplicate");
    const up = flags.filter((f) => f.kind === "upcoding");
    const unb = flags.filter((f) => f.kind === "unbundling");
    expect(dup).toHaveLength(1);
    expect(dup[0].amountAtStake).toBe(842);
    expect(bill.lineItems[dup[0].lineIndex!].code).toBe("96374");
    expect(up).toHaveLength(1);
    expect(up[0].amountAtStake).toBe(1023.6);
    expect(bill.lineItems[up[0].lineIndex!].code).toBe("99285");
    expect(unb).toHaveLength(1);
    expect(unb[0].amountAtStake).toBe(365);
    expect(unb[0].message).toMatch(/82565.*84520.*82947/);
    // matches the fixture's labeled planted errors
    for (const p of fixture._plantedErrors) expect(flags.find((f) => f.kind === p.kind)!.amountAtStake).toBe(p.amountAtStake);
    expect(flags.some((f) => f.kind === "math_error")).toBe(false);
    expect(totalAtStake(flags)).toBe(2230.6);
    for (const f of flags) {
      expect(f.message.length).toBeGreaterThan(20);
      expect(f.messageZh).toMatch(/[一-鿿]/);
    }
  });

  it("flags self-pay ER context (No Surprises Act) with $0 stake", () => {
    const nsa = auditBill(bill).find((f) => f.kind === "no_surprises_act")!;
    expect(nsa.amountAtStake).toBe(0);
    expect(nsa.message).toMatch(/501\(r\)/);
  });

  it("detects math mismatches", () => {
    const bad: Bill = { ...bill, totalCharges: 15000, patientBalance: 15500 };
    const math = auditBill(bad).filter((f) => f.kind === "math_error");
    expect(math).toHaveLength(2);
    expect(math[0].amountAtStake).toBe(704);
    expect(math[1].amountAtStake).toBe(500);
  });

  it("does not flag level 5 when critical care is billed, and NSA applies to insured ER", () => {
    const cc: Bill = {
      ...bill,
      insurer: "Blue Shield of California",
      lineItems: [...bill.lineItems, { code: "99291", description: "CRITICAL CARE FIRST HOUR", qty: 1, charge: 2000, date: "2026-08-14" }],
      totalCharges: 16296,
      patientBalance: 16296,
    };
    const flags = auditBill(cc);
    expect(flags.some((f) => f.kind === "upcoding")).toBe(false);
    expect(flags.find((f) => f.kind === "no_surprises_act")!.message).toMatch(/in-network cost-sharing/);
  });

  it("is deterministic", () => {
    expect(auditBill(bill)).toEqual(auditBill(bill));
  });
});

describe("parse (llm mocked)", () => {
  beforeEach(() => {
    mocked.mockReset();
    installLlm();
  });

  it("maps LLM output into a strict Bill (numbers, ISO dates, code types)", async () => {
    const bill = await parseBill({ text: statement });
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked.mock.calls[0][1]).toContain("99285");
    expect(bill.provider.name).toBe("Stanford Health Care");
    expect(bill.lineItems).toHaveLength(17);
    expect(bill.lineItems[0]).toMatchObject({ code: "99285", codeType: "CPT", charge: 3412, qty: 1, date: "2026-08-14" });
    expect(bill.lineItems.find((l) => l.code === "J2405")).toMatchObject({ codeType: "HCPCS", qty: 4, charge: 96 });
    expect(bill.totalCharges).toBe(14296);
    expect(bill.patientBalance).toBe(14296);
    expect(bill.serviceDate).toBe("2026-08-14");
    expect(auditBill(bill).filter((f) => ["duplicate", "upcoding", "unbundling"].includes(f.kind))).toHaveLength(3);
  });

  it("passes the photo to the vision call", async () => {
    await parseBill({ imageDataUrl: "data:image/png;base64,AAAA" });
    expect(mocked.mock.calls[0][2]).toMatchObject({ image: "data:image/png;base64,AAAA" });
  });

  it("fails loudly on empty input or unreadable output", async () => {
    await expect(parseBill({})).rejects.toThrow(/No bill provided/);
    expect(() => normalizeBill({ lineItems: [] })).toThrow(/Could not read any charge lines/);
  });

  it("explainZh fills descriptionZh on every line", async () => {
    const bill = await explainZh(parseStatementText(statement));
    expect(bill.lineItems.every((l) => /[一-鿿]/.test(l.descriptionZh ?? ""))).toBe(true);
  });
});

describe("routes (llm mocked)", () => {
  beforeEach(() => {
    mocked.mockReset();
    installLlm();
    // these exercise the LLM path, which only runs when a key is configured (the mock never sees the value)
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("POST /api/cases/demo builds an audited case from the fixture in well under 2s, with no LLM call even with a key", async () => {
    const { buildApp } = await import("../src/index.js");
    const app = await buildApp();
    const t0 = Date.now();
    const res = await app.inject({ method: "POST", url: "/api/cases/demo", payload: {} });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(res.statusCode).toBe(200);
    const c = res.json();
    expect(mocked).not.toHaveBeenCalled(); // no transcription, no explanation step
    expect(c.status).toBe("audited");
    expect(c.mode).toBe("patient");
    expect(c.bill.reader).toBe("builtin");
    expect(c.bill.lineItems).toHaveLength(17);
    expect(c.bill.lineItems.some((l: { descriptionZh?: string }) => l.descriptionZh)).toBe(false);
    expect(c.flags.map((f: { kind: string }) => f.kind)).toEqual(expect.arrayContaining(["duplicate", "upcoding", "unbundling"]));
    const got = await app.inject({ method: "GET", url: `/api/cases/${c.id}` });
    expect(got.json().status).toBe("audited");
    await app.close();
  });

  it("POST /api/cases accepts JSON {patient, billText}", async () => {
    const { buildApp } = await import("../src/index.js");
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/cases",
      payload: { patient: { name: "Lin Mei", language: "zh", maxPay: 2500, consent: true }, billText: statement },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().bill.patientBalance).toBe(14296);
    expect(res.json().patient.maxPay).toBe(2500);
    expect(res.json().bill.reader).toBeUndefined(); // an upload is read by Claude
    expect(mocked).toHaveBeenCalledTimes(1); // transcription only: no explanation step on the critical path
    const empty = await app.inject({ method: "POST", url: "/api/cases", payload: {} });
    expect(empty.statusCode).toBe(400);
    await app.close();
  });

  it("POST /api/cases accepts multipart with a bill image", async () => {
    const { buildApp } = await import("../src/index.js");
    const app = await buildApp();
    const boundary = "----vellumtest";
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="patient"\r\n\r\n${JSON.stringify({ name: "Lin Mei", language: "zh", maxPay: 2500, consent: true })}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="bill"; filename="bill.png"\r\nContent-Type: image/png\r\n\r\nPNGDATA\r\n` +
      `--${boundary}--\r\n`;
    const res = await app.inject({ method: "POST", url: "/api/cases", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(res.statusCode).toBe(200);
    expect(mocked.mock.calls[0][2]?.image).toMatch(/^data:image\/png;base64,/);
    await app.close();
  });

  it("returns 503 with a clear message when Claude is not configured", async () => {
    mocked.mockReset();
    mocked.mockRejectedValue(new Error("ANTHROPIC_API_KEY is not configured — set it in vellum/server/.env (see .env.example)"));
    const { buildApp } = await import("../src/index.js");
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/cases", payload: { patient: { name: "Lin Mei", maxPay: 2500 }, billText: statement } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/ANTHROPIC_API_KEY is not configured/);
    await app.close();
  });
});

describe("keyless demo path (no ANTHROPIC_API_KEY)", () => {
  beforeEach(() => {
    mocked.mockReset();
    installLlm();
    vi.mocked(emit).mockClear();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("POST /api/cases/demo reads the bundled statement deterministically and audits it, no LLM call", async () => {
    const { buildApp } = await import("../src/index.js");
    const { BUILTIN_READER_LOG } = await import("../src/routes/bill.js");
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/cases/demo", payload: {} });
    expect(res.statusCode).toBe(200);
    const c = res.json();
    expect(mocked).not.toHaveBeenCalled();
    expect(c.status).toBe("audited");
    expect(c.patient).toMatchObject({ name: fixture.patient.name, maxPay: fixture.patient.maxPay, consent: true });
    // exactly what the deterministic reader produces from the fixture text (real parse, not canned data)
    expect(c.bill).toEqual({ ...parseStatementText(statement), reader: "builtin" });
    // the marker is stored on the case, not only sent as a WebSocket log line
    const again = await app.inject({ method: "GET", url: `/api/cases/${c.id}` });
    expect(again.json().bill.reader).toBe("builtin");
    expect(c.bill.lineItems).toHaveLength(17);
    expect(c.bill.patientBalance).toBe(14296);
    expect(c.bill.lineItems.some((l: { descriptionZh?: string }) => l.descriptionZh)).toBe(false);
    for (const p of fixture._plantedErrors) expect(c.flags.find((f: { kind: string }) => f.kind === p.kind).amountAtStake).toBe(p.amountAtStake);
    const logs = vi
      .mocked(emit)
      .mock.calls.filter(([id, ev]) => id === c.id && ev.type === "log")
      .map(([, ev]) => (ev as { message: string }).message);
    expect(BUILTIN_READER_LOG).toBe("Read with Vellum's built-in statement reader (the bundled demo statement; no AI call needed)");
    expect(logs).toContain(BUILTIN_READER_LOG);
    expect(logs).not.toContain("Explained every line in Chinese");
    await app.close();
  });

  it("an uploaded bill still needs the key: 503 with an actionable message, and no case is created", async () => {
    const { buildApp } = await import("../src/index.js");
    const app = await buildApp();
    const before = listCases().length;
    const res = await app.inject({
      method: "POST",
      url: "/api/cases",
      payload: { patient: { name: "Lin Mei", language: "zh", maxPay: 2500, consent: true }, billText: statement },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/ANTHROPIC_API_KEY is not configured/);
    expect(res.json().error).toContain("/api/cases/demo");
    expect(listCases().length).toBe(before);
    expect(mocked).not.toHaveBeenCalled();
    // an empty body is still a 400, not a 503
    expect((await app.inject({ method: "POST", url: "/api/cases", payload: {} })).statusCode).toBe(400);
    await app.close();
  });

  it("with a key the demo still uses the deterministic reader (same bill, no LLM call)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const { buildApp } = await import("../src/index.js");
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/cases/demo", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(mocked).not.toHaveBeenCalled();
    expect(res.json().bill).toEqual({ ...parseStatementText(statement), reader: "builtin" });
    await app.close();
  });
});
