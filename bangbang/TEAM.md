# BangBang 帮帮 — team guide (read this first)

**What we're building:** an AI advocate that haggles medical bills for people the system talks past.
Demo: Mrs. Lin speaks only Mandarin and has a $14,296 ER bill from Stanford Health Care. BangBang explains the bill in
Chinese, catches $2,230 in billing errors, finds she qualifies for the hospital's charity care, then negotiates
**out loud in English** with the hospital's billing agent while she reads a live Chinese transcript. Settlement and
trust run on-chain. Mode 2: doctors' offices use the same agent to appeal insurance denials (medical necessity).

Targets: **Ripple · Agora AUSD · Gemini · YZi/BNB**, plus the ElevenLabs and Context.dev bonuses, plus a General track.

## Run it (5 min)

```bash
git clone https://github.com/Srujyama/b-b && cd b-b/bangbang/server
npm install
cp .env.example .env          # then paste keys (ask in the team chat — NEVER commit .env)
npm test                      # unit tests, need no keys
npm run dev                   # http://localhost:8787  (web UI + API)
```

`GET /health` shows which integrations have keys. A route whose key is missing returns **503 "X is not configured"**.
That's expected, not a bug.

## Map: who owns what (claim a row in the team chat before you touch it)

| Area | Track | Files | Status |
|---|---|---|---|
| Shared contracts | — | `server/src/types.ts`, `store.ts`, `index.ts`, `docs/API.md` | ✅ **Change only after asking the team.** Everything depends on them |
| Bill parse + audit | core | `src/bill/*`, `src/routes/bill.ts`, `fixtures/lin-er-bill.*` | ✅ done |
| Fair-price + charity research | Context.dev | `src/research/*`, `src/routes/research.ts` | ✅ done, needs a live run with the key |
| Negotiation prompts + tools | ElevenLabs | `src/agent/prompts.ts`, `tools.ts`, `translate.ts` | ✅ done |
| Voice runtime + agent-vs-agent bridge | ElevenLabs | `src/agent/elevenlabs.ts`, `bridge.ts`, `src/routes/voice.ts` | ✅ done, needs key + `npm run setup:agents` + live turn-taking test |
| XRPL credentials, escrow, batch, vault, loan | Ripple | `src/chain/xrpl*.ts`, `src/routes/xrpl.ts` | ✅ done, LIVE-verified on devnet (`npm run live:xrpl`) |
| BNB mandate + tamper-evident log | YZi | `contracts/AdvocateLedger.sol`, `src/chain/bnb.ts`, `src/routes/bnb.ts` | ✅ done, needs tBNB + deploy |
| x402 paid APIs in AUSD | Agora | `src/chain/ausd.ts`, `x402.ts`, `src/routes/x402.ts` | ✅ done, needs faucet funds |
| Fed odds → financing advice | Gemini | `src/markets/gemini.ts`, `src/routes/markets.ts` | ✅ done (live-verified); sandbox hedge needs keys |
| Clinic denial appeals | core | `src/claims/*`, `src/routes/clinic.ts` | ✅ done |
| Web UI (Mandarin-first) | all | `web/*` | ✅ done (patient `/`, clinic `/clinic.html`) |
| One-button pipeline + README + demo | all | `src/routes/pipeline.ts`, `README.md`, `docs/DEMO.md` | ✅ done (`POST /api/cases/:id/run`, "Run everything" button); needs a full live run with all keys |

🚧 = a Claude agent is editing these files **right now**. Don't edit them until the row turns ✅ (pull first).

## Unblocked work for humans right now

1. **Keys** → paste into the shared `.env` (send it privately, not in git): OpenAI, ElevenLabs (Discord coupon),
   Context.dev, Gemini sandbox key/secret.
2. **Fund testnet wallets** (addresses: run `npm run setup:wallets` with the shared .env, which prints them):
   tBNB (BSC faucet) → `npm run deploy:ledger`; Base Sepolia ETH for the payee; AUSD faucet for the agent wallet.
   XRPL devnet funds itself: `npm run setup:xrpl`.
3. **Live-check a module** with keys: `npm run live:research`, `live:clinic`, `live:ausd`, `live:xrpl`, `live:gemini`.
   Report anything that breaks.
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
