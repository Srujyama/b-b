import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply } from "fastify";
import { claimFacts, draftAppeal, validateClaim, type ClaimMeta } from "../claims/appeal.js";
import { createCase, emit, updateCase } from "../store.js";
import type { CasePacket, ClaimCase, Patient } from "../types.js";

const FIXTURE = fileURLToPath(new URL("../../fixtures/denial-mri.json", import.meta.url));

function sendError(reply: FastifyReply, err: unknown) {
  const e = err as Error & { statusCode?: number };
  const status = e.statusCode ?? (/is not configured/i.test(e.message) ? 503 : 500);
  return reply.code(status).send({ error: e.message });
}

/** Strip derived fields so a caller can't hand us a pre-made verdict; keep a caller-supplied policy only if complete. */
function intakeClaim(raw: unknown): ClaimCase & ClaimMeta {
  const c = validateClaim(raw) as ClaimCase & ClaimMeta;
  const { criteriaMet: _m, appealLetter: _l, ...rest } = c;
  void _m;
  void _l;
  return rest;
}

/** Shared clinic pipeline: create a clinic case -> payer policy -> criteria vs chart -> appeal letter -> facts. */
export async function clinicCase(raw: unknown, seed?: string): Promise<CasePacket> {
  const claim = intakeClaim(raw);
  // The office is the principal. Patient is reused as "who we act for" (the advocate prompt reads its name);
  // maxPay is 0 because a clinic appeal has no spending mandate.
  const office = claim.provider?.name;
  const principal: Patient | undefined = office ? { name: office, language: "en", maxPay: 0, consent: true } : undefined;
  const c = createCase({ mode: "clinic", claim, ...(principal ? { patient: principal } : {}) });
  const log = (message: string) => emit(c.id, { type: "log", message });
  try {
    log(seed ? `Loaded ${seed}` : `Denied claim received: ${claim.payer}, CPT ${claim.procedure.code}`);
    log(`Looking up ${claim.payer}'s medical policy for CPT ${claim.procedure.code}`);
    const done = await draftAppeal(claim, { onProgress: log });
    log("Appeal letter drafted");
    return updateCase(c.id, { claim: done, facts: claimFacts(done), status: "researched" });
  } catch (err) {
    updateCase(c.id, { status: "failed" });
    emit(c.id, { type: "error", message: (err as Error).message });
    throw err;
  }
}

export async function loadDemoClaim(): Promise<ClaimCase & ClaimMeta> {
  const fx = JSON.parse(await readFile(FIXTURE, "utf8")) as { claim: ClaimCase & ClaimMeta };
  return fx.claim;
}

export default async function clinicRoutes(app: FastifyInstance) {
  app.post<{ Body: { claim?: unknown } | undefined }>("/api/claims", async (req, reply) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      return await clinicCase(body.claim ?? body);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Demo seed: a de-identified denied claim; it goes through the same live policy lookup + criteria check.
  app.post("/api/claims/demo", async (_req, reply) => {
    try {
      return await clinicCase(await loadDemoClaim(), "demo seed denial (fixtures/denial-mri.json)");
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
