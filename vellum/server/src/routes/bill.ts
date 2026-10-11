import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { auditBill, totalAtStake } from "../bill/audit.js";
import { parseBill, parseStatementText } from "../bill/parse.js";
import { createCase, emit, updateCase } from "../store.js";
import type { CasePacket, Patient } from "../types.js";

const FIXTURE = fileURLToPath(new URL("../../fixtures/lin-er-bill.json", import.meta.url));

type IntakeInput = { patient?: Patient; text?: string; imageDataUrl?: string };

function badRequest(message: string) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function parsePatient(v: unknown): Patient | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  let p: any = v;
  if (typeof v === "string") {
    try {
      p = JSON.parse(v);
    } catch {
      throw badRequest("patient must be a JSON object");
    }
  }
  if (typeof p !== "object" || !p || typeof p.name !== "string") throw badRequest("patient.name is required");
  const maxPay = Number(p.maxPay);
  return {
    name: p.name,
    language: p.language === "en" ? "en" : "zh",
    ...(p.householdSize !== undefined ? { householdSize: Number(p.householdSize) } : {}),
    ...(p.annualIncome !== undefined ? { annualIncome: Number(p.annualIncome) } : {}),
    maxPay: Number.isFinite(maxPay) ? maxPay : 0,
    consent: p.consent === true || p.consent === "true",
  };
}

async function readIntake(req: FastifyRequest): Promise<IntakeInput> {
  if (!req.isMultipart()) {
    const body = (req.body ?? {}) as Record<string, unknown>;
    return {
      patient: parsePatient(body.patient),
      text: typeof body.billText === "string" ? body.billText : undefined,
      imageDataUrl: typeof body.imageDataUrl === "string" ? body.imageDataUrl : undefined,
    };
  }
  const out: IntakeInput = {};
  for await (const part of req.parts()) {
    if (part.type === "file") {
      const buf = await part.toBuffer();
      if (part.fieldname !== "bill") continue;
      const mime = part.mimetype || "application/octet-stream";
      if (mime.startsWith("image/") || mime === "application/pdf") out.imageDataUrl = `data:${mime};base64,${buf.toString("base64")}`;
      else if (mime.startsWith("text/")) out.text = buf.toString("utf8");
      else
        throw Object.assign(new Error(`Unsupported bill file type ${mime} — upload a photo (JPEG/PNG), screenshot or PDF of the statement`), {
          statusCode: 415,
        });
    } else {
      const value = typeof part.value === "string" ? part.value : String(part.value ?? "");
      if (part.fieldname === "patient") out.patient = parsePatient(value);
      else if (part.fieldname === "billText") out.text = value;
    }
  }
  return out;
}

// ---- demo path ----
// The bundled demo statement is our own, in the fixed-column itemized format parseStatementText (bill/parse.ts) reads
// deterministically, so POST /api/cases/demo always uses that reader (instant, no AI call, with or without
// ANTHROPIC_API_KEY) and the same auditBill. Uploaded bills (photos, PDFs, free-form text) still go to Claude.
// There is no line-explanation step on the critical path: the UI is English-only and shows the printed lines.
export const BUILTIN_READER_LOG = "Read with Vellum's built-in statement reader (the bundled demo statement; no AI call needed)";
const hasLlmKey = () => Boolean(process.env.ANTHROPIC_API_KEY);
export type BillReader = "llm" | "builtin";

/** Shared intake pipeline: parse -> deterministic audit -> status audited.
 *  reader "builtin" (the bundled demo statement): deterministic parseStatementText, stored as bill.reader "builtin". */
export async function intakeCase(input: IntakeInput, seed?: string, reader: BillReader = "llm"): Promise<CasePacket> {
  if (!input.text?.trim() && !input.imageDataUrl) throw badRequest("No bill provided — send a `bill` image file or `billText`");
  const c = createCase({ mode: "patient", patient: input.patient });
  try {
    emit(c.id, { type: "log", message: seed ? `Loaded ${seed}` : "Bill received" });
    emit(c.id, { type: "log", message: "Reading the bill line by line" });
    const parsed = reader === "builtin" ? parseStatementText(input.text ?? "") : await parseBill({ text: input.text, imageDataUrl: input.imageDataUrl });
    // the marker is stored on the case, so a later GET (UI, e2e) can tell how the bill was read
    const bill = reader === "builtin" ? { ...parsed, reader: "builtin" as const } : parsed;
    if (reader === "builtin") emit(c.id, { type: "log", message: BUILTIN_READER_LOG });
    emit(c.id, { type: "log", message: `Read ${bill.lineItems.length} charge lines from ${bill.provider.name}; balance due $${bill.patientBalance.toFixed(2)}` });
    const flags = auditBill(bill);
    const stake = totalAtStake(flags);
    emit(c.id, { type: "log", message: `Audit: ${flags.length} flags, $${stake.toFixed(2)} in likely billing errors` });
    return updateCase(c.id, { bill, flags, status: "audited" });
  } catch (err) {
    updateCase(c.id, { status: "failed" });
    emit(c.id, { type: "error", message: (err as Error).message });
    throw err;
  }
}

function sendError(reply: FastifyReply, err: unknown) {
  const e = err as Error & { statusCode?: number };
  const status = e.statusCode ?? (/is not configured/i.test(e.message) ? 503 : 500);
  return reply.code(status).send({ error: e.message });
}

export async function loadDemoFixture(): Promise<{ patient: Patient; text: string }> {
  const fx = JSON.parse(await readFile(FIXTURE, "utf8")) as { patient: Patient; statementLines: string[] };
  return { patient: fx.patient, text: fx.statementLines.join("\n") };
}

export default async function billRoutes(app: FastifyInstance) {
  app.post("/api/cases", async (req, reply) => {
    try {
      const input = await readIntake(req);
      if (!input.text?.trim() && !input.imageDataUrl) throw badRequest("No bill provided — send a `bill` image file or `billText`");
      // keyless-e2e: fail before creating a case, so a missing key does not leave a "failed" case in the shared store
      if (!hasLlmKey())
        throw Object.assign(
          new Error("ANTHROPIC_API_KEY is not configured — set it in vellum/server/.env to read uploaded bills (the bundled demo bill still works: POST /api/cases/demo)"),
          { statusCode: 503 },
        );
      return await intakeCase(input);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Demo seed: the fixture is a raw statement, read by the deterministic reader and audited (milliseconds).
  app.post("/api/cases/demo", async (_req, reply) => {
    try {
      const { patient, text } = await loadDemoFixture();
      return await intakeCase({ patient, text }, "demo seed bill (fixtures/lin-er-bill.json)", "builtin");
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
