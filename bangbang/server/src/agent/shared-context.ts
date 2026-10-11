import type { CallJob } from "./calls.js";
import { voiceError } from "./haiku.js";
import type { VoicePlan } from "./call-plan.js";

export type VoiceTaskRef = Pick<CallJob, "jobId" | "caseId" | "planId" | "stepId">;
export type VoiceMemory = { revision: string; facts: string[]; notes: string[]; authorized: boolean };
/** The orchestrator owns storage. Hooks must finish quickly and writes must upsert by jobId. */
export type VoiceContextSource = {
  resolveTask(ref: VoiceTaskRef): Promise<VoicePlan>;
  read(ref: VoiceTaskRef): Promise<VoiceMemory>;
  writeResult(ref: VoiceTaskRef, result: NonNullable<CallJob["result"]>): Promise<void>;
};
let source: VoiceContextSource | undefined;
async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(voiceError("Orchestrator memory deadline exceeded", 503)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** Call once during startup to attach the voice sub-agent to the orchestrator's actual memory. */
export function configureVoiceContext(value: VoiceContextSource | undefined) { source = value; }
export function hasSharedVoiceContext() { return Boolean(source); }
export async function resolveVoiceTask(ref: VoiceTaskRef): Promise<VoicePlan> {
  if (!source) throw voiceError("The orchestrator shared context is not configured", 503);
  const task = await bounded(source.resolveTask(ref), 1000);
  if (["jobId", "caseId", "planId", "stepId"].some((key) => task[key as keyof VoiceTaskRef] !== ref[key as keyof VoiceTaskRef]))
    throw voiceError("Orchestrator task reference mismatch", 409);
  return task;
}
export async function readVoiceMemory(ref: VoiceTaskRef): Promise<VoiceMemory | undefined> {
  if (!source) return undefined;
  const memory = await bounded(source.read(ref), 250);
  if (!memory || typeof memory.revision !== "string" || typeof memory.authorized !== "boolean" ||
    !Array.isArray(memory.facts) || !Array.isArray(memory.notes) ||
    [...memory.facts, ...memory.notes].some((v) => typeof v !== "string") || JSON.stringify(memory).length > 16000)
    throw voiceError("Orchestrator returned invalid or oversized voice memory", 503);
  return memory;
}
export async function publishVoiceResult(job: CallJob): Promise<void> {
  if (source && job.result) await bounded(source.writeResult(job, job.result), 2000);
}
