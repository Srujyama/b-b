# Vellum — team guide (read this first)

**What we're building:** an AI advocate that haggles medical bills for people the system talks past.
Demo: Mrs. Lin speaks only Mandarin and has a $14,296 ER bill from Stanford Health Care. Vellum explains the bill in
Chinese, catches $2,230 in billing errors, finds she qualifies for the hospital's charity care, then negotiates
**out loud in English** with the hospital's billing agent while she reads a live Chinese transcript. Settlement and
trust run on-chain. Mode 2: doctors' offices use the same agent to appeal insurance denials (medical necessity).

Targets: **Ripple · Agora AUSD · Gemini · YZi/BNB**, plus the ElevenLabs and Context.dev bonuses, plus a General track.

## Run it (5 min)

```bash
git clone https://github.com/Srujyama/vellum && cd b-b/vellum/server
npm install
cp .env.example .env          # then paste keys (ask in the team chat — NEVER commit .env)
npm test                      # unit tests, need no keys
npm run dev                   # http://localhost:8787  (web UI + API)
```

**See every screen without keys:** `DEV_PREVIEW=1 npm run dev`, then open
`http://localhost:8787/dev/preview?stage=bill|research|room|receipts` (add `&step=900` to watch the call replay live).
This is a design harness only, with data labeled PREVIEW. It's off unless that flag is set.

`GET /health` shows which integrations have keys. A route whose key is missing returns **503 "X is not configured"**.
That's expected, not a bug.

## Map: who owns what (claim a row in the team chat before you touch it)

All modules are merged on `main`. `npx vitest run` passes 210 tests in 14 files with no keys. "Mock-tested" means
the unit tests stub the outside service; it has not yet run against the real one.

| Area | Track | Files | Status | Still needed to go live |
|---|---|---|---|---|
| Shared contracts | — | `server/src/types.ts`, `store.ts`, `index.ts`, `env.ts`, `llm.ts`, `docs/API.md` | ✅ merged. **Change only after asking D.** Everything depends on them. `llm.ts` = Claude (`claude-opus-5-5`, images + PDF) | `ANTHROPIC_API_KEY` |
| Bill parse + audit | core | `src/bill/*`, `src/routes/bill.ts`, `fixtures/lin-er-bill.*` | ✅ merged. Audit is deterministic and runs with no keys; parse is mock-tested | `ANTHROPIC_API_KEY` for the Claude vision parse |
| Fair-price + charity research | Context.dev | `src/research/*`, `src/routes/research.ts` | ✅ merged, mock-tested only | `CONTEXT_DEV_API_KEY` + `ANTHROPIC_API_KEY`, then `npm run live:research` |
| Negotiation prompts + tools | ElevenLabs | `src/agent/prompts.ts`, `tools.ts`, `translate.ts` | ✅ merged, mock-tested only | ElevenLabs + Anthropic keys |
| Voice runtime + agent-vs-agent bridge | ElevenLabs | `src/agent/elevenlabs.ts`, `bridge.ts`, `src/routes/voice.ts` | ✅ merged, mock-tested only (agents' LLM is ElevenLabs-hosted, default `gpt-4o`) | `ELEVENLABS_API_KEY`, `npm run setup:agents`, a live turn-taking test |
| Outbound phone agent (stream A) | ElevenLabs | `src/agent/calls.ts`, `haiku.ts`, `call-plan.ts`, `shared-context.ts`, `voice.env.example` | ✅ merged, mock-tested only; ElevenLabs API access and one Flash TTS sample checked live (`npm run setup:agents -- --check` / `--smoke-test`), no call placed. Claude Haiku + ElevenLabs Flash + Twilio. Off by default; fails closed without `VOICE_ALLOWED_NUMBERS`. Not wired into `/run` | keys, `npm run setup:agents -- --outbound`, Twilio number imported into ElevenLabs, `VOICE_*` tokens, then a call to an allowlisted test phone |
| XRPL credentials, escrow, batch | Ripple | `src/chain/xrpl.ts`, `src/routes/xrpl.ts` | ✅ merged, **LIVE-verified on devnet** (`npm run live:xrpl`) | nothing; hospital $0 confirm is simulated in the demo by design |
| XRPL Permissioned Domain + private vault + 0% loan | Ripple | `src/chain/xrplFund.ts` | ✅ merged, **LIVE-verified**: non-credentialed deposit rejected `tecNO_AUTH` | nothing |
| BNB mandate + tamper-evident log | YZi | `contracts/AdvocateLedger.sol`, `src/chain/bnb.ts`, `src/routes/bnb.ts` | ✅ merged, mock-tested only, **not deployed** | tBNB in `BSC_PRIVATE_KEY`, then `npm run deploy:ledger` → `ADVOCATE_LEDGER_ADDRESS` |
| x402 paid APIs in AUSD | Agora | `src/chain/ausd.ts`, `x402.ts`, `src/routes/x402.ts` | ✅ merged. The EIP-712 domain was checked by hand once against the on-chain `DOMAIN_SEPARATOR` (comment in `ausd.ts`); `npm run live:ausd` has not passed. **No real payment yet** (wallets hold 0) | AUSD for the agent wallet, Base Sepolia ETH for the payee, then `npm run live:ausd` |
| Fed odds → financing advice | Gemini | `src/markets/gemini.ts`, `src/routes/markets.ts` | ✅ merged, odds **LIVE-verified** (`npm run live:gemini`); sandbox hedge mock-tested only | `GEMINI_API_KEY`/`GEMINI_API_SECRET` for the sandbox hedge |
| Clinic denial appeals | core | `src/claims/*`, `src/routes/clinic.ts`, `fixtures/denial-*.json` | ✅ merged, mock-tested only | Anthropic + Context.dev keys, then `npm run live:clinic` |
| Web UI (Mandarin-first) | all | `web/*` | ✅ merged (patient `/`, clinic `/clinic.html`); every screen renders via `/dev/preview` | a full run with keys |
| One-button pipeline + README + demo | all | `src/routes/pipeline.ts`, `README.md`, `docs/DEMO.md`, `docs/SUBMISSION.md` | ✅ merged, mock-tested only (`POST /api/cases/:id/run`, "Run everything" button) | all keys + funded wallets for one full live run |

## Unblocked work for humans right now

1. **Keys** → paste into the shared `.env` (send it privately, not in git): Anthropic (`ANTHROPIC_API_KEY`), ElevenLabs (Discord coupon),
   Context.dev, Gemini sandbox key/secret.
2. **Fund testnet wallets** (addresses: run `npm run setup:wallets` with the shared .env, which prints them):
   tBNB (BSC faucet) → `npm run deploy:ledger`; Base Sepolia ETH for the payee; AUSD faucet for the agent wallet.
   XRPL devnet funds itself: `npm run setup:xrpl`.
3. **Live-check a module** with keys: `npm run live:research`, `live:clinic`, `live:ausd` (only `live:xrpl` and
   `live:gemini` have passed so far; the AUSD EIP-712 domain was checked once by hand, but `live:ausd` has not passed). Report anything that breaks.
4. **Demo assets:** print `server/fixtures/lin-er-bill.html` and photograph it (the "Mom takes a photo" shot);
   write the 2-min video script; find a teammate to voice or play the hospital billing rep.
5. **Social proof:** the judges weigh traction. Post progress clips.
6. **Developer feedback bounties:** Ripple ($100) wants MCP/SKILL.md feedback. Note pain points as you go.

## Rules

- Every module has a `test/<module>.test.ts` that runs with **no keys**. Keep it green: `npm test` before you push.
- **No hard-coded results** (judges check). Seed data such as the sample bill is fine and labeled.
- Missing config must fail loudly (`need("KEY")` in `src/env.ts`). Never fake success.
- Testnets only. Never commit `.env` or private keys (the repo is **public**).
- Small PRs or pushes per module. Pull often: Claude agents are pushing modules as they finish.
- The build plan/state is `THINKPAD.md` at the repo root (managed by Claude; read it, don't hand-edit task lines).

## Deploy (live link for the submission)

`vellum/Dockerfile` + `vellum/render.yaml`. On Render: **New → Blueprint → this repo**, then paste the keys from
the shared `.env` into the service's Environment tab (never into git). Any Docker host works:
`docker build -t vellum vellum && docker run -p 8787:8787 --env-file vellum/server/.env vellum`.
Single instance only: cases and escrow fulfillments live in memory.
