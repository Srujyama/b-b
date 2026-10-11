# Haiku-to-Haiku voice demo

Prepared October 11, 2026, on top of main `334fd85`. The user selected an AI hospital
counterparty instead of a teammate at the microphone. This replaces the earlier human-first
demo preference; live conversations and ledger tests remain paused until requested.

## What runs

The existing server audio bridge opens two private ElevenLabs sessions. Each agent's PCM
speech is paced into the other's microphone input. Both voices and transcript lines reach
the existing negotiation room. No telephone number, Twilio transport or local tunnel is needed.

| Seat | Brain | Speech | Case access |
| --- | --- | --- | --- |
| Patient advocate | Haiku 5.5 | Eleven v4 Turbo, Bella | Existing shared case facts, private patient limit and advocate tools |
| Hospital billing demo | Haiku 5.5 | Eleven v4 Turbo, Eric | Bill and hospital policy; no private advocate facts, strategy or limit |

Both brains use the server's existing `ANTHROPIC_API_KEY`. They have distinct conversations and
system instructions; sharing an account credential does not share hidden state between agents.
The hospital answers first, requests specific evidence, applies its policy and states revised
amounts. No price or successful deal is scripted. It waits for the advocate's confirmation
before hanging up. All results remain labelled simulations.

## Implementation and boundaries

- `hospital-demo.ts` builds the separate provider agent, per-case hospital prompt and Eric voice.
  The gateway re-reads only the hospital's view each turn. It does not call `browserDemoMemory`.
- `/api/voice/hospital/llm/v1/chat/completions` streams native Anthropic responses through the
  existing SSE adapter. It requires `VOICE_LLM_TOKEN` and `elevenlabs_extra_body.hospital_case_id`.
  Browser/phone metadata, clinic cases and non-call-control tools are rejected.
- `bridge.ts` selects the new hospital ID when configured. Advocate metadata remains
  `browser_case_id`; hospital metadata is separate. Only the advocate leg can invoke case tools,
  even if a counterparty attempts to send a client-tool event.
- The legacy hospital and clinic-insurer paths remain available when the new ID is absent.
  The existing live-text fallback remains intact if voice fails. A text fallback is not proof of
  successful ElevenLabs audio and currently uses the app's separate text-model configuration.
- Existing `counterparty:"agent"` mode already opens the AI-to-AI room; no UI edit is required.

## Provisioning and deployment

The separate **Vellum Haiku Hospital Demo** agent has been created in the same ElevenLabs
account as the existing Haiku advocate. Read-back verified both agents' Haiku 5.5 models,
v4 Turbo speech, separate Bella/Eric voices, private signed-session configuration and disabled
voice recording. No conversation, speech generation or ledger transaction was started.

1. Founder: review and merge this branch through the existing main CI/Fly deployment workflow.
   The new hospital endpoint must deploy before selecting its agent in production.
2. Import the privately transferred `vellum-agent-to-agent.fly.env` on `vellum-app`. The file
   contains ten voice wiring values, including the new `ELEVENLABS_HAIKU_HOSPITAL_AGENT_ID`.
   It contains no provider API keys, wallet keys or deploy credentials, but does contain the
   gateway bearer token, so keep it out of Git and public artifacts.

   ```sh
   fly secrets import --app vellum-app < /absolute/path/vellum-agent-to-agent.fly.env
   ```

   This leaves the existing legacy advocate/hospital/intake IDs and provider keys untouched.
   Apply the separate replacement-provider-key file if that has not already been imported.
   A path on Brighton's Mac does not transfer a file to the founder's machine; send the actual
   private file. Do not import an older full settings file over replacement provider keys.
3. New deployment variable for D: `ELEVENLABS_HAIKU_HOSPITAL_AGENT_ID`. Add it to the shared
   environment template and any GitHub-to-Fly secret synchronization allowlist being introduced.
   `ELEVENLABS_HOSPITAL_VOICE_ID` is an optional existing voice override; default Eric is distinct
   from the advocate's Bella. The shared `VOICE_LLM_MODEL` remains `claude-haiku-5-5`.
4. If re-provisioning is needed, from `vellum/server` with the private configuration loaded:

   ```sh
   npm run setup:agents -- --hospital --dry-run
   npm run setup:agents -- --hospital
   ```

   `--hospital` only creates/updates the dedicated Haiku hospital, not the legacy hospital or
   intake agents. Save the printed ID in the private environment; the script does not edit it.
   It reuses `ELEVENLABS_LLM_SECRET_ID` or creates that workspace secret if absent. No conversation
   is started by either command. Reusing the resulting IDs makes later provisioning idempotent.

## Verification and next rehearsal

TypeScript and all 24 test files pass: **528 passed, two inherited expected failures**.
Coverage includes two-agent selection, separate metadata and voices, bidirectional PCM relay,
private-case isolation, fresh hospital context, revoked consent, role/tool rejection and the
new endpoint's no-key response. The route inventory audit adds one shared test probe for D review.

The provider configuration is verified; a complete live Haiku-to-Haiku conversation has **not**
been tested. After the user resumes, use a consenting synthetic patient case in agent mode and
verify `channel:"voice"`, audible alternating turns, both saved transcript roles and an outcome
recorded by the advocate's tools. Confirm that a fallback is visibly reported as text. Stop
after the negotiation unless the user also resumes the separately approved devnet sequence.

Provider contract references: [custom LLM](https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm)
and [conversation personalization](https://elevenlabs.io/docs/eleven-agents/customization/personalization).
