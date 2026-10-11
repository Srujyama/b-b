# Work plan: 3 people in parallel, merge-friendly

The code is built: 11 modules, 170+ tests, all green. What's left is **making each part real with live keys,
tuning it, and producing the demo**. The work is split so that **no two people own the same file**. Then merges
are just "click merge".

## The split

| | **A: Voice & Story** | **B: Money Rails** | **C: Research & Intelligence** |
|---|---|---|---|
| Tracks | ElevenLabs bonus, Most Creative | **Ripple**, **Agora AUSD**, **YZi/BNB** | **Gemini**, Context.dev bonus |
| Branch | `feat/voice` | `feat/rails` | `feat/research` |
| Owns (only you edit) | `server/src/agent/**`, `server/src/routes/voice.ts`, `server/scripts/setup-elevenlabs.ts`, `server/test/agent.test.ts`, `server/test/voice.test.ts`, `docs/DEMO.md` | `contracts/**`, `server/src/chain/**`, `server/src/routes/{xrpl,bnb,x402}.ts`, `server/scripts/{setup-xrpl,deploy-ledger,gen-wallets,live-xrpl,live-ausd}.ts`, `server/test/{xrpl,bnb,ausd}.test.ts` | `server/src/{research,markets,bill,claims}/**`, `server/src/routes/{research,markets,bill,clinic}.ts`, `server/fixtures/**`, `server/scripts/live-{research,gemini,clinic}.ts`, `server/test/{research,gemini,bill,clinic}.test.ts` |

**Integrator** (Srujan + Claude) owns the shared files: `server/src/{types,store,index,env,llm}.ts`,
`server/src/routes/pipeline.ts`, `docs/API.md`, `web/**`, `README.md`, `TEAM.md`, `package.json` + lockfile,
`.env.example`, `.github/`.

> Need a change in a file you don't own? Don't edit it. Post in the team chat ("B needs `Receipt.detail.amount`")
> and the owner makes it. This one rule is what keeps merges painless.

## Git workflow (copy-paste)

```bash
git clone https://github.com/Srujyama/b-b && cd b-b
git checkout -b feat/voice            # your branch: feat/voice | feat/rails | feat/research
cd bangbang/server && npm install && cp <shared .env from chat> .env

# work loop: commit small, sync often
git add <your files> && git commit -m "voice: tune hospital persona concessions"
git fetch origin && git rebase origin/main     # at least every hour; conflicts stay tiny
npm test && npx tsc --noEmit                   # CI runs the same; keep it green
git push -u origin feat/voice                  # push the branch, open a PR into main
```

- **Open a PR early** (draft is fine) and **merge to `main` at least every ~2 hours**: small PRs, no big-bang merge at the end.
  CI (`.github/workflows/ci.yml`) runs tsc + all tests on every PR. Merge only on green.
- **Squash-merge** your PR, then `git fetch && git rebase origin/main` and keep going on the same branch.
- **Never** `git push --force` to `main`, and never commit `.env` (the repo is public).
- **Dependencies:** don't `npm install <pkg>` on your branch. Ask the integrator, who adds it on `main` once.
  Two branches both touching `package-lock.json` is the #1 merge-conflict source.
- **New env var?** Tell the integrator, who adds it to `.env.example`. Read it in code with `need("X")`/`opt("X")`.
- **Shared .env:** keys go in the team chat, not git. When you add a value (e.g. a deployed contract address),
  post it so everyone updates their local `.env`.

## A: Voice & Story (ElevenLabs)

The demo moment lives here: two AI agents arguing out loud while Mrs. Lin reads Chinese.
1. Put `ELEVENLABS_API_KEY` in `.env` → `npm run setup:agents` → paste the 3 agent IDs into the shared .env.
2. Pick a **native Mandarin voice** for intake (Voice Library) → `ELEVENLABS_INTAKE_VOICE_ID`. Test intake in the
   browser (`npm run dev` → `/` → talk in Chinese). Done when `submit_intake` fills the case.
3. **Live-test the agent-vs-agent bridge** (`POST /api/cases/:id/negotiate {counterparty:"agent"}` from the UI).
   Tune turn-taking in `bridge.ts` (silence padding, interruption) until the conversation flows naturally.
4. Tune `prompts.ts` so the hospital rep resists believably and concedes **only** to real facts (duplicate charge,
   charity-care eligibility). The negotiation must not be scripted, because judges check. Run it 3+ times and log the outcomes.
5. Human mode: a teammate plays the billing rep from a second laptop (`counterparty:"human"`). Good backup for the live demo.
6. Own `docs/DEMO.md` + **record the 2-min video** (YouTube) at the end. Post clips for social proof.

## B: Money Rails (Ripple, Agora AUSD, YZi/BNB). Three sponsor tracks, so this is the biggest prize surface

1. **XRPL** (already live on devnet): `npm run setup:xrpl`, `npm run live:xrpl`. Then: try RLUSD on **testnet** for
   the escrow if the faucet works (judges like RLUSD), add Permissioned Domain gating if time allows. Write the
   **Ripple developer-feedback** form ($100 bounty) as you go.
2. **BNB / YZi**: fund `BSC_PRIVATE_KEY` with tBNB → `npm run deploy:ledger` → post `ADVOCATE_LEDGER_ADDRESS`.
   Verify `/api/cases/:id/mandate` and `/ledger` on bscscan. Stretch: verify the contract source on bscscan.
3. **AUSD / x402**: fund the agent wallet with AUSD (Agora faucet) and the payee with Base Sepolia ETH →
   `npm run live:ausd -- --fair-price 99285`. Done when a basescan link shows a gasless ERC-3009 transfer.
   Stretch: try the public x402 facilitator in addition to our self-settle.
4. Write the per-track paragraph for README (send it to the integrator): what's on-chain, which tx proves it.

## C: Research & Intelligence (Context.dev, Gemini, bill, clinic)

1. `CONTEXT_DEV_API_KEY` + `OPENAI_API_KEY` → `npm run live:research`. Make Stanford's real financial-assistance
   policy and real Medicare rates come back **with source URLs**. Tune queries/extraction where they miss.
2. `npm run live:clinic`: make the Aetna lumbar-MRI policy criteria come back for real, and check the appeal letter reads like a real one.
3. **Bill photo**: photograph the printed `fixtures/lin-er-bill.html` with a phone and upload it in the UI. Fix parsing misses.
   (PDF upload needs a change in `llm.ts`. Ask the integrator.)
4. **Gemini**: create a sandbox account + API key → test `POST /api/cases/:id/hedge`. If FED events don't exist
   in sandbox, find another honest hedge market and document it. `npm run live:gemini` must stay green.
5. Verify the hard-coded constants against real sources (e.g. `ED_LEVEL4_OVER_LEVEL5` in `bill/audit.ts`, the FPL table).

## Integrator (Srujan + Claude)

One-button pipeline (`/api/cases/:id/run`), web polish, README track mapping, merging PRs, shared-file requests,
deployment link (recommended for submission), and the final submission form (YouTube ≤ 2 min, public repo, live link).

## Checkpoints

| When | Everyone has... |
|---|---|
| +1h | their keys in, their module's `live:*` script green, first PR merged |
| +3h | their live flow working from the web UI end to end |
| Feature freeze (≈3h before deadline) | merged to `main`; only bug fixes after this |
| ≈1.5h before deadline | full demo run-through ×2 on `main`, then record the video |
