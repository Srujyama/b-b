# Branch A merge handoff: voice execution under the orchestrator

Prepared 2026-10-11 for the session merging `codex/browser-voice-demo` into the combined Vellum application.
Read this file before connecting the real phone worker to the product pipeline. The complete request
example, environment setup, route table, and provider references are in [README.md](./README.md).

This branch includes integrated `origin/main` through `85b4028` (including persistence, deployment and merged voice PR #11).
The remaining diff adds browser rehearsal, HTTPS ingress/URL synchronization, and this handoff. There are no new npm
dependencies or edits to the product owner's files.

## Current priority: browser rehearsal, no Twilio

The team chose to skip paid phone transport for the hackathon. A teammate speaks into the browser
as billing. Use [BROWSER_DEMO.md](./BROWSER_DEMO.md) for setup; the retained phone-worker sections
below are for later production work, not prerequisites for this rehearsal.

Implemented and provisioned locally on October 11:

- Separate **Vellum Haiku Browser Rehearsal** ElevenLabs agent, Haiku custom gateway, v4 Turbo/Bella,
  three client tools, signed-session authentication, four-minute limit, and voice recording disabled.
- Public HTTPS tunnel to a loopback-only gateway; only browser completions are forwarded. The product
  server, case routes, tools and money routes remain local. The free temporary domain and provider IDs
  are saved only in ignored `.env`; they are not durable deployment configuration.
- A tunnel launcher follows free-domain rotation and updates the existing ElevenLabs agent and local
  `PUBLIC_URL`. A manual tunnel rotated during verification; the launcher addresses that failure.
- Gateway token stored in an ElevenLabs workspace secret. The Anthropic key remains deferred. The
  user approved localhost.run TLS termination for synthetic demo traffic.
- Each model turn reads the SAME CasePacket in the shared server store: facts, budget, recent offers and consent.
  Missing metadata fails closed. ElevenLabs sends it in `elevenlabs_extra_body`; the gateway now
  reads that nested object. The older top-level phone-job field remains backward compatible.
- [Medical-bill playbook](./MEDICAL_BILL_PLAYBOOK.md) with CMS/CFPB/IRS/HHS sources, and a revised
  demo narrative distinguishing simulated agreements from real provider confirmation.

**One partner prerequisite remains:** supply the shared `ANTHROPIC_API_KEY`. The browser adapter change
was applied to `web/app.js` by D when this merged. It forwards case
metadata plus voice overrides to SDK 1.25.0. That serializer cannot set the model per browser session;
choose the model at agent provisioning, rerun `--browser` and restart between rehearsals.

D must also carry simulation labels through the UI/results before showing the demo. Existing demo
acceptance tools can advance the pipeline: keep real-money credentials disabled for this rehearsal.
Shared schema changes belong to D. The future real-phone worker remains nonbinding.

No real phone call, live Haiku response, completed spoken browser rehearsal, or real financial action
has been performed. Twilio onboarding stopped before selecting a paid plan or buying a number.

## Agreed product and architecture decisions

The user owns Branch A (Voice & Story). Their partner is building the orchestrator in the **same
Node/TypeScript/Fastify server**. The requested voice stack is Claude Haiku 5.5 for conversation,
Eleven v4 Turbo for speech, and, in the future, a phone API for real outbound calls. Standard Eleven v4 and Flash v2.5
are explicit alternatives. The caller represents the client;
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
demo. This branch adds separate Haiku browser and outbound representatives. Human mode selects the
browser agent when configured. Legacy GPT-4o agents and the agent-vs-agent bridge remain available;
the product pipeline never switches to real phone calls implicitly.

Initial implementation used empty API-key placeholders. The user subsequently authorized connecting
ElevenLabs first and deferring Claude credentials. A restricted ElevenLabs key is now saved only in
the ignored local `server/.env`; it expires October 18, 2026. Two separate gateway/orchestrator tokens
are also configured locally. No credentials are committed. A browser agent and workspace gateway secret are provisioned. No outbound phone agent or phone
number is provisioned, and no phone calls have been placed. Real dialing remains disabled.

## What each file contributes

| File relative to `vellum/server/` | Responsibility |
| --- | --- |
| `src/agent/call-plan.ts` | Versioned `VoicePlan` with optional speech choices, HTTP/direct validation, representative prompt, per-call IDs, outbound agent configuration |
| `src/agent/speech.ts` | V4 Turbo default, model/voice catalog, validated selection, provider overrides, concise model-aware Haiku delivery rules |
| `src/agent/shared-context.ts` | Orchestrator storage hooks, bounded task/memory/result operations, shared-context registration |
| `src/agent/calls.ts` | `runVoiceTask`, `syncVoiceTask`, real Twilio-through-ElevenLabs dispatch, persistent job journal, polling, reconciliation, authenticated routes, signed callbacks |
| `src/agent/browser-demo.ts` | Browser configuration, simulated first message, direct CasePacket reads |
| `src/agent/demo-tunnel.ts` | Free SSH tunnel launcher; validates provider domains, updates agent URL and local environment on rotation |
| `src/agent/public-gateway.ts` | Loopback ingress for authenticated browser completions, with bounded streaming proxy |
| `src/agent/haiku.ts` | Protected ElevenLabs-compatible SSE endpoint backed by native Anthropic Messages, text/tool conversion, prompt caching, memory injection, cancellation and latency logging |
| `src/agent/elevenlabs.ts` | Adds creation of the ElevenLabs workspace secret that holds the gateway token; updates advocate default to included Bella voice |
| `src/agent/connection.ts` | Read-only API probes and an explicit synthetic audio smoke test using the selected model/voice, independent of Claude |
| `src/routes/voice.ts` | Registers the new gateway and phone routes within the existing voice plugin |
| `scripts/setup-elevenlabs.ts` | Adds `--browser`, `--outbound`, `--dry-run`, `--options`, `--check`, and `--smoke-test`; normal demo setup remains available |
| `src/agent/voice.env.example` | Empty credentials and documented settings for the new worker |
| `test/voice.test.ts` | Adds mocked coverage for the new worker, streaming, shared context, callbacks and failures |

No package/lockfile, shared `types.ts`, `store.ts`, `index.ts`, `env.ts`, `llm.ts`, product pipeline,
money-rail code, UI, or shared `.env.example` edits are included. These remain with their owners under
WORKPLAN. The new routes are reachable because the existing `index.ts` already registers `voiceRoutes`.

## Future real-phone merge sequence for the partner/session

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

### New v4 speech selection

- Default: `VOICE_TTS_MODEL=eleven_v4_turbo`, `VOICE_VOICE_PRESET=bella`. Alternatives are `eleven_v4`
  (higher fidelity) and `eleven_flash_v2_5` (speed comparison), with Bella, River, and Eric voice presets.
  D should consolidate the two new default settings from `voice.env.example` into deployment config.
- The orchestrator may include `speech: { model: "eleven_v4_turbo", voice: "river" }` in its VoicePlan.
  This is optional and old plans remain valid. Invalid choices are rejected before provider dispatch.
- Read the authenticated `GET /api/voice/options` catalog or run setup `--options` without a key.
  A future UI picker must use its server layer; never send the orchestrator bearer token to the browser.
- The job saves the resolved speech model and voice ID. Dialing sends the same TTS override to ElevenLabs;
  Haiku receives instructions derived from that journal snapshot on every turn. Changing environment
  defaults does not change active jobs. Changing a submitted job's speech selection is a conflict.
- Rerun outbound provisioning before using this code with an existing provider agent, because this
  release enables model/voice overrides. Do not manually change active provider call settings without
  matching the saved job. Legacy jobs without snapshots retain Flash/plain-text prompt behavior.
- Haiku is told to start speaking useful words immediately, target one or two short sentences, use
  ordinary punctuation, and apply `[pause]` or `[slow]` only for important information. There is no
  full-response buffering or second model pass. Long silences use `skip_turn`; no SSML break markup.
  This is delivery guidance, not a deterministic guarantee of tag counts or exact pause duration.
- No real client call or live Haiku turn has been tested yet. The samples below verify ElevenLabs
  synthesis only. The existing browser/demo agent configs remain separate from this outbound worker.

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

The orchestrator and voice worker may share the server's `ANTHROPIC_API_KEY`; the user asked to defer
that credential for now. ElevenLabs setup no longer requires it, but call readiness and the voice
gateway still do. Shared credentials do not themselves provide shared memory or per-model caches.

Use `npm run setup:agents -- --check` to verify ElevenLabs access independently. The restricted key
needs only Text to Speech access, Voices read, and ElevenAgents write for the implemented setup.
Webhooks can be configured through the ElevenLabs UI later; account administration is not granted to
this key. `--smoke-test` makes one credit-consuming, synthetic TTS request and saves a temporary MP3.

`GET /api/voice/ready` reports configured environment fields and whether hooks are registered. It
does not probe credentials, validate provider account permissions, check storage writability, or
prove phone/model availability. `liveVerified` remains false by design. Avoid interpreting this
endpoint as a successful end-to-end health check.

## Verified locally and still pending

At the latest checkpoint, the baseline plus new tests total **253 passing tests across 15 files**.
TypeScript typecheck and whitespace checks pass. Outbound setup config generation has been exercised
without keys using a dry run. Provider network requests in tests are mocked.

Live ElevenLabs validation on October 11, 2026 passed voice, agent, and phone-inventory API reads.
No Twilio number exists yet. The previous Rachel voice returned `paid_plan_required` on the free
account; the included Bella voice succeeded with Flash v2.5, so Bella is now the default advocate
voice (including the existing demo unless overridden). A 104,534-byte MP3 arrived with first bytes at
325 ms and complete response at 477 ms. These are one synthetic TTS request's timings, not phone or
Claude latency. The public URL, browser agent/secret IDs and private persistent `VOICE_JOB_DIR` are now configured
locally. Phone IDs, Anthropic credentials, webhook setup and the future phone plan adapter remain pending.
A public synthetic SSE test received its first chunk at 170 ms and completion at 1,670 ms (a deliberate
1.5-second final-chunk delay), proving incremental delivery. Public health returned 200; missing
bearer auth returned 401; private case routes returned 404. A subsequent authenticated request reached
the real server's case lookup. These are transport checks, not model or spoken latency measurements.

Subsequent live v4 checks all returned nonempty streamed MP3 audio. V4 Turbo first-byte/complete-response
times were Bella 389/1,455 ms, River 367/1,429 ms, and Eric 352/1,520 ms. Standard v4 with Bella was
631/1,810 ms. These were individual synthetic requests containing `[pause]`, not a controlled benchmark,
subjective listening review, or an end-to-end call test. Keep v4 Turbo as the responsive default.

Tests also cover per-call selection, persisted settings across environment changes/restarts, legacy
Flash jobs, invalid HTTP/direct selections, model-aware Haiku prompts, and immediate streaming when
audio tags are split across chunks. Typecheck and the setup dry run validate against the merged code.

From `vellum/server`, the normal verification commands are:

```sh
npm run typecheck
npm test
npm run setup:agents -- --outbound --dry-run
```

If a restricted execution environment blocks the `tsx` CLI's local IPC pipe, the equivalent dry-run
command is `node --import tsx scripts/setup-elevenlabs.ts --outbound --dry-run`.

For the chosen browser demo, complete the prerequisites above and run a real spoken rehearsal.
For future telephony, before declaring the combined application live-ready, verify agent creation/update, gateway
authentication and streaming, imported-number dialing, both sides of a call, interruptions, IVR,
hold, voicemail, busy/no-answer, webhook signature handling/retries, result writeback, authorization
revocation, and duplicate submission behavior on a test destination. Confirm that a result resumes
the correct plan/step and cannot trigger settlement without the orchestrator's review.

Measure several end-of-speech to first-audio delays on real calls. `voiceFirstTokenMs` measures only
the model's first text token; no real end-to-end latency measurements exist for this implementation.
The voice model has thinking disabled, a 512-token reply limit, streamed deltas and an upstream
20-second deadline. The outbound agent defaults to v4 Turbo, normal turn eagerness, digit-spelling patience,
and a 600-second call limit. Tune these only after observing actual call behavior.
