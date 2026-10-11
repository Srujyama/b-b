# Browser rehearsal: teammate as billing representative

This is the chosen hackathon path. A teammate speaks through the browser microphone; ElevenLabs
handles recognition and voice, and the same TypeScript server streams Haiku responses. No telephone
number, Twilio account upgrade, carrier call, or public product deployment is needed. Model/audio
usage still consumes the relevant provider credits.

Use synthetic cases. The agent announces that this is a simulated billing call. A recorded demo
agreement is not an actual provider settlement, payment authorization, or confirmed saving.

## Data path and shared context

Browser microphone → ElevenLabs browser agent → HTTPS voice gateway → local shared Fastify server
→ Anthropic Messages → streamed text back to ElevenLabs → browser audio.

The gateway accepts only `GET /health` and bearer-authenticated
`POST /api/voice/browser/llm/v1/chat/completions`. It binds to `127.0.0.1:8788` and forwards completions
to `127.0.0.1:8787`. Case APIs, tool/payment routes, phone dispatch and the web application are not
exposed through this address. `/health` confirms ingress availability, not model readiness.

`browser_case_id` travels as SDK `customLlmExtraBody`, then ElevenLabs
`custom_llm_extra_body`, then `elevenlabs_extra_body` at our endpoint. Each turn reads the current
`CasePacket` from the same in-process store the pipeline uses: facts, balance, offer ceiling, recent
offers, and consent. It does not fork memory or call an independent planning agent. The browser
retains conversation history at ElevenLabs. One shared Anthropic key is sufficient; it does not
make separate models share prompt caches or hidden reasoning. The real-phone `VoiceContextSource`
plan adapter remains a separate future integration.

## Required product-owner change (D)

WORKPLAN assigns `web/**` to D. This branch includes a ready-to-apply patch without editing that file:

```sh
# From the repository root; D applies and commits this with the product changes.
git apply --check bangbang/server/src/agent/browser-client-handoff.patch
git apply bangbang/server/src/agent/browser-client-handoff.patch
```

The patch updates `web/app.js:initToSessionOptions` to forward `customLlmExtraBody` and the supported
voice overrides. Without it, the custom Haiku endpoint rejects the missing case ID; this must be
completed before a live demo. Forwarded client tools already exist in the product.

The pinned browser SDK is `@elevenlabs/client@1.25.0`. Its TTS override serializer supports `voiceId`,
`stability`, and `speed`, but not `modelId`. Choose `VOICE_TTS_MODEL` before provisioning the browser
agent, rerun `--browser` after changing it, and restart the local server between rehearsals. Do not
change the model environment during an active rehearsal. The phone API's per-job model override is
a different transport and remains supported.

D should also label the negotiation room “Simulated billing call — teammate representative” and
carry simulated status into outcome/receipt displays. `simulated:true` is returned by human-mode
startup; the existing shared CasePacket/payment schema does not yet persist that distinction. Keep
real-money credentials disabled for this rehearsal; synthetic tool acceptance can advance the
existing demo pipeline.

## Start or recover the setup

All commands below run from `bangbang/server`. Keep secrets only in the ignored `.env`; see
[voice.env.example](./voice.env.example). Needed for a complete conversation:

- `ELEVENLABS_API_KEY`, with the previously approved TTS/voices/agents scopes.
- `ANTHROPIC_API_KEY`, the shared server credential. Deliberately deferred until the partner provides it.
- `VOICE_LLM_TOKEN`, a distinct random gateway bearer token.
- `PUBLIC_URL`, the temporary HTTPS gateway address.
- `ELEVENLABS_LLM_SECRET_ID` and `ELEVENLABS_BROWSER_AGENT_ID`, populated by browser provisioning.
- `VOICE_TTS_MODEL=eleven_v4_turbo`, `VOICE_VOICE_PRESET=bella` by default. River and Eric are alternatives;
  standard `eleven_v4` and `eleven_flash_v2_5` are available. Keep `VOICE_CALLS_ENABLED=false`.

1. Start the product server on loopback in its own terminal:

   ```sh
   node --import tsx --input-type=module -e 'import {buildApp} from "./src/index.ts"; const app=await buildApp(); await app.listen({host:"127.0.0.1",port:8787});'
   ```

2. Start the narrow ingress in another terminal:

   ```sh
   node --import tsx src/agent/public-gateway.ts
   ```

3. Start a free temporary tunnel. This service terminates TLS and can see gateway credentials and
   synthetic conversation text; the user explicitly approved it for this demo. It is not a production
   medical-data deployment. Use a dedicated known-hosts file and no personal SSH credentials:

   ```sh
   ssh -T -o BatchMode=yes -o IdentityAgent=none -o IdentitiesOnly=yes \
     -o IdentityFile=/dev/null -o StrictHostKeyChecking=accept-new \
     -o UserKnownHostsFile="${TMPDIR:-/tmp}/bangbang-tunnel-known-hosts" \
     -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
     -R 80:127.0.0.1:8788 nokey@localhost.run -- --output json
   ```

4. Copy the emitted **HTTPS origin** into local `.env` as `PUBLIC_URL`. Free domains are temporary:
   disconnects, sleep or a later tunnel allocation may change them. Keep all three processes and the
   computer running for the demo. No scheduled restart or stable hosting is installed.
5. Provision or update the dedicated agent; save both printed IDs to `.env`:

   ```sh
   node --import tsx scripts/setup-elevenlabs.ts --browser
   ```

   This creates/updates a separate agent and client tools. It never dials a number. Reuse the saved
   secret/agent IDs when updating a changed URL to avoid duplicates. Restart the product server after
   saving a new agent ID or adding the shared Claude key; the gateway must restart after token changes.
6. After D applies the patch and the shared Claude key is present, open `http://localhost:8787`, load a
   synthetic case with consent, select **Human / 真人账单员**, and start the conversation. The teammate
   speaks through that browser's microphone with headphones. The public gateway URL is not the UI.

If provisioning created a secret but then failed, the script prints its ID before creating the agent.
Save that ID and retry after fixing the reported issue. Never paste a token or API key into the browser
SDK or commit `.env`. If the temporary token is rotated, update the corresponding ElevenLabs secret
and restart both server processes.

## Teammate rehearsal guide

Start: “Patient billing, this is Alex. How can I help?” Ask whom the advocate represents and what
authorization exists. Use a made-up patient/account. Provide one fact at a time; ask for evidence
before agreeing that a charge is erroneous. Offer an itemized statement, an insurance-review route,
or a financial-assistance application as appropriate. If a discount is proposed, state its written
terms and deadline. Never claim that a real hospital approved it.

Useful three-minute sequence: identify and confirm scope → itemized bill/EOB discrepancy → assistance
or review process → affordable nonbinding proposal → written confirmation and follow-up. The full
real-world decision process is in [MEDICAL_BILL_PLAYBOOK.md](./MEDICAL_BILL_PLAYBOOK.md).

## Verification and boundaries

Automated tests cover nested case metadata, fresh shared state, revoked consent, absent credentials,
stream conversion, private-route isolation, authentication and request size limits. A synthetic public
SSE test checks that the first chunk arrives before a delayed final chunk; it does not call Claude or
prove end-to-end spoken latency. Existing TTS smoke tests used real ElevenLabs synthetic speech.

Before recording, run a real browser conversation after the two partner prerequisites are complete.
Check interruption, short responses, voice clarity, live case changes, tool results, transcript, and
clear simulated labeling. Do not report this complete until that full loop succeeds.

Twilio onboarding was stopped before selecting a paid plan or purchasing a number. Real telephony is
out of scope for this demo. Later production work includes durable hosting/store/auth, appropriate
patient-representative authorization, redaction and retention, source-specific billing evidence,
explicit approval before obligations, written provider confirmation, and real call failure testing.

Sources: [ElevenLabs custom LLM metadata](https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm),
[localhost.run free tunnel](https://localhost.run/docs/faq/),
[tunnel TLS termination](https://localhost.run/docs/security/),
[Twilio trial Voice restrictions](https://www.twilio.com/docs/usage/trials/try-out-voice).
