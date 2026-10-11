# Hosted judge demo: Vellum integration handoff

Prepared 2026-10-11. The founder owns deployment and wallet secrets. This PR is reviewed and merged
into `main`; GitHub runs TypeScript + tests before deploying Fly. No personal or app deploy token is
needed by Branch A. Do not deploy this feature branch directly.

## Current deployment and architecture

- Judge frontend: https://vellum-advocate.vercel.app
- Backend + WebSockets + persistent case store: https://vellum-app.fly.dev
- The backend can also serve the frontend directly. `bangbang-bab` has been retired.
- One always-on Node 24 / TypeScript / Fastify process on Fly, port 8787, with `/data` on the
  `vellum_data` volume. Cases and escrow state use the existing atomic persistence layer. Keep one
  process/machine until storage and live-call coordination are redesigned for multiple instances.
- Vercel proxies REST requests to Fly. Browser case events connect to `wss://vellum-app.fly.dev/ws`.
- Browser microphone -> ElevenLabs ASR -> protected Fly Haiku endpoint -> ElevenLabs v4 Turbo -> audio.
  Haiku reads the SAME in-process CasePacket that research, the pipeline and client tools update.
  One Anthropic account key serves the app; different models do not share hidden state or prompt caches.
- The default app LLM remains Opus 5.5; the voice model is Haiku 5.5. The supporting intake and fake
  hospital agents use ElevenLabs' native model configuration. No Twilio transport is used.

Both public `/health` endpoints returned 200 during verification. The founder has now imported the
AI settings: Fly reports `anthropic:true`, `contextDev:true`, `elevenlabs:true`. The temporary tunnel
is stopped and the ElevenLabs agent now targets the Fly endpoint. The code in this PR still needs the normal reviewed
main release before hosted transcript/context verification can pass. Local live tests used real
provider requests and synthetic patient data; configuration health is not a full hosted call test.

## Founder: import voice settings, then point ElevenLabs at Fly

A private `vellum-voice.fly.env` file was prepared outside the repository for the user to transfer to
the founder. It contains ONLY AI/voice configuration, not Fly deploy credentials or wallet keys.
Do not commit that file, place it under `web/`, or paste it into a PR. Its variables are:

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Shared Claude account credential |
| `CONTEXT_DEV_API_KEY` | Sourced hospital policy / pricing research |
| `ELEVENLABS_API_KEY` | Existing approved TTS, voices-read, ElevenAgents-write key |
| `VOICE_LLM_TOKEN` | Gateway bearer token; must match the ElevenLabs workspace secret |
| `ELEVENLABS_LLM_SECRET_ID` | Existing ElevenLabs secret reference used for agent provisioning |
| `ELEVENLABS_BROWSER_AGENT_ID` | Haiku / v4 Turbo advocate |
| `ELEVENLABS_HOSPITAL_AGENT_ID` | AI fake-hospital backup |
| `ELEVENLABS_INTAKE_AGENT_ID` | Mandarin intake |
| `ELEVENLABS_INTAKE_VOICE_ID` | River, also used by Mandarin outcome narration |
| `VOICE_LLM_MODEL` | `claude-haiku-5-5` |
| `VOICE_TTS_MODEL` | `eleven_v4_turbo` (alternatives: `eleven_v4`, `eleven_flash_v2_5`) |
| `VOICE_VOICE_PRESET` | `bella` (alternatives: `river`, `eric`) |
| `VOICE_CALLS_ENABLED` | `false` — no real phone calls |
| `PUBLIC_URL` | `https://vellum-app.fly.dev` |
| `PUBLIC_WS_ORIGIN` | `wss://vellum-app.fly.dev` |

1. Review and merge this PR, allowing the existing main-only CI/deploy job to finish. Vercel follows
   main independently, so wait for both releases before testing.
2. From the founder's authenticated Fly session, import the private file (replace its path):

   ```sh
   fly secrets import --app vellum-app < /absolute/path/vellum-voice.fly.env
   ```

   This changes only the named values and restarts the app. It does not remove existing wallet secrets.
3. **Stop every local `demo-tunnel.ts` launcher first.** It updates this same ElevenLabs agent when a
   temporary hostname rotates and would otherwise overwrite the hosted endpoint.
4. From `vellum/server` on the reviewed commit, configure the existing agent using the private file:

   ```sh
   DOTENV_CONFIG_PATH=/absolute/path/vellum-voice.fly.env node --import tsx scripts/setup-elevenlabs.ts --browser
   ```

   The provider's custom LLM URL must be `https://vellum-app.fly.dev/api/voice/browser/llm/v1`.
   ElevenLabs appends `/chat/completions`. Including that suffix in the configured base caused the live
   404 failure found and fixed during this integration. Our HTTP route still includes the full suffix.
5. Verify `/health` reports all three AI services configured, then perform the hosted smoke test and
   an actual browser-microphone rehearsal. The judge path must work with this Mac's server/tunnel off.

No phone agent/number, `VOICE_ORCHESTRATOR_TOKEN`, or phone journal directory is required for the
browser demo. Retained real-phone routes stay disabled and separate from the shared CasePacket path.
The approved ElevenLabs key expires October 18; replace it for judging after that date.

## Reproducible checks

From `vellum/server`:

```sh
npm test
npm run typecheck
# Create a synthetic case in the app, complete research, and copy its ID.
# This explicit live test spends a small amount of provider credit, never accesses a microphone,
# never calls a phone number, and declines state-changing negotiation tools.
LIVE_DEMO_URL=https://vellum-app.fly.dev node --import tsx src/agent/live-rehearsal.ts <synthetic-case-id>
```

The smoke test synthesizes a fake hospital sentence, sends PCM audio through ElevenLabs speech
recognition, receives Haiku/v4 audio, and posts both transcript lines with the per-session capability.
It succeeds only if speech is recognized, a reply and audio arrive, and both lines are saved.
The test accepts the consenting Lin Mei fixture. It is not a completed negotiation or a latency SLA.

Live results on this Mac, October 11:

- Claude credentials: real Haiku completion returned 200.
- Demo intake: 17 lines, $14,296 balance, four audit flags, Chinese explanations; about 31.5 seconds.
- Context.dev research: six codes checked, one returned a verified numeric price, sourced hospital
  assistance policy found; about 74.6 seconds. Missing prices remain absent, not invented.
- Full synthetic speech path: recognized input, Haiku reply, v4 PCM audio, two saved/translated lines.
  First audio after the input ended: 1.63 seconds, then 1.65 seconds; the final memory-placement
  regression run also passed at 1.65 seconds.
- Mandarin outcome TTS: 200, 442,244 bytes of MP3.
- Browser reload: bilingual transcript survived and the simulated-call label remained visible.
- Rehearsal replies were longer than the requested 35-word target despite prompt tuning. Treat brevity
  as a behavior to evaluate in the live microphone rehearsal, not as a guaranteed word limit.

## What changed for review

- Fix the ElevenLabs custom-LLM base URL (both browser and future phone agent).
- Apply the formerly separate browser adapter patch: case metadata + supported voice overrides reach
  SDK 1.25.0. Model selection remains at provisioning because that SDK does not serialize `modelId`.
- Put fresh shared case memory in an uncached internal system reference, so it no longer replaces
  the hospital's last conversational turn or prompts the advocate to discuss internal notes.
- Persist human-mode transcript lines with a five-minute per-case random session capability, consent
  checks, input bounds, duplicate suppression and a 240-line limit. English saves immediately;
  translations update the case without duplicating BNB transcript-log entries.
- Make the AI-hospital bridge select the same Haiku browser advocate when configured; the hospital
  receives its own persona and does not receive advocate-only custom metadata.
- Persist `voiceSimulation` and expose it in the room and text/spoken outcome summary.
- Provision only the supporting agents with `setup-elevenlabs.ts --supporting`, leaving Haiku alone.
  Supporting agents use signed sessions and disable voice recording.
- Tighten delivery: one conversational step, one question, identifiers only when needed; keep v4
  pauses sparse. Distinguish suspected bill errors from verified corrections and avoid invented
  signed-authorization claims.

This is a cross-stream integration PR: minimal edits to `web/`, shared `types.ts`, outcome summaries
and their tests are included for D to review alongside the A-owned voice code. No wallet, payment,
Fly workflow, package, lockfile or shared LLM-helper changes are made.

## Hosted verification before this PR is merged

The actual judge frontend created a synthetic case through Vercel -> Fly in 26.8 seconds, preserving
17 lines and the $14,296 balance. With the local gateway and tunnel stopped, the same synthetic audio
test recognized the hospital input, received a Haiku reply and 965,846 PCM bytes from ElevenLabs;
first reply audio arrived 934 ms after input ended. This proves the hosted voice transport, not the
new transcript endpoint: the smoke test correctly exited nonzero with `saved:0` because the deployed
main still lacked this PR's transcript route. Rerun after the reviewed merge; do not count that partial
run as a complete hosted pass. PR CI (server, ownership, secret scan and Vercel preview) passed.

## Full-pipeline findings

A real four-minute AI-versus-AI run reached the conversation and exchanged bilingual turns, but ended
without a deal. No settlement was claimed. Use the chosen teammate-led mode for the stage demo; the
automated hospital backup still needs concession/turn-taking tuning. The run exposed the internal
case-note response issue fixed by the uncached system-reference change above.

The same run reported a concrete integration bug: `routes/markets.ts` chooses a research target of
zero, then treats it as a missing balance. A zero target is valid when research recommends applying
for full assistance; financing should be skipped or handle it explicitly. This is left for the
research/product owner rather than silently substituting a different debt amount. BNB mandate and
XRPL credential steps reported missing local wallet configuration, and later payment steps were
not reached. These are not claimed as passed.

## Remaining end-to-end checks

- Hosted secrets + CI rollout + ElevenLabs endpoint cutover, then microphone permission, interruption,
  audible clarity and live transcript on the actual judge frontend.
- A complete negotiation and its tool-recorded outcome (the one-turn smoke intentionally declines tools).
- Testnet escrow, hospital portal confirmation, fund loan, BNB receipts and Gemini with the founder's
  configured services. Local testing deliberately has no wallet keys and cannot prove settlement.
- Research is much slower than a spoken turn. Preload a researched synthetic case for the short stage
  demonstration while leaving the real intake/research path available for judges.
- Keep simulated agreements distinct from real hospital acceptance. A local/hosted health response
  proves configuration or reachability, not a complete call or successful transaction.
