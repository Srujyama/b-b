# Hosted judge demo: Vellum integration handoff

**New demo direction:** the user now wants Haiku-to-Haiku agent audio. Read
[AGENT_DEMO.md](./AGENT_DEMO.md) for the separate hospital agent, deployment setting and validation.
The checkpoint below records the previous release; it does not imply that the new hospital
endpoint is already deployed or that a live two-agent rehearsal has passed.

Prepared 2026-10-11. The founder owns deployment and wallet secrets. Voice implementation PR #28 is
reviewed and merged into `main`; GitHub runs TypeScript + tests before deploying Fly. No personal or app deploy token is
needed by Branch A. Do not deploy this feature branch directly.

**Current checkpoint: [E2E_RESULTS.md](./E2E_RESULTS.md).** PR #28 is merged as `00feb46`;
Fly and Vercel both serve that release. Demo execution is paused at the user's request while
provider credits are restored. Historical live results below predate the current configuration
blockers and must not be represented as a fresh end-to-end pass.

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

Both public hosts now serve the merged UI and use the same deployed Fly backend. The temporary
tunnel is stopped. Fly's `/health` reports AI key presence, but fresh checks found exhausted
Context.dev credits, an ElevenLabs 401, and missing Haiku gateway/browser-agent configuration.
The provisioned Haiku agent targets Fly; the app still selects the legacy advocate fallback until
the missing settings are imported. Key presence is not evidence of quota or complete voice wiring.

## Founder: finish the missing voice wiring

The founder confirmed that `ELEVENLABS_API_KEY`, `ELEVENLABS_ADVOCATE_AGENT_ID`,
`ELEVENLABS_HOSPITAL_AGENT_ID`, `ELEVENLABS_INTAKE_AGENT_ID`, and `ELEVENLABS_INTAKE_VOICE_ID`
already exist on Fly. Leave those values untouched by this import. Restore provider credits or
update provider keys separately; do not import the older full `vellum-voice.fly.env` file.

The private **`vellum-voice-wiring.fly.env`** contains exactly the nine variables below. It has
no provider API keys, wallet keys, or deploy credentials. It does contain the gateway bearer
token: transfer the actual file privately, never through Git, `web/`, or a PR. A `/private/tmp`
path belongs only to the machine that created it and is not a transfer mechanism. A private
transfer bundle is available on the user's Mac under the ignored `server/.data/voice-handoff/`.

| Variable | Purpose |
| --- | --- |
| `VOICE_LLM_TOKEN` | Gateway bearer token; must match the ElevenLabs workspace secret |
| `ELEVENLABS_LLM_SECRET_ID` | Existing ElevenLabs secret reference used for agent provisioning |
| `ELEVENLABS_BROWSER_AGENT_ID` | Haiku / v4 Turbo advocate |
| `VOICE_LLM_MODEL` | `claude-haiku-5-5` |
| `VOICE_TTS_MODEL` | `eleven_v4_turbo` (alternatives: `eleven_v4`, `eleven_flash_v2_5`) |
| `VOICE_VOICE_PRESET` | `bella` (alternatives: `river`, `eric`) |
| `VOICE_CALLS_ENABLED` | `false` — no real phone calls |
| `PUBLIC_URL` | `https://vellum-app.fly.dev` |
| `PUBLIC_WS_ORIGIN` | `wss://vellum-app.fly.dev` |

1. Release `00feb46` is already deployed to both Fly and Vercel. No separate feature-branch deploy
   or personal Fly token is needed. The founder retains deployment and wallet access.
2. Confirm the ElevenLabs account is unchanged before using the existing agent/secret references.
   From the founder's authenticated Fly session, import the privately received file:

   ```sh
   fly secrets import --app vellum-app < /absolute/path/vellum-voice-wiring.fly.env
   ```

   This changes only those nine values and restarts the app. None overlaps the five ElevenLabs
   settings above. It does not remove existing wallet secrets. Inspect variable names before import;
   do not post the values to an issue, log, or screenshot.
3. **Stop every local `demo-tunnel.ts` launcher first.** It updates this same ElevenLabs agent when a
   temporary hostname rotates and would otherwise overwrite the hosted endpoint.
4. The existing browser agent already points at Fly. If re-provisioning is needed, use a private
   local provisioning environment containing a valid `ELEVENLABS_API_KEY` plus the wiring values.
   The wiring-only import file intentionally lacks the API key and cannot provision by itself.
   From `vellum/server` on the reviewed commit:

   ```sh
   DOTENV_CONFIG_PATH=/absolute/path/private-provisioning.env node --import tsx scripts/setup-elevenlabs.ts --browser
   ```

   The provider's custom LLM URL must be `https://vellum-app.fly.dev/api/voice/browser/llm/v1`.
   ElevenLabs appends `/chat/completions`. Including that suffix in the configured base caused the live
   404 failure found and fixed during this integration. Our HTTP route still includes the full suffix.
   If the ElevenLabs account changes, remove the old `ELEVENLABS_LLM_SECRET_ID` and
   `ELEVENLABS_BROWSER_AGENT_ID` from that private provisioning environment before running the
   command. It creates a workspace secret and agent in the new account and prints new references.
   Save those references even if a later step fails. Import the resulting gateway token and new
   IDs into Fly together. Existing intake/hospital/voice IDs also need review for the new account;
   do not assume references from the old account will work.
5. Leave live testing paused until the user resumes. Then verify gateway authentication and that
   human-session initialization includes `custom_llm_extra_body.browser_case_id`, followed by the
   hosted smoke test and actual microphone rehearsal. `/health` alone is insufficient. Keep this
   Mac's server/tunnel off so the judge path is independent of the development machine.

No phone agent/number, `VOICE_ORCHESTRATOR_TOKEN`, or phone journal directory is required for the
browser demo. Retained real-phone routes stay disabled and separate from the shared CasePacket path.
The original approved ElevenLabs key expires October 18; a replacement key has its own expiry.

## Reproducible checks (live command waits for the demo to resume)

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

Historical live results on this Mac, October 11, before the current blockers:

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

## Implementation shipped in PR #28

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

PR #28 included cross-stream integration edits to `web/`, shared `types.ts`, outcome summaries
and their tests alongside the A-owned voice code. The current handoff follow-up changes only
Branch A documentation; it does not modify runtime behavior or deployment configuration.

## Historical hosted verification before PR #28 merged

The actual judge frontend created a synthetic case through Vercel -> Fly in 26.8 seconds, preserving
17 lines and the $14,296 balance. With the local gateway and tunnel stopped, the same synthetic audio
test recognized the hospital input, received a Haiku reply and 965,846 PCM bytes from ElevenLabs;
first reply audio arrived 934 ms after input ended. This proves the hosted voice transport, not the
new transcript endpoint: the smoke test correctly exited nonzero with `saved:0` because the deployed
main still lacked PR #28's transcript route. Do not count that partial run as a complete hosted pass.
PR CI (server, ownership, secret scan and Vercel preview) passed. Post-merge transcript checks and
the remaining live-voice blockers are recorded in `E2E_RESULTS.md`.

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

- Missing hosted voice settings + funded provider keys, then microphone permission, interruption,
  audible clarity and live transcript on the actual judge frontend.
- A complete negotiation and its tool-recorded outcome (the one-turn smoke intentionally declines tools).
- Testnet escrow, hospital portal confirmation, fund loan, BNB receipts and Gemini with the founder's
  configured services. Local testing deliberately has no wallet keys and cannot prove settlement.
- Research is much slower than a spoken turn. Preload a researched synthetic case for the short stage
  demonstration while leaving the real intake/research path available for judges.
- Keep simulated agreements distinct from real hospital acceptance. A local/hosted health response
  proves configuration or reachability, not a complete call or successful transaction.
