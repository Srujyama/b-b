# Branch A merge handoff: voice execution under the orchestrator

Prepared 2026-10-11 for the session merging `feat/voice` into the combined BangBang application.
Read this file before connecting the real phone worker to the product pipeline. The complete request
example, environment setup, route table, and provider references are in [README.md](./README.md).

## Agreed product and architecture decisions

The user owns Branch A (Voice & Story). Their partner is building the orchestrator in the **same
Node/TypeScript/Fastify server**. The requested voice stack is Claude Haiku 5.5 for conversation,
ElevenLabs for speech, and a phone API for real outbound calls. The caller represents the client;
it must identify itself as an AI representative and must not impersonate the client or a human.

The voice worker is a subordinate execution tool of the orchestrator. The orchestrator owns the plan,
task selection, authorization, and shared case memory. It invokes the worker with identifiers; the
worker resolves its task from the orchestrator and reads the same memory on each spoken turn.
It does not run an independent planning loop or require an HTTP handoff inside this server.

Shared memory means shared application storage, not a shared hidden model state. Prompt caching is
per model and depends on matching prompt prefixes. Do not assume an orchestrator using another model
shares its cache with Haiku. The native Anthropic adapter requests caching for the stable system
prompt and adds the latest memory after the conversation history.

The partner's architecture document described the current GPT-4o/ElevenLabs browser and agent-vs-agent
demo. This branch adds a **separate Haiku outbound representative**. It does not silently replace those
demo agents, change their tools, or switch the existing product pipeline to real phone calls.

The user requested implementation around empty API-key placeholders. No real credentials have been
added, no provider agents or workspace secrets have been created by this work, and no calls have been
placed. Live phone setup and latency/voice validation remain future work.

## What each file contributes

| File relative to `bangbang/server/` | Responsibility |
| --- | --- |
| `src/agent/call-plan.ts` | Versioned `VoicePlan`, HTTP schema, direct-call validation, representative prompt, per-call IDs, outbound agent configuration |
| `src/agent/shared-context.ts` | Orchestrator storage hooks, bounded task/memory/result operations, shared-context registration |
| `src/agent/calls.ts` | `runVoiceTask`, `syncVoiceTask`, real Twilio-through-ElevenLabs dispatch, persistent job journal, polling, reconciliation, authenticated routes, signed callbacks |
| `src/agent/haiku.ts` | Protected ElevenLabs-compatible SSE endpoint backed by native Anthropic Messages, text/tool conversion, prompt caching, memory injection, cancellation and latency logging |
| `src/agent/elevenlabs.ts` | Adds creation of the ElevenLabs workspace secret that holds the gateway token |
| `src/routes/voice.ts` | Registers the new gateway and phone routes within the existing voice plugin |
| `scripts/setup-elevenlabs.ts` | Adds `--outbound` and `--dry-run`; normal demo setup remains available |
| `src/agent/voice.env.example` | Empty credentials and documented settings for the new worker |
| `test/voice.test.ts` | Adds mocked coverage for the new worker, streaming, shared context, callbacks and failures |

No package/lockfile, shared `types.ts`, `store.ts`, `index.ts`, `env.ts`, `llm.ts`, product pipeline,
money-rail code, UI, or shared `.env.example` edits are included. These remain with their owners under
WORKPLAN. The new routes are reachable because the existing `index.ts` already registers `voiceRoutes`.

## Merge sequence for the partner/session

1. Merge the voice implementation and documentation together. Keep the current product pipeline and
   demo path working while attaching the new tool. There are no new npm dependencies to reconcile.
2. Implement the three `VoiceContextSource` hooks against the orchestrator's actual stores. Register
   them with `configureVoiceContext(...)` once during server startup, before accepting voice tasks.
3. Register `runVoiceTask(ref)` as the orchestrator's voice execution tool. Select it explicitly for
   an authorized real-phone task; do not replace every existing negotiation call automatically.
4. Handle job submission, asynchronous completion, and result review as separate orchestration steps.
   Use signed callbacks or `syncVoiceTask(jobId)` to obtain the final result.
5. Integrate the environment template into the deployment configuration. D can consolidate it into
   the shared `.env.example` when merging. Keep live calling disabled until provider setup is complete.
6. Rerun typecheck/tests after all branches merge, then complete the live verification below.

### Required shared-context hooks

```ts
type VoiceTaskRef = {
  jobId: string;
  caseId: string;
  planId: string;
  stepId: string;
};

configureVoiceContext({
  resolveTask: async (ref) => /* VoicePlan from the orchestrator's task store */,
  read: async (ref) => /* { revision, facts, notes, authorized } from shared memory */,
  writeResult: async (ref, result) => /* upsert result into shared memory by jobId */,
});
```

The example above is an interface sketch, not code to paste unchanged. `VoiceContextSource` in
`shared-context.ts` is the exact compiled interface; the README includes a fuller adaptation example.

- `resolveTask`: return a valid `VoicePlan` with all four identifiers matching the reference. Build its
  objective, ordered steps, verified facts, destination in E.164 format, client authorization record,
  prohibited actions, and optional maximum offer from the canonical task/case. Deadline: 1 second.
- `read`: return the latest string revision, arrays of facts and notes, and explicit authorization
  boolean. Use the same case store as the orchestrator; do not create a disconnected copy. The worker
  checks this before dialing and before each model response. Deadline: 250 ms, payload limit: 16,000
  JSON characters. Prefer in-process reads and keep slow research out of the voice turn.
- `writeResult`: persist/upsert by job ID and wake or advance the owning plan step as appropriate.
  Delivery can repeat through webhook retries or polling, so writes and downstream actions must be
  idempotent. Deadline: 2 seconds. The worker saves the result in its journal before calling this hook;
  a failed write can be retried without dialing again.

Use client authorization appropriate to patient versus clinic tasks. The README's patient-consent
example must not be copied as the clinic authorization implementation. The worker cannot establish
authorization from a model's statement that it has permission.

Do not unregister or swap the process-global context source during active calls. The intended
deployment is one server instance with one registered adapter and a persistent voice-job volume.

### Completion and review semantics

`runVoiceTask(ref)` returns a job after the provider submission attempt; it does **not** wait for the
phone conversation to finish. The orchestrator should mark the task as awaiting a call result and
continue other eligible work. When polling, `syncVoiceTask(jobId)` performs one provider refresh; it
does not contain an automatic background polling loop. The caller owns scheduling/backoff.

`completed` means the provider conversation finished. It does not mean the objective succeeded or a
settlement was accepted. Results contain `requiresReview: true`, a transcript and, when supplied by
ElevenLabs analysis, a summary, proposal, blockers and next steps. Provider analysis is model-generated
evidence. The orchestrator must review it before updating task outcomes or taking additional actions.

Do **not** set `CasePacket.agreedAmount`, emit a `deal`, or call settlement/payment code merely because
the phone job completed or provider analysis says success. This worker has no acceptance/payment
tools. Its maximum offer is a prompt constraint rather than a deterministic guarantee of spoken words.
Existing demo settlement tools remain separate.

## Retry, recovery, and operational boundaries

- Job ID is the idempotency key. Repeating the same ID and task reads the existing job; different
  content with the same ID is rejected. Keep retries tied to the original persisted task version.
- A reservation is written before provider dispatch. A transport failure becomes `unknown`; a crash
  can leave `dispatching`. Neither is evidence that no call occurred. Do not create another job to
  bypass the reservation. Find and reconcile the provider conversation first.
- A second active or uncertain job for the same case is refused. Confirmed terminal jobs allow a new
  explicitly planned attempt with a new ID.
- The journal is a local file store, not a distributed queue. Do not scale to multiple writers or put
  it on an ephemeral deployment filesystem without replacing this persistence design.
- The journal stores job state and call evidence, not a copy of the entire orchestrator plan/case.
  The current repository's `CasePacket` store is in memory. The partner must supply persistent shared
  task/case storage if calls need to survive full application restarts.
- Objective, target and maximum offer are fixed per job. Facts/notes can change through shared memory.
  Revocation prevents new dialing and tells an active call to end on its next model turn. It is not an
  immediate carrier-level stop; use the Twilio console for an immediate hangup.
- Phone jobs do not yet feed the existing browser's live audio/Chinese-transcript negotiation room.
  The existing bridge still does that for demo conversations. Product integration should decide how
  to present phone progress/results; do not assume that merging this branch adds a live phone UI.

## Provider setup and credential ownership

Use [voice.env.example](./voice.env.example) and the README's ordered setup instructions.

- Server: Anthropic key, ElevenLabs key, public HTTPS origin, persistent `VOICE_JOB_DIR`.
- Orchestrator HTTP access: `VOICE_ORCHESTRATOR_TOKEN`; direct in-process tools don't transmit this
  token, although the current common readiness check still requires it to be configured.
- ElevenLabs-to-server LLM access: separate `VOICE_LLM_TOKEN`. Outbound setup stores that token in an
  ElevenLabs workspace secret and prints its ID. It does not upload the Anthropic key.
- Phone transport: import a Twilio number in ElevenLabs and store the ElevenLabs phone-number ID.
  Twilio credentials belong in that integration; our server dispatches through ElevenLabs.
- Result callbacks: ElevenLabs webhook ID and HMAC signing secret, with retries enabled. Attach
  transcript and call-initiation-failure events through outbound setup. Polling remains an alternative.
- `VOICE_CALLS_ENABLED=false` is the template default. A **required** `VOICE_ALLOWED_NUMBERS` list restricts
  calls to known test phones; if it is empty, no call is placed.

`GET /api/voice/ready` reports configured environment fields and whether hooks are registered. It
does not probe credentials, validate provider account permissions, check storage writability, or
prove phone/model availability. `liveVerified` remains false by design. Avoid interpreting this
endpoint as a successful end-to-end health check.

## Verified locally and still pending

At the commit checkpoint, the baseline plus new tests total **191 passing tests across 12 files**.
TypeScript typecheck and whitespace checks pass. Outbound setup config generation has been exercised
without keys using a dry run. Provider network requests in tests are mocked.

From `bangbang/server`, the normal verification commands are:

```sh
npm run typecheck
npm test
npm run setup:agents -- --outbound --dry-run
```

If a restricted execution environment blocks the `tsx` CLI's local IPC pipe, the equivalent dry-run
command is `node --import tsx scripts/setup-elevenlabs.ts --outbound --dry-run`.

Before declaring the combined application live-ready, verify real agent creation/update, gateway
authentication and streaming, imported-number dialing, both sides of a call, interruptions, IVR,
hold, voicemail, busy/no-answer, webhook signature handling/retries, result writeback, authorization
revocation, and duplicate submission behavior on a test destination. Confirm that a result resumes
the correct plan/step and cannot trigger settlement without the orchestrator's review.

Measure several end-of-speech to first-audio delays on real calls. `voiceFirstTokenMs` measures only
the model's first text token; no real end-to-end latency measurements exist for this implementation.
The voice model has thinking disabled, a 512-token reply limit, streamed deltas and an upstream
20-second deadline. The outbound agent uses Flash v2.5, normal turn eagerness, digit-spelling patience,
and a 600-second call limit. Tune these only after observing actual call behavior.
