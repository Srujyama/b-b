# Haiku-to-Haiku voice demo

Prepared October 11, 2026; integrated with main `82cc0aa`, Branch C PR #32 and the
completed message-first UI in PR #40. Merge commit `9cef13b` retains PR #42's combined
research/voice history and UI commit `92c2ab6`. The user selected an AI hospital
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
- In the research step, select the AI hospital and explicitly check **Voice (ElevenLabs)**
  before starting the call. This sends `counterparty:"agent"` and opens the AI-to-AI room.
  Leaving voice unchecked sends `counterparty:"text"`; the pipeline also uses live text.
  The workspace's timeline and activity panel show the actual negotiated channel.

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
3. New deployment variable for D: `ELEVENLABS_HAIKU_HOSPITAL_AGENT_ID`. Its empty placeholder
   is in the shared environment template; the actual value must be imported privately on Fly.
   Closed PR #39's deployment-time secret synchronization is intentionally excluded from the
   fusion because it could overwrite the configured live provider keys.
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

The combined UI/research/voice tree passes TypeScript and all 25 test files: **544 test
cases accepted, including two inherited expected-failure cases**. Browser JavaScript syntax
checks pass; the UI session also checked desktop and mobile flows with fixtures.
Coverage includes two-agent selection, separate metadata and voices, bidirectional PCM relay,
private-case isolation, fresh hospital context, revoked consent, role/tool rejection and the
new endpoint's no-key response. The route inventory audit adds one shared test probe for D review.

The provider configuration is verified; a complete live Haiku-to-Haiku conversation has **not**
been tested. After the user resumes, attach or paste a synthetic itemized bill in the new
message-first landing page, set a payment limit and consent, complete research, then enable
Voice (ElevenLabs) with the AI hospital selected. Use this consenting synthetic case and
verify `channel:"voice"`, audible alternating turns, both saved transcript roles and an outcome
recorded by the advocate's tools. Confirm that a fallback is visibly reported as text. Stop
after the negotiation unless the user also resumes the separately approved devnet sequence.

Provider contract references: [custom LLM](https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm)
and [conversation personalization](https://elevenlabs.io/docs/eleven-agents/customization/personalization).
