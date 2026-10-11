import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { need, opt } from "../env.js";
import { checkBearer, voiceError, voiceModel } from "./haiku.js";
import { callInitiation, publicVoiceUrl, validateVoicePlan, voicePlanSchema, type VoicePlan } from "./call-plan.js";
import { hasSharedVoiceContext, publishVoiceResult, readVoiceMemory, resolveVoiceTask, type VoiceTaskRef } from "./shared-context.js";

export type CallJob = {
  version: "1"; jobId: string; planId: string; stepId: string; caseId: string;
  status: "dispatching" | "submitted" | "in_progress" | "completed" | "failed" | "unknown";
  fingerprint: string; createdAt: string; updatedAt: string;
  agentId: string; conversationId?: string; callSid?: string; error?: string;
  result?: {
    requiresReview: true; summary: string; proposal?: string; blockers?: string; nextSteps?: string;
    transcript: { role: string; text: string; timeInCallSecs?: number }[];
    durationSecs?: number; terminationReason?: string; providerReportedSuccess?: string;
  };
};

/** One server process on a persistent local volume. Reserve BEFORE dialing; never redial a reserved ID. */
export class CallJobStore {
  constructor(private directory: string) {
    if (!isAbsolute(directory)) throw voiceError("VOICE_JOB_DIR must be an absolute directory outside the public web root", 503);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  private path(id: string) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw voiceError("Invalid job ID");
    return join(this.directory, `${id}.json`);
  }
  get(id: string): CallJob | undefined {
    try { return JSON.parse(readFileSync(this.path(id), "utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
  }
  all(): CallJob[] {
    return readdirSync(this.directory).filter((f) => /^[A-Za-z0-9_-]{1,100}\.json$/.test(f)).map((f) => this.get(f.slice(0, -5))!);
  }
  reserve(job: CallJob): CallJob {
    try { writeFileSync(this.path(job.jobId), JSON.stringify(job), { flag: "wx", mode: 0o600 }); return job; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      return this.get(job.jobId)!;
    }
  }
  save(job: CallJob): CallJob {
    const next = { ...job, updatedAt: new Date().toISOString() };
    const path = this.path(job.jobId), temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    renameSync(temporary, path);
    return next;
  }
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",") + "}";
  return JSON.stringify(value);
};
const fingerprint = (plan: VoicePlan) => createHash("sha256").update(canonical(plan)).digest("hex");
const terminal = (j: CallJob) => j.status === "completed" || j.status === "failed";
const required = ["ELEVENLABS_API_KEY", "ANTHROPIC_API_KEY", "ELEVENLABS_OUTBOUND_AGENT_ID", "ELEVENLABS_PHONE_NUMBER_ID",
  "VOICE_ORCHESTRATOR_TOKEN", "VOICE_LLM_TOKEN", "VOICE_JOB_DIR", "PUBLIC_URL"];

export function callReadiness() {
  const missing = required.filter((key) => !opt(key));
  const errors: string[] = [];
  if (opt("PUBLIC_URL")) try { publicVoiceUrl(); } catch (e) { errors.push((e as Error).message); }
  if (opt("VOICE_JOB_DIR") && !isAbsolute(opt("VOICE_JOB_DIR")!)) errors.push("VOICE_JOB_DIR must be absolute");
  return { configured: missing.length === 0 && !errors.length, liveCallsEnabled: opt("VOICE_CALLS_ENABLED") === "true",
    missing, errors, provider: "elevenlabs_twilio", model: voiceModel(), tts: "eleven_flash_v2_5", liveVerified: false,
    sharedMemoryConnected: hasSharedVoiceContext() };
}

async function provider(path: string, init: RequestInit = {}) {
  const response = await fetch(`https://api.elevenlabs.io/v1/convai${path}`, {
    ...init, signal: AbortSignal.timeout(15_000),
    headers: { "xi-api-key": need("ELEVENLABS_API_KEY"), "content-type": "application/json" },
  });
  if (!response.ok) { await response.body?.cancel(); throw voiceError(`ElevenLabs returned HTTP ${response.status}`, 502); }
  return response.json();
}

export async function dispatchCall(plan: VoicePlan, store: CallJobStore): Promise<CallJob> {
  validateVoicePlan(plan);
  const hash = fingerprint(plan);
  const prior = store.get(plan.jobId);
  if (prior) {
    if (prior.fingerprint !== hash) throw voiceError("jobId is already used for a different plan", 409);
    return prior;
  }
  const memory = await readVoiceMemory(plan);
  if (memory && !memory.authorized) throw voiceError("Client authorization has been revoked in shared memory", 409);
  const concurrent = store.get(plan.jobId);
  if (concurrent) {
    if (concurrent.fingerprint !== hash) throw voiceError("jobId is already used for a different plan", 409);
    return concurrent;
  }
  const ready = callReadiness();
  if (!ready.configured) throw voiceError(`Voice calling is not configured: ${[...ready.missing, ...ready.errors].join(", ")}`, 503);
  if (!ready.liveCallsEnabled) throw voiceError("Live calls are disabled; set VOICE_CALLS_ENABLED=true after setup", 503);
  const allowed = opt("VOICE_ALLOWED_NUMBERS")?.split(",").map((n) => n.trim()).filter(Boolean);
  if (allowed?.length && !allowed.includes(plan.target.phone)) throw voiceError("Destination is outside VOICE_ALLOWED_NUMBERS", 403);
  if (store.all().some((j) => j.caseId === plan.caseId && !terminal(j)))
    throw voiceError("This case has an active or uncertain call; reconcile it before submitting another job", 409);
  const now = new Date().toISOString();
  const job: CallJob = { version: "1", jobId: plan.jobId, planId: plan.planId, stepId: plan.stepId, caseId: plan.caseId,
    fingerprint: hash, agentId: need("ELEVENLABS_OUTBOUND_AGENT_ID"), status: "dispatching", createdAt: now, updatedAt: now };
  const reserved = store.reserve(job);
  if (reserved !== job) {
    if (reserved.fingerprint !== hash) throw voiceError("jobId is already used for a different plan", 409);
    return reserved;
  }
  try {
    const response = await provider("/twilio/outbound-call", { method: "POST", body: JSON.stringify({
      agent_id: job.agentId, agent_phone_number_id: need("ELEVENLABS_PHONE_NUMBER_ID"),
      to_number: plan.target.phone, call_recording_enabled: false, conversation_initiation_client_data: callInitiation(plan),
    }) });
    // A very fast webhook may finish the job before the dial request returns.
    const latest = store.get(job.jobId)!;
    if (typeof response.conversation_id === "string") latest.conversationId = response.conversation_id;
    if (typeof response.callSid === "string") latest.callSid = response.callSid;
    if (!terminal(latest)) {
      if (response.success === false) { latest.status = "failed"; latest.error = "Provider rejected call initiation"; }
      else if (response.success === true && latest.conversationId) latest.status = "submitted";
      else { latest.status = "unknown"; latest.error = "Provider response did not confirm initiation; reconcile before retrying"; }
    }
    return store.save(latest);
  } catch {
    const latest = store.get(job.jobId)!;
    if (terminal(latest)) return latest;
    // Even an HTTP failure may happen after a dial side effect. Do not retry automatically.
    return store.save({ ...latest, status: "unknown", error: "Call initiation was not confirmed. Check ElevenLabs/Twilio before attempting another call." });
  }
}

/** Orchestrator tool entry point: only references cross the boundary; memory stays orchestrator-owned. */
export async function runVoiceTask(ref: VoiceTaskRef): Promise<CallJob> {
  return dispatchCall(await resolveVoiceTask(ref), new CallJobStore(need("VOICE_JOB_DIR")));
}

export async function syncVoiceTask(jobId: string): Promise<CallJob> {
  const db = new CallJobStore(need("VOICE_JOB_DIR")), job = db.get(jobId);
  if (!job) throw voiceError("Unknown voice job", 404);
  if (terminal(job)) { await publishVoiceResult(job); return job; }
  if (!job.conversationId) throw voiceError("No conversation ID; reconcile using the ElevenLabs call history", 409);
  const data = await provider(`/conversations/${encodeURIComponent(job.conversationId)}`);
  const updated = applyConversation(db, db.get(job.jobId)!, data);
  await publishVoiceResult(updated);
  return updated;
}

/** Model-written analysis is evidence for the orchestrator; never execute or settle from it. */
export function applyConversation(store: CallJobStore, job: CallJob, data: any, failed = false): CallJob {
  if (data.agent_id !== job.agentId || typeof data.conversation_id !== "string" || !data.conversation_id)
    throw voiceError("Provider conversation identity mismatch", 409);
  if (job.conversationId && job.conversationId !== data.conversation_id) throw voiceError("Provider conversation identity mismatch", 409);
  if (terminal(job)) return job;
  const status = failed || data.status === "failed" ? "failed" : data.status === "done" ? "completed" : "in_progress";
  const next = { ...job, conversationId: data.conversation_id, status } as CallJob;
  if (status === "completed" || status === "failed") {
    const fields = data.analysis?.data_collection_results ?? {};
    const field = (name: string) => typeof fields[name]?.value === "string" ? fields[name].value : undefined;
    next.result = {
      requiresReview: true,
      summary: typeof data.analysis?.transcript_summary === "string" ? data.analysis.transcript_summary : "No provider summary available",
      proposal: field("proposal"), blockers: field("blockers"), nextSteps: field("next_steps"),
      transcript: (Array.isArray(data.transcript) ? data.transcript : []).filter((t: any) => typeof t.message === "string")
        .map((t: any) => ({ role: t.role, text: t.message, timeInCallSecs: t.time_in_call_secs })),
      durationSecs: data.metadata?.call_duration_secs, terminationReason: data.failure_reason ?? data.metadata?.termination_reason,
      providerReportedSuccess: data.analysis?.call_successful,
    };
    if (status === "failed") next.error = typeof data.failure_reason === "string" ? data.failure_reason : "Provider reports call failed";
    else delete next.error;
  }
  return store.save(next);
}

export function verifyWebhook(raw: Buffer, signature: string | undefined, secret: string, now = Date.now()) {
  if (signature != null && typeof signature !== "string") throw voiceError("Invalid webhook signature", 401);
  const parts = (signature ?? "").split(",").map((s) => s.trim());
  const timestamp = parts.find((p) => p.startsWith("t="))?.slice(2);
  if (!timestamp || !/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 1800)
    throw voiceError("Invalid or expired webhook signature", 401);
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest();
  if (!parts.filter((p) => /^v0=[0-9a-f]{64}$/i.test(p)).some((p) => timingSafeEqual(expected, Buffer.from(p.slice(3), "hex"))))
    throw voiceError("Invalid webhook signature", 401);
}

export async function callRoutes(app: FastifyInstance) {
  const store = () => new CallJobStore(need("VOICE_JOB_DIR"));
  await app.register(async (scope) => {
    scope.addHook("onRequest", async (req) => checkBearer(req.headers.authorization, "VOICE_ORCHESTRATOR_TOKEN"));
    scope.get("/api/voice/ready", async () => callReadiness());
    scope.post<{ Body: VoicePlan }>("/api/voice/jobs/preview", { schema: { body: voicePlanSchema }, bodyLimit: 32768 }, async (req) => ({
      dryRun: true, dialed: false, jobId: req.body.jobId, provider: "elevenlabs_twilio", model: voiceModel(),
      toNumber: req.body.target.phone, initiation: callInitiation(req.body), readiness: callReadiness(),
    }));
    scope.post<{ Body: VoicePlan }>("/api/voice/jobs", { schema: { body: voicePlanSchema }, bodyLimit: 32768 }, async (req, reply) => {
      return reply.code(202).send(await dispatchCall(req.body, store()));
    });
    scope.get<{ Params: { id: string } }>("/api/voice/jobs/:id", async (req) => {
      const job = store().get(req.params.id);
      if (!job) throw voiceError("Unknown voice job", 404);
      await publishVoiceResult(job);
      return job;
    });
    scope.post<{ Params: { id: string } }>("/api/voice/jobs/:id/refresh", async (req) => {
      return syncVoiceTask(req.params.id);
    });
    scope.post<{ Params: { id: string }; Body: { conversationId: string } }>("/api/voice/jobs/:id/reconcile", {
      schema: { body: { type: "object", required: ["conversationId"], additionalProperties: false,
        properties: { conversationId: { type: "string", pattern: "^[A-Za-z0-9_-]{1,100}$" } } } },
    }, async (req) => {
      const db = store(), job = db.get(req.params.id);
      if (!job) throw voiceError("Unknown voice job", 404);
      const data = await provider(`/conversations/${encodeURIComponent(req.body.conversationId)}`);
      if (data.conversation_initiation_client_data?.dynamic_variables?.job_id !== job.jobId)
        throw voiceError("Conversation does not belong to this job", 409);
      const updated = applyConversation(db, db.get(job.jobId)!, data);
      await publishVoiceResult(updated);
      return updated;
    });
  });
  // Scope raw-body parsing to the signed provider webhook only.
  await app.register(async (scope) => {
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 2 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    scope.post<{ Body: Buffer }>("/api/voice/webhooks/elevenlabs", async (req) => {
      verifyWebhook(req.body, req.headers["elevenlabs-signature"] as string | undefined, need("ELEVENLABS_WEBHOOK_SECRET"));
      let event: any;
      try { event = JSON.parse(req.body.toString("utf8")); } catch { throw voiceError("Invalid webhook JSON"); }
      if (!["post_call_transcription", "call_initiation_failure"].includes(event?.type)) return { ok: true, ignored: true };
      const db = store(), data = event.data;
      if (!data || typeof data !== "object") throw voiceError("Missing webhook data");
      const jobId = data.conversation_initiation_client_data?.dynamic_variables?.job_id;
      const job = typeof jobId === "string" ? db.get(jobId) : db.all().find((j) => j.conversationId === data.conversation_id);
      // Retry a failure webhook that races the outbound response assigning a conversation ID.
      if (!job) throw voiceError("Voice job not yet correlated", 503);
      const updated = applyConversation(db, job, { ...data, status: event.type === "post_call_transcription" ? "done" : "failed" }, event.type === "call_initiation_failure");
      await publishVoiceResult(updated);
      return { ok: true };
    });
  });
}
