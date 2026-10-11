# BangBang 帮帮

**An AI advocate for people the US medical-billing system talks past.** It reads a hospital bill, explains it in
the patient's language, finds the errors, researches what the care should cost, then negotiates with the billing
office *in English, out loud* while the patient follows a live translation. The deal settles through an XRPL
escrow that is released only on a $0-balance confirmation from the hospital. In the one-button demo that
confirmation is simulated, and the log says so (see [What's live vs. mocked](#whats-live-vs-mocked)).

帮帮 (bāngbāng) means "help". Mode 2 uses the same agent for doctors' offices: it appeals insurance denials on
medical necessity and argues the appeal with the insurer's agent.

Every server-side Claude call (bill parsing, Chinese explanations, call translation, research extraction, appeals)
goes through one helper, [`server/src/llm.ts`](server/src/llm.ts) (`@anthropic-ai/sdk`, default model
`claude-opus-5-5`, overridable with `ANTHROPIC_MODEL`). The phone agent streams Claude Haiku from its own endpoint
([`server/src/agent/haiku.ts`](server/src/agent/haiku.ts)). The ElevenLabs conversational agents use the LLM
ElevenLabs hosts (`ELEVENLABS_LLM`, default `gpt-4o`).

## The problem

US hospitals bill uninsured patients list prices that are often several times what Medicare or insurers pay.
Itemized bills routinely contain duplicates and upcoding. Every nonprofit hospital must publish a 501(r)
financial-assistance policy, and many patients qualify for free or discounted care without knowing it. Getting any
of that money back takes hours on the phone, in English, with someone who knows the billing codes. People who don't
speak English mostly just pay, or don't and get sent to collections.

## Mrs. Lin's story (the demo)

This is the designed flow. Today the bill audit, the XRPL settlement and fund, and the Gemini odds run live; the
voice, research, AUSD payment and BNB steps are built and unit-tested but have not yet run against the real services
(see [What's live vs. mocked](#whats-live-vs-mocked)).

Mrs. Lin speaks Mandarin and no English. Her household of 3 lives on $41,000 a year (about 150% of the federal
poverty line). After an evening in the Stanford Health Care emergency department she gets an itemized self-pay
bill for **$14,296**.

1. **She photographs the bill** (an image or a PDF). Claude reads every line and explains each charge in plain
   Chinese. A deterministic audit flags a duplicated IV push, a level-5 ER visit that fits level 4, and lab tests
   unbundled from a panel billed the same day: **$2,230.60** of likely errors.
2. **She talks to BangBang in Mandarin** (ElevenLabs voice agent). It collects her household size, income, the most
   she's willing to pay ($2,500) and her explicit consent.
3. **BangBang researches.** Using Context.dev it pulls Medicare rates and the hospital's published prices for the
   biggest codes, and finds Stanford's financial-assistance policy and its FPL thresholds. Every number must appear
   verbatim in a cited source or it's dropped. It pays for each lookup itself, **0.05 AUSD over x402**.
4. **Her mandate goes on-chain.** A BNB Chain contract records the cap and a consent hash. Every offer and every
   transcript turn of the call is hash-chained onto it, and the contract rejects a deal above her cap.
5. **The call.** BangBang's advocate agent talks to the hospital's billing agent (agent vs agent over ElevenLabs, or
   a teammate plays billing) and negotiates in English. Both voices stream to the browser and she reads a live
   Chinese transcript. A separate outbound **phone** agent (below) can place a real call, but it is off by default
   and is not part of the one-button run.
6. **Pay smart.** Gemini prediction-market odds on the next Fed decisions give the expected rate path. BangBang uses
   it to recommend a discounted lump sum or a payment plan. If a plan wins, a 0% loan comes from an XRPL community
   fund that only vetted donors can deposit into.
7. **Settle safely.** The agreed amount is locked in an XRPL token escrow with a crypto-condition. A hardship
   Credential proves her eligibility. When the hospital confirms a $0 balance, one atomic Batch releases the escrow
   and pays BangBang's small fee. (In the demo run, the hospital side of that confirmation is simulated.)

The 2-minute shot list is in [`docs/DEMO.md`](docs/DEMO.md). Ready-to-paste submission text:
[`docs/SUBMISSION.md`](docs/SUBMISSION.md).

## Architecture

```
                     browser (web/)  — Mandarin-first, plain HTML/JS
   photo/PDF ─┐      upload · bill in Chinese · voice intake · research feed · negotiation room · receipts
              ▼                    │ REST                              ▲ WS /ws?case=  (log en+zh, transcript,
   ┌──────────────────────────────────────────────────────────────┐   │  offers, receipts, PCM audio)
   │  Fastify server (server/src)                                 │───┘
   │                                                              │
   │  llm.ts  Claude helper for server-side LLM calls             │──► Anthropic (Claude)
   │  bill/  parse (Claude vision) → explain zh → deterministic audit
   │  research/  Context.dev search/scrape → fair prices,         │──► Context.dev
   │             501(r) charity policy → facts + price ladder     │
   │  routes/x402 ◄── advocate pays per call (paidFetch) ─────────│──► Base Sepolia (AUSD, EIP-3009)
   │  markets/gemini  Fed odds + FRED rate → lump sum vs plan     │──► Gemini prediction markets (public)
   │  chain/bnb  AdvocateLedger: mandate · hash-chained log · deal│──► BSC testnet
   │  agent/  prompts · tools · bridge (agent ⇄ agent audio)      │──► ElevenLabs Conversational AI
   │  agent/calls  outbound phone agent (off by default)          │──► ElevenLabs + Twilio, Claude Haiku
   │  chain/xrpl*  Credential · TokenEscrow · Batch ·             │──► XRPL devnet
   │               Permissioned Domain · private Vault · Loan     │
   │  claims/  payer policy → criteria vs chart → appeal letter   │
   │  routes/pipeline  POST /api/cases/:id/run = all of the above │
   │  store.ts  in-memory cases + per-case event bus              │
   └──────────────────────────────────────────────────────────────┘
```

**One button.** `POST /api/cases/:id/run` ([`server/src/routes/pipeline.ts`](server/src/routes/pipeline.ts)) runs
research (paid over x402 when the agent wallet is set) → financing → BNB mandate → XRPL credential → the call (with
every offer and transcript turn appended to the BNB log) → [0% loan, only when the advice is a payment plan] → XRPL
escrow → BNB `recordDeal` (settlement ref = escrow tx) → zero-balance release. Each step logs in English and
Chinese. A failed step is reported as an `error` event and in `GET /api/cases/:id/run`, never skipped silently.
Only research and the call are fatal. The web UI has a "Run everything" button on the research screen.

The last step (the hospital confirming $0) is **simulated by default**: the pipeline calls `confirm-zero-balance`
itself and logs "demo: the hospital side is simulated". Pass `{"confirm": false}` to leave it for a manual call.

Route contract: [`docs/API.md`](docs/API.md). Shared shapes: [`server/src/types.ts`](server/src/types.ts).

## What's live vs. mocked

Checked against testnets and real services, as of this commit:

| Part | Status | Proof |
|---|---|---|
| XRPL devnet: Credential, token escrow, Batch release, Permissioned Domain, private Vault, LoanSet, LoanPay | **Live-verified** | `npm run live:xrpl` runs 7 fresh faucet wallets through every step and ends "ALL XRPL DEVNET STEPS tesSUCCESS" |
| XRPL vault gate: a deposit from a wallet without the `VerifiedDonor` credential | **Live-verified** rejected with `tecNO_AUTH` | same script; it throws unless the result is `tecNO_AUTH` |
| Gemini public Fed-decision odds + FRED policy rate | **Live-verified** | `npm run live:gemini` |
| AUSD on Base Sepolia: the token's EIP-712 domain ("Agora Dollar" / "1", chainId 84532) | **Live-verified** once by hand against the on-chain `DOMAIN_SEPARATOR` | comment in [`server/src/chain/ausd.ts`](server/src/chain/ausd.ts); `npm run live:ausd` is the full payment check and has not passed yet |
| AUSD x402 payment (`transferWithAuthorization`) | Not live: the EVM wallets hold 0, so no real AUSD payment has happened | unit tests (`test/ausd.test.ts`) |
| BNB `AdvocateLedger` contract | Not deployed: the BSC wallet holds 0 and `ADVOCATE_LEDGER_ADDRESS` is unset | unit tests (`test/bnb.test.ts`) |
| Gemini sandbox hedge | Not live: no sandbox key | unit tests |
| Claude (bill parse, Chinese, translation, research extraction, appeals) | Not run live: no `ANTHROPIC_API_KEY` set yet | unit tests with mocks |
| ElevenLabs voice (intake, agent-vs-agent call, phone agent) | Not run live end to end. A teammate's key passed read-only API probes and one Flash v2.5 TTS sample (`npm run setup:agents -- --check` / `--smoke-test`); no agent conversation, negotiation or phone call has run | unit tests with mocks; [`server/src/agent/README.md`](server/src/agent/README.md) |
| Context.dev research, clinic appeals | Not run live: no key | unit tests with mocks |
| Hospital "$0 balance" confirmation | **Simulated** by default in the one-button run, and logged as simulated | `pipeline.ts` |

The deterministic bill audit (the $2,230.60 of flagged errors) needs no keys and runs for real on the seed bill.
`cd server && npx vitest run` passes 210 tests in 14 files with no keys.

## How we use each sponsor

### Ripple: XRPL (devnet). Live-verified
Settlement that pays the hospital only when the patient's account is cleared, and a lending fund only vetted donors
can pay into.
- **Credentials (XLS-70):** the clinic's social worker issues `FinancialHardship` (CredentialCreate), the patient
  accepts it (CredentialAccept): `issueHardshipCredential` in [`server/src/chain/xrpl.ts`](server/src/chain/xrpl.ts).
- **Token escrow (XLS-85) with a PREIMAGE-SHA-256 crypto-condition:** the agreed amount in our issued `USD` token
  is locked patient → hospital; the fulfillment stays server-side: `createSettlementEscrow`.
- **Batch (XLS-56), AllOrNothing:** hospital confirms $0 → one atomic Batch of `EscrowFinish` + the advocate fee,
  then we check that the escrow ledger entry is gone: `releaseOnZeroBalance`.
- **Credential-gated private fund:** [`server/src/chain/xrplFund.ts`](server/src/chain/xrplFund.ts).
  - `buildDonorDomain`: a **Permissioned Domain (XLS-80)** that accepts only the fund's `VerifiedDonor` credential.
  - `buildVaultCreate`: a **private, closed-ended single-asset Vault (XLS-65)** (`tfVaultPrivate` + `DomainID`).
    Only domain members can deposit. `live:xrpl` has a stranger try to deposit and the ledger rejects it with
    **`tecNO_AUTH`** ([`server/scripts/live-xrpl.ts`](server/scripts/live-xrpl.ts)).
  - A vetted donor deposits, then a LoanBroker and a **0% LoanSet (XLS-66)** lend to holders of the hardship
    credential. The pipeline's `loan` step runs only when the financing advice says payment plan.
- Routes in [`server/src/routes/xrpl.ts`](server/src/routes/xrpl.ts): `POST /api/cases/:id/credential`, `/settle`,
  `/confirm-zero-balance`, `/loan`. Explorer links: [`server/src/chain/explorers.ts`](server/src/chain/explorers.ts).
- `npm run setup:xrpl` faucet-funds wallets, issues `USD`, creates the domain, vault and broker, and writes
  `XRPL_*` (including `XRPL_DONOR_DOMAIN_ID`) to `.env`. Tests: `server/test/xrpl.test.ts`.

### Agora: AUSD on Base Sepolia (x402). Built; domain checked by hand, no real payment yet
The agent pays for its own data, per call, in a stablecoin.
- Paywalled agent APIs `GET /x402/fair-price` (0.05 AUSD) and `POST /x402/appeal` (0.50 AUSD), x402 v2 "exact"
  scheme, plus `GET /api/x402/payments`: [`server/src/routes/x402.ts`](server/src/routes/x402.ts),
  [`server/src/chain/x402.ts`](server/src/chain/x402.ts). Verify → do the work → settle, so a failed lookup is
  never charged.
- Gasless EIP-3009 `transferWithAuthorization` (EIP-712 domain `Agora Dollar` / `1`, 6 decimals), self-settled by
  the payee: [`server/src/chain/ausd.ts`](server/src/chain/ausd.ts).
- The advocate is the paying client: `paidFetch`, used by the pipeline for every fair-price lookup
  (`paidFairPrice` in [`pipeline.ts`](server/src/routes/pipeline.ts)). Receipts land on the case. With no agent
  wallet configured, lookups run unpaid and the log says so.
- The AUSD EIP-712 domain was checked by hand against the token's on-chain `DOMAIN_SEPARATOR` (see `ausd.ts`).
  `npm run live:ausd` runs a real paid x402 round trip; it stops early because our wallets hold 0 AUSD and 0 Base
  Sepolia ETH, so no real payment has been made yet. Tests: `server/test/ausd.test.ts`.

### Gemini: prediction markets. Odds live-verified; hedge sandbox-only and not run
Live Fed-decision odds that bear on a real household decision.
- Public FOMC events (`api.gemini.com/v1/prediction-markets/events?category=Economics`) → normalized outcome
  probabilities → expected rate path; FRED `DFEDTARU` for the current target rate:
  [`server/src/markets/gemini.ts`](server/src/markets/gemini.ts).
- `financingAdvice` compares a discounted lump sum against the present value of a payment plan, discounted at her
  opportunity rate along the market-implied path, and explains it in Chinese.
- `placeHedge` (a small YES position on the hike outcome) is hard-wired to the **sandbox** and needs
  `GEMINI_API_KEY`/`GEMINI_API_SECRET`, which we have not set; it is mock-tested only.
- Routes in [`server/src/routes/markets.ts`](server/src/routes/markets.ts): `GET /api/markets/fed`,
  `POST /api/cases/:id/financing`, `POST /api/cases/:id/hedge`. Live check: `npm run live:gemini`.

### YZi Labs / BNB Chain: trusted agent infrastructure. Built, not deployed
Authorization the agent can't exceed, and a negotiation record nobody can quietly edit.
- [`contracts/AdvocateLedger.sol`](contracts/AdvocateLedger.sol): `openMandate` / `openMandateWithSig` (patient
  signs EIP-712), `revokeMandate`, `appendLog` (hash chain: `head = keccak(head, entryHash)`), `recordDeal` (reverts
  `OverMandate` above the cap; stores transcript root, log head and the XRPL settlement ref).
- [`server/src/chain/bnb.ts`](server/src/chain/bnb.ts): compile/deploy with solc, serialized sends, and
  `readLedger` recomputes the chain head from off-chain entries to verify it against the contract.
- Routes in [`server/src/routes/bnb.ts`](server/src/routes/bnb.ts): `POST /api/cases/:id/mandate`,
  `GET /api/cases/:id/ledger`. The pipeline appends every offer and transcript turn as it happens (`ledgerSink` in
  [`pipeline.ts`](server/src/routes/pipeline.ts)).
- Not deployed yet: the BSC testnet wallet holds 0 tBNB. Deploy with `npm run deploy:ledger` once funded. Tests:
  `server/test/bnb.test.ts`.

### ElevenLabs: voice. Built, mock-tested; API access and TTS checked, no conversation run yet
There are two separate voice systems.
1. **Intake and agent-vs-agent negotiation (used by the pipeline).**
   - Three Conversational AI agents (Mandarin intake, English advocate, hospital-billing persona), created
     idempotently by `npm run setup:agents`: [`server/src/agent/elevenlabs.ts`](server/src/agent/elevenlabs.ts). In
     clinic mode the hospital agent runs with an insurer prompt override, or a dedicated
     `ELEVENLABS_INSURER_AGENT_ID` if set. Voices use `eleven_flash_v2` /
     `eleven_flash_v2_5`. These agents' conversational LLM is the one ElevenLabs hosts (`ELEVENLABS_LLM`, default
     `gpt-4o`); our server-side translation and reasoning use Claude.
   - **Bridge:** two ElevenLabs WebSockets, each agent's audio resampled and paced in real time into the other's
     microphone, both voices streamed to the browser, each turn translated to Chinese:
     [`server/src/agent/bridge.ts`](server/src/agent/bridge.ts), [`translate.ts`](server/src/agent/translate.ts).
   - Tools (`log_offer`, `accept_offer`, `end_call` (exposed to ElevenLabs as `report_outcome`, because `end_call`
     clashes with the platform's built-in hang-up tool; the webhook maps it back), `submit_intake`) enforce the
     mandate in code: an accept above her cap is refused: [`server/src/agent/tools.ts`](server/src/agent/tools.ts). Prompts:
     [`server/src/agent/prompts.ts`](server/src/agent/prompts.ts).
   - Routes in [`server/src/routes/voice.ts`](server/src/routes/voice.ts): `GET /api/intake/signed-url`,
     `POST /api/cases/:id/negotiate`, `POST /api/cases/:id/negotiate/stop`, `POST /api/eleven/tools/:name`.
2. **Outbound phone agent** ([`server/src/agent/calls.ts`](server/src/agent/calls.ts), `haiku.ts`, `call-plan.ts`,
   `shared-context.ts`): ElevenLabs Flash voice over Twilio, with **Claude Haiku** (`VOICE_LLM_MODEL`, default
   `claude-haiku-5-5`) as a custom LLM served from our endpoint.
   - **Off by default and fail-closed:** it refuses to dial unless `VOICE_CALLS_ENABLED=true`, returns 403 when
     `VOICE_ALLOWED_NUMBERS` is empty, and returns 403 for any destination not on that list.
   - Routes under `/api/voice/*`: `GET /api/voice/ready`, `POST /api/voice/jobs/preview` (dry run, never dials),
     `POST /api/voice/jobs`, `GET /api/voice/jobs/:id`, `.../refresh`, `.../reconcile`,
     `/api/voice/webhooks/elevenlabs`, `/api/voice/llm/v1/chat/completions`.
   - Setup: `npm run setup:agents -- --outbound`; full env list in
     [`server/src/agent/voice.env.example`](server/src/agent/voice.env.example). It is **not** wired into
     `POST /api/cases/:id/run` ([`server/src/agent/README.md`](server/src/agent/README.md)).
- Tests: `server/test/voice.test.ts`, `server/test/agent.test.ts`.

### Context.dev: research. Built, mock-tested (no key yet)
- Client for `api.context.dev/v1` (web search, scrape, answers, urls):
  [`server/src/research/contextdev.ts`](server/src/research/contextdev.ts).
- Fair prices that must be quoted verbatim from a cited document or are dropped:
  [`server/src/research/fairprice.ts`](server/src/research/fairprice.ts).
- The hospital's 501(r) financial-assistance policy and FPL thresholds:
  [`server/src/research/charity.ts`](server/src/research/charity.ts). Payer medical policies for clinic appeals:
  [`server/src/claims/policy.ts`](server/src/claims/policy.ts).
- Route: `POST /api/cases/:id/research` ([`server/src/routes/research.ts`](server/src/routes/research.ts)). Live
  checks `npm run live:research` and `live:clinic` need Context.dev and Anthropic keys and have not been run yet.

### General
- Bill parse with Claude vision (image or PDF) + Chinese explanations:
  [`server/src/bill/parse.ts`](server/src/bill/parse.ts). Deterministic audit (duplicates, ER level, unbundled
  panels, math), no keys needed: [`server/src/bill/audit.ts`](server/src/bill/audit.ts). Routes `POST /api/cases`,
  `POST /api/cases/demo` ([`server/src/routes/bill.ts`](server/src/routes/bill.ts)).
- Negotiation fact sheet and price ladder, built only from flags, verified prices and the charity policy:
  [`server/src/research/facts.ts`](server/src/research/facts.ts).
- Clinic denial appeals: [`server/src/claims/appeal.ts`](server/src/claims/appeal.ts), routes `POST /api/claims`,
  `POST /api/claims/demo` ([`server/src/routes/clinic.ts`](server/src/routes/clinic.ts)), UI at `/clinic.html`.
  Two seed denials: [`denial-mri.json`](server/fixtures/denial-mri.json) and
  [`denial-sleep.json`](server/fixtures/denial-sleep.json).
- Design preview: with `DEV_PREVIEW=1`, `GET /dev/preview?stage=bill|research|room|receipts` renders any screen
  from data labeled PREVIEW ([`server/src/dev/preview.ts`](server/src/dev/preview.ts)). Off unless the flag is set.

## Setup

```bash
cd bangbang/server
npm install
cp .env.example .env        # fill keys below. .env is gitignored. Never commit it.
npm test                    # unit tests, no keys needed
npm run dev                 # http://localhost:8787  (web UI + API)
```

`GET /health` reports which integrations are configured: `anthropic`, `elevenlabs`, `contextDev`, `xrpl`, `bnb`,
`ausd`, `geminiTrading`. The phone agent has its own check, `GET /api/voice/ready`. A route whose key is missing
answers **503 "X is not configured — set Y"**. Real routes never fall back to fake data; the only exception is
`/dev/preview`, which exists only with `DEV_PREVIEW=1` and labels its data PREVIEW.

| What | Env vars | How |
|---|---|---|
| LLM: Claude (bill parse, Chinese, translation, research extraction, appeals) | `ANTHROPIC_API_KEY`, optional `ANTHROPIC_MODEL` (default `claude-opus-5-5`) | Anthropic key |
| Research | `CONTEXT_DEV_API_KEY` | context.dev |
| Voice (intake + negotiation) | `ELEVENLABS_API_KEY`, then the agent ids; optional `ELEVENLABS_LLM`, `PUBLIC_URL` (webhook tool mode) | `npm run setup:agents` writes/prints `ELEVENLABS_*_AGENT_ID` |
| Phone agent (optional, off by default) | `VOICE_CALLS_ENABLED`, `VOICE_ALLOWED_NUMBERS` (required to dial), `VOICE_LLM_MODEL`, `VOICE_ORCHESTRATOR_TOKEN`, `VOICE_LLM_TOKEN`, `ELEVENLABS_OUTBOUND_AGENT_ID`, `ELEVENLABS_PHONE_NUMBER_ID`, `PUBLIC_URL`, others | `npm run setup:agents -- --outbound`; full list in [`server/src/agent/voice.env.example`](server/src/agent/voice.env.example) |
| EVM wallets | `BSC_PRIVATE_KEY`, `AGENT_EVM_PRIVATE_KEY`, `PAYEE_EVM_PRIVATE_KEY` (optional `PATIENT_EVM_PRIVATE_KEY`) | `npm run setup:wallets` fills blank keys and prints addresses + faucet links |
| BNB ledger | `ADVOCATE_LEDGER_ADDRESS` | fund `BSC_PRIVATE_KEY` with tBNB ([faucet](https://www.bnbchain.org/en/testnet-faucet)), then `npm run deploy:ledger` |
| AUSD x402 | agent + payee keys | Base Sepolia AUSD for the agent wallet (testnet faucet); Base Sepolia ETH for the payee (it submits the transfer) |
| XRPL | `XRPL_*` seeds, `XRPL_VAULT_ID`, `XRPL_LOAN_BROKER_ID`, `XRPL_DONOR_DOMAIN_ID` | `npm run setup:xrpl` faucet-funds devnet wallets, issues USD, creates the domain + fund, writes `.env` |
| Gemini | none for odds; `GEMINI_API_KEY`/`GEMINI_API_SECRET` for the sandbox hedge | sandbox account |

Live checks against real services: `npm run live:xrpl` and `live:gemini` have passed; `live:ausd` (a real x402
payment) cannot run until the payee holds Base Sepolia ETH and the agent holds AUSD; `live:research` and
`live:clinic` need Context.dev and Anthropic keys and have not been run.

Run the demo: open http://localhost:8787 → "用示范账单试试" (demo bill) → intake → research screen →
**一键全部办理 / Run everything**. Or from a shell:

```bash
ID=$(curl -s -XPOST localhost:8787/api/cases/demo -H 'content-type: application/json' -d '{}' | jq -r .id)
curl -s -XPOST localhost:8787/api/cases/$ID/run -H 'content-type: application/json' -d '{"counterparty":"agent"}'
curl -s localhost:8787/api/cases/$ID/run | jq '.steps'
```

Deploy: [`Dockerfile`](Dockerfile) + [`render.yaml`](render.yaml) (Render Blueprint, or any Docker host). Single
instance only, because state is in memory. Not deployed yet. CI: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

## What is seed data, and other honest limitations

- **Seed data, labeled:** the bill ([`server/fixtures/lin-er-bill.json`](server/fixtures/lin-er-bill.json)), the
  patient and the denied claims are fictional; the hospital (Stanford Health Care) is real, so its real policy and
  prices are researched live once the keys are set. The hospital and insurer agents are personas we wrote.
- **The hospital's "$0 balance" confirmation is simulated** in the one-button run (the pipeline calls
  `confirm-zero-balance` itself and says so in the log). Pass `{"confirm": false}` to leave it for a manual click.
- **XRPL:** everything runs on devnet because Vault and Lending exist only there. The stablecoin is our own issued
  `USD`, not RLUSD (no devnet issuer). The vault is private and closed-ended, so vetted-donor deposits happen once
  in `setup:xrpl`. The escrow fulfillment is held in server memory: a restart before release leaves the escrow to
  expire and be cancelled.
- **State is in memory.** Cases, the BNB log bodies and escrow secrets vanish on restart (the chains keep the
  hashes).
- **BNB:** one transaction per log entry, so the on-chain log trails a fast call by a few seconds per turn; the
  pipeline waits up to 2 minutes for it before recording the deal. Without `PATIENT_EVM_PRIVATE_KEY` the server key
  signs the mandate as her guardian, and the receipt says so.
- **x402 is self-settled** (no facilitator is known to support AUSD), and in the demo both payer and payee are our
  own wallets. If the agent wallet isn't configured, research looks prices up unpaid and logs that it did.
- **Financing defaults are assumptions:** a 10% prompt-pay discount vs a 12-month 0% plan, overridable in the
  request body. The market odds and policy rate are live.
- **Research coverage:** at most the 6 highest-charge codes per bill; a price we can't find quoted in a source is
  left blank rather than estimated.
- **Voice:** agent-vs-agent turn-taking relies on ElevenLabs' VAD over a paced audio bridge; a call can end on the
  4-minute timeout without a deal, and the run then fails loudly. The phone agent has never placed a real call.
- **Tool webhook secret:** with `ELEVENLABS_TOOL_SECRET` set, ElevenLabs must send `x-bangbang-secret`; our own
  page's same-origin calls are exempt. The case UUID is the real capability; this is not user authentication.
- Not medical, legal or financial advice. Testnets only.

## Layout

```
bangbang/
  server/src/   routes/ (HTTP)  bill/  research/  agent/  chain/  markets/  claims/  dev/   llm.ts env.ts types.ts store.ts
  server/test/  vitest, no keys      server/scripts/  setup + live checks      server/fixtures/  seed data
  contracts/    AdvocateLedger.sol   web/  patient (/) and clinic (/clinic.html) UI
  docs/         API.md, DEMO.md, SUBMISSION.md      Dockerfile  render.yaml
```

Team guide and module ownership: [`TEAM.md`](TEAM.md).
