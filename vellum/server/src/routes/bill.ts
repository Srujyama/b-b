import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { auditBill, totalAtStake } from "../bill/audit.js";
import { explainZh, parseBill } from "../bill/parse.js";
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

/** Shared intake pipeline: parse -> explain in Chinese -> deterministic audit -> status audited. */
export async function intakeCase(input: IntakeInput, seed?: string): Promise<CasePacket> {
  if (!input.text?.trim() && !input.imageDataUrl) throw badRequest("No bill provided — send a `bill` image file or `billText`");
  const c = createCase({ mode: "patient", patient: input.patient });
  try {
    emit(c.id, { type: "log", message: seed ? `Loaded ${seed}` : "Bill received", messageZh: "收到账单了" });
    emit(c.id, { type: "log", message: "Reading the bill line by line", messageZh: "正在一行一行地读您的账单" });
    const parsed = await parseBill({ text: input.text, imageDataUrl: input.imageDataUrl });
    emit(c.id, {
      type: "log",
      message: `Read ${parsed.lineItems.length} charge lines from ${parsed.provider.name}; balance due $${parsed.patientBalance.toFixed(2)}`,
      messageZh: `读到 ${parsed.lineItems.length} 项收费，医院说您要付 $${parsed.patientBalance.toFixed(2)}`,
    });
    const bill = await explainZh(parsed);
    emit(c.id, { type: "log", message: "Explained every line in Chinese", messageZh: "每一项都用中文解释好了" });
    const flags = auditBill(bill);
    const stake = totalAtStake(flags);
    emit(c.id, {
      type: "log",
      message: `Audit: ${flags.length} flags, $${stake.toFixed(2)} in likely billing errors`,
      messageZh: `检查完了：发现 ${flags.filter((f) => f.amountAtStake > 0).length} 个可能的错误，涉及 $${stake.toFixed(2)}`,
    });
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
      return await intakeCase(await readIntake(req));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Demo seed: the fixture is a raw statement; it goes through the same parse + explain + audit path.
  app.post("/api/cases/demo", async (_req, reply) => {
    try {
      const { patient, text } = await loadDemoFixture();
      return await intakeCase({ patient, text }, "demo seed bill (fixtures/lin-er-bill.json)");
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
