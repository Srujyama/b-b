# Hosted release and demo verification — 2026-10-11

Release: `00feb462136ca85326a59bf253d87fc0976416ac`, merged PR #28.
Result: **partial pass; a fresh end-to-end voice demo is blocked.** Do not present the API-only
rehearsal below as a completed AI negotiation.

**Current instruction: demo testing is paused while the team restores provider credits.** Do not
run paid research/audio requests or the ledger rehearsal until the user resumes the demo. The
devnet sequence below has been explicitly approved, but that approval does not undo the pause.

## Code and deployment

- Fetched latest main, including LemonLover101's PR #7 design and its live dashboard port (#13).
- Integrated the newer English paper-trail UI (#33), error handling audit (#31), negotiation
  engine (#29), clinic policy logic (#30), and Context.dev backoff (#27).
- Resolved the UI conflicts while preserving transcript persistence and simulation labels.
- TypeScript passed. Full tests: 481 passed, with two inherited expected failures concerning
  malformed bill JSON and multipart error responses. Added transcript-route audit coverage.
- Secret scanning passed after changing an inherited fake bearer-token test fixture to generate
  its dummy value at runtime. No real credential was committed.
- Fly's main CI, deployment, and health check succeeded:
  https://github.com/Srujyama/vellum/actions/runs/38180862108
- Fly's served `app.js` matches this release byte-for-byte. Its frontend is usable at
  https://vellum-app.fly.dev . An earlier researched case survived the deployment/restart.
- Vercel production deployment `77MUduJEp9nscTAVzyeFdQEfQGch` now reports success. The founder
  identified an unrelated hung preview as the earlier queue blocker. No preview was cancelled
  by this session. The queue has since cleared.
- Both public hosts now serve `app.js`, `dashboard.js`, `index.html`, and `dashboard.html`
  byte-for-byte matching release `00feb46`. The latest UI and backend are deployed together.

## Fresh patient UI and API checks

Synthetic case: `b3515157-34e9-4e65-9fd8-8529c1413d8d`.

1. Clicked **Try the demo bill** in the public browser UI. Real parsing returned 17 lines,
   a $14,296 balance, and four audit flags. Flags are leads, not verified billing errors.
2. Saved the prefilled synthetic intake through the form: household 3, income $41,000,
   maximum $2,500, consent true. The case persisted those values.
3. Clicked **Start checking**. All research lookups failed because Context.dev returned
   `401 USAGE_EXCEEDED`, explicitly stating **0 credits remain**. This fresh case has no
   completed research; it must not be advertised as a fresh complete pipeline pass.
4. Performed a separate, explicitly labelled API integration rehearsal on the same case:
   created a simulated browser session, posted two transcript lines, retried each line,
   and verified there were exactly two saved records rather than duplicates.
5. The records' text explicitly says **Automated API test, not a recorded voice call**.
   Both Chinese translations subsequently persisted. The new #33 UI displays English only;
   translated text remains in the stored case, not in the current dashboard transcript.
6. Logged a synthetic $3,000 offer. `accept_offer` refused it and left the agreed amount unset.
   Logged $2,000, accepted it, and recorded the simulated outcome successfully.
7. Financing analysis at that agreed balance returned 200 using the public Gemini/FRED feeds.
   The zero-target pre-negotiation bug still exists (`if (!balance)` in `routes/markets.ts`).
8. The outcome summary returned `simulated:true`. The released Fly UI visibly shows the
   simulation label; the dashboard renders the bill, limit, test offer, and saved transcript.
9. Malformed transcript requests return 400; requests without a session capability return 401.
   Mandarin intake signed-session provisioning returns 200. This does not prove microphone
   capture, Mandarin conversation, or successful intake tool use through the voice model.

## Live voice blockers found after deployment

- The locally configured ElevenLabs key returned `401 quota_exceeded`, explicitly reporting
  **0 remaining credits**. Synthetic audio generation stopped before a conversation started.
- Hosted `GET /api/cases/:id/summary.mp3` returned 502 with an upstream ElevenLabs HTTP 401.
  That endpoint hides the provider's detailed reason, so verify whether Fly has the same key
  or a different invalid/exhausted one before replacing credentials.
- The hosted Haiku endpoint returned 503: **VOICE_LLM_TOKEN is not configured**.
- Hosted human-session initialization has no `custom_llm_extra_body.browser_case_id` and
  selects a different agent from the provisioned Haiku browser agent. This indicates the
  `ELEVENLABS_BROWSER_AGENT_ID` setting is absent and the legacy advocate fallback is active.
- `/health` only reports provider-key presence. Its `anthropic:true` and `elevenlabs:true`
  are not proof of available quota, working Haiku gateway authentication, or agent selection.

The earlier successful 0.934-second hosted audio sample predates these checks; it is not a
successful voice test of this release/configuration. No fresh voice success is claimed here.

## Ledger boundary

The public fund read succeeds and identifies `wss://s.devnet.rippletest.net:51233`.
No ledger write was performed at this checkpoint. The prepared separate test would issue/replace
the demo hardship credential, escrow 2,000 test USD, verify the escrow on-ledger, and simulate
hospital confirmation to release it with the configured advocate fee (default 1%, capped at 10%).
Automatic approval review required explicit authorization for that irreversible testnet sequence.
The user has now approved it, including 2,000 test USD principal and the configured advocate fee
(default 20, maximum 200 test USD). Execution remains paused with the rest of the demo. No real-money
or mainnet action is part of the test.

BNB is still unconfigured according to hosted health, so a BNB mandate/receipt is not a passed
demo feature. `geminiTrading:false` does not prevent the public market/financing analysis above;
it means the optional sandbox hedge is unavailable. AUSD payment was not exercised in this run.

## Remaining integration and release handoff

1. The founder/team is restoring Context.dev credits and a working ElevenLabs quota/key. These
   replacements are separate from the voice wiring import; do not re-import the older full AI
   settings file and accidentally restore an exhausted key.
2. Founder: import the separately transferred private `vellum-voice-wiring.fly.env` into
   `vellum-app`. The file contains only the gateway token, existing ElevenLabs secret/agent
   references, models, voice preset and public URL settings. It excludes provider API keys,
   deployment credentials and wallet keys. Never put the file in Git or a public artifact.
   The file is on the user's Mac, not the founder's machine. The user must send the actual file
   privately; copying its `/private/tmp` pathname into another session does not transfer it.
   It does not contain or overwrite any of the five existing ElevenLabs variables the founder
   listed: `ELEVENLABS_API_KEY`, `ELEVENLABS_ADVOCATE_AGENT_ID`, `ELEVENLABS_HOSPITAL_AGENT_ID`,
   `ELEVENLABS_INTAKE_AGENT_ID`, or `ELEVENLABS_INTAKE_VOICE_ID`.
   If changing ElevenLabs accounts, reprovision the browser agent and workspace secret in the
   new account rather than assuming the old IDs are valid there. See `HOSTED_DEMO.md` for the
   exact nine-variable import and account-migration procedure.
3. Once the user resumes the demo, verify the protected Haiku endpoint works and session
   initialization includes case metadata. Then run the real audio smoke test in
   `live-rehearsal.ts` and a full negotiation.
4. No Vercel queue action remains necessary: both sites now serve the approved release. The
   voice/configuration blockers apply to both sites because they share the same Fly backend.
5. Run the approved testnet sequence, if desired, and inspect real explorer receipts.
6. Run the human microphone rehearsal afterward, as requested by the user. Interruption, audible
   quality, and full voice-intake behavior remain unverified.

The previously researched synthetic case `fb4009a3-84cd-40ee-a343-987c3069355a` remains available
for a preloaded rehearsal; it has sourced research from the earlier successful run and no agreed
amount. Reusing it does not validate fresh research while Context.dev credits are exhausted.
