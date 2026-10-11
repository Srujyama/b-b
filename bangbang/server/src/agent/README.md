# Branch A: orchestrator-controlled voice sub-agent

**Merging or resuming this work? Read [MERGE_HANDOFF.md](./MERGE_HANDOFF.md) first.** It records the
agreed architecture, what is implemented, the exact partner-side wiring, and the remaining live checks.

The existing Fastify server remains the control plane. The orchestrator owns tasks and case memory;
the voice worker performs one authorized phone task. Haiku 5.5 produces streamed text and tool calls,
ElevenLabs Flash v2.5 handles speech, and ElevenLabs' native Twilio integration places the call.
The worker identifies itself as the client's AI representative. It gathers information and negotiates
nonbinding proposals; it does not execute payments or commit the client to a settlement.

The existing `bridge.ts`, browser demos, `CasePacket`, and pipeline still work. Their default GPT-4o
configuration is unchanged. The separate outbound representative is configured with `--outbound`.
No new dependencies or shared files are required. Automated provider tests run with mocks. The live
ElevenLabs API and Flash speech stream have been verified; phone setup, Claude, shared memory, and
end-to-end call latency still need configuration and a real test call.

## Same-server integration (the intended path)

Register `configureVoiceContext` once at startup. Expose `runVoiceTask` to the orchestrator as its
voice tool. It accepts references, loads the authoritative task from the orchestrator, and starts the
call. `syncVoiceTask` checks completion and writes the result to shared memory. Signed post-call
webhooks also write results. The worker reads current memory before dialing and on every LLM turn.

```ts
import { configureVoiceContext } from "./agent/shared-context.js";
import { runVoiceTask, syncVoiceTask } from "./agent/calls.js";
import { requireCase } from "./store.js";

configureVoiceContext({
  // Implement using your orchestrator's plan store; returns the VoicePlan below.
  resolveTask: async (ref) => orchestratorPlans.getVoiceTask(ref),
  read: async (ref) => {
    const packet = requireCase(ref.caseId); // the SAME object the existing pipeline uses
    return {
      revision: orchestratorPlans.revision(ref.planId),
      authorized: packet.patient?.consent === true,
      facts: packet.facts,
      notes: orchestratorPlans.voiceNotes(ref.stepId),
    };
  },
  // Upsert by jobId: webhook retries and polling may deliver the same result more than once.
  writeResult: async (ref, result) => orchestratorPlans.upsertVoiceResult(ref, result),
});

const job = await runVoiceTask({
  jobId: "call-001", caseId: "case-123", planId: "plan-123", stepId: "contact-billing",
});
// Returns after call submission, not after hangup. Resume the orchestrator on completion.
const latest = await syncVoiceTask(job.jobId);
```

`orchestratorPlans` above is your partner's storage adapter, not an existing import. The three hooks
are the remaining integration work in their branch. For clinic cases the partner must supply the
appropriate client authorization check instead of the patient-only example. Their pipeline must
explicitly call this worker: `POST /api/cases/:id/run` still uses the existing browser/demo bridge.
Do not map `completed` directly to `CasePacket.agreedAmount` or the settlement pipeline.

Memory reads have a 250 ms deadline; task lookup has 1 s and result writes have 2 s. A failed memory
read stops that turn instead of silently using old context. Authorization revocation blocks new calls
and instructs an active call to end on its next LLM turn; it is not an immediate carrier hangup.
Use the Twilio console to stop an active call immediately. Task objective, target, and maximum offer
are fixed per job; facts and notes update from shared memory. A new task gets a new job ID.

This is shared application memory, not shared model internals. Anthropic prompt caches are per model
and require matching prefixes. The gateway caches the stable system prompt and appends current memory
after the existing conversation. It does not assume access to another model's cache or hidden reasoning.
ElevenLabs retains each call's conversational history and supplies it to the gateway on each turn.

## Task contract

`VoicePlan` and its runtime schema live in `call-plan.ts`. Example with synthetic data:

```json
{
  "version": "1",
  "jobId": "call-001",
  "caseId": "case-123",
  "planId": "plan-123",
  "stepId": "contact-billing",
  "client": {
    "name": "Test Client",
    "authorization": { "confirmed": true, "reference": "consent-record-123" }
  },
  "target": { "name": "Example Hospital Billing", "phone": "+14155550123" },
  "objective": "Request an itemized bill and a written discount proposal",
  "steps": ["Confirm the billing department", "Ask about the duplicate charge", "Collect next steps"],
  "facts": ["The client reports a duplicate charge; it has not yet been verified by billing."],
  "constraints": { "maxOfferUsd": 2500, "forbiddenActions": ["Do not agree to a payment plan"] }
}
```

Only give the worker relevant verified case facts. The orchestrator retains responsibility for its
evidence and authorization checks. The monetary ceiling is a spoken-agent instruction, not a
deterministic guarantee of what a model will say. The phone agent has no payment or settlement tools.
No ceiling means the agent must not offer money. Completed calls always return `requiresReview:true`.

Results include the same job/case/plan/step IDs, provider conversation ID and call SID, call status,
summary, proposal, blockers, next steps, transcript, duration, and termination reason when available.
Provider analysis is model-generated evidence, not a validated deal or proof of task success.

## Connect ElevenLabs first (Claude can wait)

Create a restricted ElevenLabs key with **Text to Speech access**, **Voices read**, and
**ElevenAgents write**, then save it as `ELEVENLABS_API_KEY` in the ignored `server/.env`.
Keep any temporary hackathon key's expiry in mind; the locally configured key expires October 18, 2026.
Credentials, gateway tokens, and generated samples are not part of this branch or PR.

```sh
npm run setup:agents -- --check
npm run setup:agents -- --smoke-test
```

`--check` only reads the selected voice, agent API, and outbound Twilio number inventory. An API
connection can pass with zero phone numbers and no configured outbound agent; it is not call readiness.
`--smoke-test` consumes TTS credits to synthesize one fixed, synthetic representative greeting, saves
an MP3 in the operating system's temporary directory, and reports first-audio-byte and total timings.
Neither command requires Anthropic credentials, sends client information, or places a phone call.
Do not combine these modes with setup or `--dry-run`.

The advocate default is Bella (`hpp4J3VqNfWAUOO0d1Us`), an included premade voice, with Flash v2.5 for
the phone worker. The earlier Rachel default returned HTTP 402 on this account because it is now a
library voice that requires a paid plan/credits. Override `ELEVENLABS_ADVOCATE_VOICE_ID` to choose another
voice. A successful metadata lookup alone does not prove synthesis is allowed on the account's plan.

Live check on October 11, 2026: all three read probes passed, zero Twilio numbers were present, and
one Bella/Flash sample returned 104,534 audio bytes. Its first audio bytes arrived after 325 ms and
the entire response after 477 ms. This is one laptop-to-provider observation, not a benchmark or a
measure of ASR, Haiku, telephony, or end-of-turn response latency.

## Configure outbound calls

1. Copy the entries from `voice.env.example` in this directory into `server/.env` (D owns the shared
   root `.env.example`). Set the ElevenLabs key, two different random tokens,
   `PUBLIC_URL` to the server's public HTTPS origin, and `VOICE_JOB_DIR` to an absolute persistent
   directory outside the repo and web root. Keep all real credentials out of git.
2. Run `npm run setup:agents -- --outbound --dry-run` to inspect the config with no keys or network.
3. Start the server and run `npm run setup:agents -- --outbound`. Save the printed
   `ELEVENLABS_LLM_SECRET_ID` and `ELEVENLABS_OUTBOUND_AGENT_ID` in `.env`. Subsequent runs reuse them.
   The stored ElevenLabs secret contains only the gateway token; the Anthropic key stays on our server.
   If you rotate `VOICE_LLM_TOKEN`, update the corresponding ElevenLabs workspace secret too.
   `ANTHROPIC_API_KEY` can remain unset during ElevenLabs provisioning. Before enabling calls, set
   the server's shared Anthropic credential; the orchestrator and voice gateway can use it subject
   to its workspace permissions and shared limits. There is no separate Claude account or key required
   for this worker, and a shared key does not automatically share model context or prompt caches.
4. In ElevenLabs, import a Twilio voice number with its account SID and auth token. Set the returned
   ElevenLabs phone number ID as `ELEVENLABS_PHONE_NUMBER_ID`. The server does not need Twilio keys
   because ElevenLabs manages the telephony connection.
5. Create a workspace webhook targeting `PUBLIC_URL/api/voice/webhooks/elevenlabs`, enable retries,
   and save its signing secret as `ELEVENLABS_WEBHOOK_SECRET`. Set its ID as
   `ELEVENLABS_POST_CALL_WEBHOOK_ID` and rerun outbound setup to attach transcript and call initiation
   failure events. Polling via `syncVoiceTask` also works without a webhook.
6. Register the shared-context hooks. Check `/api/voice/ready` with the orchestrator bearer token.
   `configured` checks environment presence only; `sharedMemoryConnected` reports hook registration;
   neither claims live validation. Set `VOICE_ALLOWED_NUMBERS` to your test phone in E.164 form, then
   set `VOICE_CALLS_ENABLED=true` when ready to test a call.

The public gateway endpoint is `/api/voice/llm/v1/chat/completions`. It requires `VOICE_LLM_TOKEN`,
translates text/function history to Anthropic's native Messages API, disables thinking for spoken
turns, omits incompatible sampling parameters, streams SSE deltas, and cancels upstream generation
when ElevenLabs disconnects. `voiceFirstTokenMs` logs measure LLM text latency, not complete audio latency.
The agent also has IVR keypad, wait-on-hold, and hangup tools. Calls have a 10-minute maximum.

## Optional HTTP interface

The same server can use direct functions. These routes are also available for tests and future
separate deployment. All except the signed provider webhook require the appropriate bearer token.

| Route | Purpose |
| --- | --- |
| `GET /api/voice/ready` | Configuration and shared-memory status |
| `POST /api/voice/jobs/preview` | Validate a VoicePlan and preview its prompt; never dials |
| `POST /api/voice/jobs` | Submit a VoicePlan; returns 202 plus job state |
| `GET /api/voice/jobs/:id` | Read saved state and retry shared result delivery |
| `POST /api/voice/jobs/:id/refresh` | Fetch provider state, persist and publish the result |
| `POST /api/voice/jobs/:id/reconcile` | Attach a provider conversation after an uncertain dispatch; body `{ "conversationId": "..." }`; checks job identity |
| `POST /api/voice/webhooks/elevenlabs` | HMAC-verified transcript/failure events; requires webhook signing secret |

States: `dispatching → submitted → in_progress → completed/failed`. Network uncertainty becomes
`unknown`. The same job ID and content never dial again, including after restart; different content
with that ID returns 409. A second active or uncertain call for the same case is refused.
If a process dies while dispatching, do not submit a new job. Locate the call in ElevenLabs and
reconcile its conversation ID. If the provider confirms no call exists, an operator must retire the
reserved job record before retrying. There is intentionally no automatic redial.

The job journal uses restricted file permissions and atomic replacement on a persistent volume.
Run one server process; this is not a distributed queue or transaction system. Do not put the journal
in the public web directory. The existing CasePacket store remains in memory and needs the partner's
persisted case storage for restart recovery. Journal records contain transcripts: retain and protect
them according to the application's data handling requirements.

## Verification and provider choices

Run `npm run typecheck` and `npm test`. Tests cover streaming/tool translation, fragmented Unicode
SSE, authorization, preview without keys, duplicate dialing, restart persistence, unknown outcomes,
signed callbacks, polling, shared memory updates, revocation, and result writeback. No real call is
made by tests or setup.

After keys are present, verify on a test phone: greeting, interruptions, digit spelling, IVR, hold,
voicemail, rejected authorization, an offer above the ceiling, busy/no-answer, callback delivery,
and the orchestrator receiving the final result. Measure several end-of-speech to first-audio gaps;
do not treat an advertised TTS latency as an end-to-end call latency guarantee.

Twilio native integration is implemented because it handles phone transport and ElevenLabs audio
without a second voice platform. SIP trunking is a future carrier alternative. Vapi would add another
voice orchestration layer to this existing ElevenLabs architecture, so it is not required here.

Official references checked 2026-10-11:
- [Haiku 5.5 model and API ID](https://platform.claude.com/docs/en/models/haiku-5-5/overview)
- [ElevenLabs custom LLM streaming interface](https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm)
- [ElevenLabs Twilio native integration](https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/native-integration)
- [Twilio outbound call API in ElevenLabs](https://elevenlabs.io/docs/eleven-agents/api-reference/integrations/twilio/outbound-call)
- [ElevenLabs post-call webhooks](https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks)
- [Anthropic per-model cache behavior](https://platform.claude.com/docs/en/build-with-claude/fallback-credit)
