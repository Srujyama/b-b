# BangBang 帮帮

**An AI advocate for people the US medical-billing system talks past.** It reads a hospital bill, explains it in
the patient's language, finds the errors, researches what the care should cost, then calls the billing office and
negotiates *in English, out loud* while the patient follows a live translation. The deal settles through an XRPL
escrow that only pays the hospital once it confirms a zero balance.

帮帮 (bāngbāng) means "help". Mode 2 uses the same agent for doctors' offices: it appeals insurance denials on
medical necessity and argues the appeal with the insurer's agent.

## The problem

US hospitals bill uninsured patients list prices that are often several times what Medicare or insurers pay.
Itemized bills routinely contain duplicates and upcoding. Every nonprofit hospital must publish a 501(r)
financial-assistance policy, and many patients qualify for free or discounted care without knowing it. Getting any
of that money back takes hours on the phone, in English, with someone who knows the billing codes. People who don't
speak English mostly just pay, or don't and get sent to collections.

## Mrs. Lin's story (the demo)

Mrs. Lin speaks Mandarin and no English. Her household of 3 lives on $41,000 a year (about 150% of the federal
poverty line). After an evening in the Stanford Health Care emergency department she gets an itemized self-pay
bill for **$14,296**.

1. **She photographs the bill.** BangBang reads every line with a vision model, explains each charge in plain
   Chinese, and a deterministic audit flags a duplicated IV push, a level-5 ER visit that fits level 4, and lab
   tests unbundled from a panel billed the same day, about **$2,230** of likely errors.
2. **She talks to BangBang in Mandarin** (ElevenLabs voice agent). It collects her household size, income, the most
   she's willing to pay ($2,500) and her explicit consent.
3. **BangBang researches.** Using Context.dev it pulls Medicare rates and the hospital's published prices for the
   biggest codes, and finds Stanford's financial-assistance policy and its FPL thresholds. Every number must appear
   verbatim in a cited source or it's dropped. It pays for each lookup itself, **0.05 AUSD over x402**.
4. **Her mandate goes on-chain.** A BNB Chain contract records the cap and a consent hash. Every offer and every
   transcript turn of the call is hash-chained onto it, and the contract rejects a deal above her cap.
5. **The call.** BangBang's advocate agent phones the hospital's billing agent (agent vs agent, or a teammate plays
   billing) and negotiates in English. Both voices stream to the browser and she reads a live Chinese transcript.
6. **Pay smart.** Gemini prediction-market odds on the next Fed decisions give the expected rate path. BangBang uses
   it to recommend a discounted lump sum or a payment plan. If a plan wins, a 0% loan comes from an XRPL community
   fund.
7. **Settle safely.** The agreed amount is locked in an XRPL token escrow with a crypto-condition. A hardship
   Credential proves her eligibility. When the hospital confirms a $0 balance, one atomic Batch releases the escrow
   and pays BangBang's small fee.

The 2-minute shot list is in [`docs/DEMO.md`](docs/DEMO.md).

## Architecture

```
                     browser (web/)  — Mandarin-first, plain HTML/JS
   photo/PDF ─┐      upload · bill in Chinese · voice intake · research feed · negotiation room · receipts
              ▼                    │ REST                              ▲ WS /ws?case=  (log en+zh, transcript,
   ┌──────────────────────────────────────────────────────────────┐   │  offers, receipts, PCM audio)
   │  Fastify server (server/src)                                 │───┘
   │                                                              │
   │  bill/  parse (vision LLM) → explain zh → deterministic audit│
   │  research/  Context.dev search/scrape → fair prices,         │──► Context.dev
   │             501(r) charity policy → facts + price ladder     │
   │  routes/x402 ◄── advocate pays per call (paidFetch) ─────────│──► Base Sepolia (AUSD, EIP-3009)
   │  markets/gemini  Fed odds + FRED rate → lump sum vs plan     │──► Gemini prediction markets (public)
   │  chain/bnb  AdvocateLedger: mandate · hash-chained log · deal│──► BSC testnet
   │  agent/  prompts · tools · bridge (agent ⇄ agent audio)      │──► ElevenLabs Conversational AI
   │  chain/xrpl*  Credential · TokenEscrow · Batch · Vault · Loan│──► XRPL devnet
   │  claims/  payer policy → criteria vs chart → appeal letter   │
   │  routes/pipeline  POST /api/cases/:id/run = all of the above │
   │  store.ts  in-memory cases + per-case event bus              │
   └──────────────────────────────────────────────────────────────┘
```

**One button.** `POST /api/cases/:id/run` ([`server/src/routes/pipeline.ts`](server/src/routes/pipeline.ts)) runs
research (paid over x402 when the agent wallet is set) → financing → BNB mandate → XRPL credential → the call (with
every offer and transcript turn appended to the BNB log) → [0% loan] → XRPL escrow → BNB `recordDeal` (settlement
ref = escrow tx) → zero-balance release. Each step logs in English and Chinese. A failed step is reported as an
`error` event and in `GET /api/cases/:id/run`, never skipped silently. Only research and the call are fatal. The web
UI has a "Run everything" button on the research screen.

Route contract: [`docs/API.md`](docs/API.md). Shared shapes: [`server/src/types.ts`](server/src/types.ts).

## How we use each sponsor

### Ripple: XRPL (devnet)
Settlement that pays the hospital only when the patient's account is actually cleared.
- **Credentials (XLS-70):** the clinic's social worker issues `FinancialHardship`, the patient accepts:
  `issueHardshipCredential` in [`server/src/chain/xrpl.ts`](server/src/chain/xrpl.ts).
- **Token escrow (XLS-85) with a crypto-condition:** the agreed amount in our issued `USD` token is locked
  patient → hospital; the fulfillment stays server-side: `createSettlementEscrow`.
- **Batch (XLS-56), AllOrNothing:** hospital confirms $0 → one atomic Batch of `EscrowFinish` + the advocate fee,
  then we prove the escrow ledger entry is gone: `releaseOnZeroBalance`.
- **Single-asset Vault (XLS-65) + Lending (XLS-66):** a closed community fund that issues 0% loans to
  credential holders: [`server/src/chain/xrplFund.ts`](server/src/chain/xrplFund.ts).
- Routes: [`server/src/routes/xrpl.ts`](server/src/routes/xrpl.ts). Live proof with fresh faucet wallets:
  `npm run live:xrpl`.

### Agora: AUSD on Base Sepolia (x402)
The agent pays for its own data, per call, in a stablecoin.
- Paywalled agent APIs `GET /x402/fair-price` (0.05 AUSD) and `POST /x402/appeal` (0.50 AUSD), x402 v2 "exact"
  scheme: [`server/src/routes/x402.ts`](server/src/routes/x402.ts),
  [`server/src/chain/x402.ts`](server/src/chain/x402.ts). Verify → do the work → settle, so a failed lookup is
  never charged.
- Gasless EIP-3009 `transferWithAuthorization` (EIP-712 domain `Agora Dollar` / `1`, 6 decimals), self-settled by
  the payee: [`server/src/chain/ausd.ts`](server/src/chain/ausd.ts).
- The advocate is the paying client: `paidFetch`, used by the pipeline for every fair-price lookup
  (`paidFairPrice` in [`pipeline.ts`](server/src/routes/pipeline.ts)). Receipts land on the case.
  Live proof: `npm run live:ausd`.

### Gemini: prediction markets
Live Fed-decision odds that bear on a real household decision.
- Public FOMC events → normalized outcome probabilities → expected rate path; FRED for the current target rate:
  [`server/src/markets/gemini.ts`](server/src/markets/gemini.ts).
- `financingAdvice` compares a discounted lump sum against the present value of a payment plan, discounted at her
  opportunity rate along the market-implied path, and explains it in Chinese.
- Optional sandbox hedge (a small YES position on the hike outcome) recorded as a receipt.
  Routes: [`server/src/routes/markets.ts`](server/src/routes/markets.ts). Live proof: `npm run live:gemini`.

### YZi Labs / BNB Chain: trusted agent infrastructure
Authorization the agent can't exceed, and a negotiation record nobody can quietly edit.
- [`contracts/AdvocateLedger.sol`](contracts/AdvocateLedger.sol): `openMandate` / `openMandateWithSig` (patient
  signs EIP-712), `appendLog` (hash chain: `head = keccak(head, entryHash)`), `recordDeal` (reverts `OverMandate`
  above the cap; stores transcript root, log head and the XRPL settlement ref).
- [`server/src/chain/bnb.ts`](server/src/chain/bnb.ts): compile/deploy with solc, serialized sends, and
  `readLedger` recomputes the chain head from off-chain entries to verify it against the contract.
- The pipeline subscribes to the case's event bus and appends every offer and transcript turn as it happens
  (`ledgerSink` in [`pipeline.ts`](server/src/routes/pipeline.ts)).

### ElevenLabs: voice
- Three Conversational AI agents (Mandarin intake, English advocate, hospital-billing persona; plus an insurer
  persona for clinic mode), created idempotently by `npm run setup:agents`:
  [`server/src/agent/elevenlabs.ts`](server/src/agent/elevenlabs.ts).
- **Agent-vs-agent bridge:** two ElevenLabs WebSockets, each agent's audio resampled and paced in real time into
  the other's microphone, both voices streamed to the browser, each turn translated to Chinese:
  [`server/src/agent/bridge.ts`](server/src/agent/bridge.ts).
- Tools (`log_offer`, `accept_offer`, `report_outcome`, `submit_intake`) enforce the mandate in code: an accept
  above her cap is refused: [`server/src/agent/tools.ts`](server/src/agent/tools.ts). Prompts:
  [`server/src/agent/prompts.ts`](server/src/agent/prompts.ts).

### Context.dev: research
- Search / scrape / answer client: [`server/src/research/contextdev.ts`](server/src/research/contextdev.ts).
- Fair prices that must be quoted verbatim from a cited document or are dropped:
  [`server/src/research/fairprice.ts`](server/src/research/fairprice.ts).
- The hospital's 501(r) financial-assistance policy and FPL thresholds:
  [`server/src/research/charity.ts`](server/src/research/charity.ts). Payer medical policies for clinic appeals:
  [`server/src/claims/policy.ts`](server/src/claims/policy.ts).

### General
- Bill vision parse + Chinese explanations: [`server/src/bill/parse.ts`](server/src/bill/parse.ts); deterministic
  audit (duplicates, ER level, unbundled panels, math): [`server/src/bill/audit.ts`](server/src/bill/audit.ts).
- Negotiation fact sheet and price ladder, built only from flags, verified prices and the charity policy:
  [`server/src/research/facts.ts`](server/src/research/facts.ts).
- Clinic denial appeals: [`server/src/claims/appeal.ts`](server/src/claims/appeal.ts),
  UI at `/clinic.html`.

## Setup

```bash
cd bangbang/server
npm install
cp .env.example .env        # fill keys below. .env is gitignored. Never commit it.
npm test                    # unit tests, no keys needed
npm run dev                 # http://localhost:8787  (web UI + API)
```

`GET /health` lists which integrations are configured. A route whose key is missing answers
**503 "X is not configured — set Y"**. Nothing falls back to fake data.

| What | Env vars | How |
|---|---|---|
| LLM (parse, Chinese, translation, appeals) | `OPENAI_API_KEY` | OpenAI key |
| Research | `CONTEXT_DEV_API_KEY` | context.dev |
| Voice | `ELEVENLABS_API_KEY`, then the agent ids | `npm run setup:agents` writes/prints `ELEVENLABS_*_AGENT_ID` |
| EVM wallets | `BSC_PRIVATE_KEY`, `AGENT_EVM_PRIVATE_KEY`, `PAYEE_EVM_PRIVATE_KEY` (optional `PATIENT_EVM_PRIVATE_KEY`) | `npm run setup:wallets` fills blank keys and prints addresses + faucet links |
| BNB ledger | `ADVOCATE_LEDGER_ADDRESS` | fund `BSC_PRIVATE_KEY` with tBNB ([faucet](https://www.bnbchain.org/en/testnet-faucet)), then `npm run deploy:ledger` |
| AUSD x402 | agent + payee keys | Base Sepolia AUSD for the agent wallet (testnet faucet); Base Sepolia ETH for the payee (it submits the transfer) |
| XRPL | `XRPL_*` seeds, `XRPL_VAULT_ID`, `XRPL_LOAN_BROKER_ID` | `npm run setup:xrpl` faucet-funds devnet wallets, issues USD, creates the fund, writes `.env` |
| Gemini | none for odds; `GEMINI_API_KEY`/`SECRET` for the sandbox hedge | sandbox account |

Live checks against real services (each prints explorer links): `npm run live:research`, `live:clinic`,
`live:ausd`, `live:xrpl`, `live:gemini`.

Run the demo: open http://localhost:8787 → "用示范账单试试" (demo bill) → intake → research screen →
**一键全部办理 / Run everything**. Or from a shell:

```bash
ID=$(curl -s -XPOST localhost:8787/api/cases/demo -H 'content-type: application/json' -d '{}' | jq -r .id)
curl -s -XPOST localhost:8787/api/cases/$ID/run -H 'content-type: application/json' -d '{"counterparty":"agent"}'
curl -s localhost:8787/api/cases/$ID/run | jq '.steps'
```

## What is seed data, and other honest limitations

- **Seed data, labeled:** the bill ([`server/fixtures/lin-er-bill.json`](server/fixtures/lin-er-bill.json)), the
  patient and the denied claim are fictional; the hospital (Stanford Health Care) is real, so its real policy and
  prices are researched live. The hospital and insurer agents are personas we wrote.
- **The hospital's "$0 balance" confirmation is simulated** in the one-button run (the pipeline calls
  `confirm-zero-balance` itself and says so in the log). Pass `{"confirm": false}` to leave it for a manual click.
- **XRPL:** everything runs on devnet because Vault and Lending exist only there. The stablecoin is our own issued
  `USD`, not RLUSD (no devnet issuer). The vault is closed-ended, so donor deposits happen once in `setup:xrpl`.
  The escrow fulfillment is held in server memory: a restart before release leaves the escrow to expire and be
  cancelled.
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
  4-minute timeout without a deal, and the run then fails loudly.
- **Tool webhook secret:** with `ELEVENLABS_TOOL_SECRET` set, ElevenLabs must send `x-bangbang-secret`; our own
  page's same-origin calls are exempt. The case UUID is the real capability; this is not user authentication.
- Not medical, legal or financial advice. Testnets only.

## Layout

```
bangbang/
  server/src/   routes/ (HTTP)  bill/  research/  agent/  chain/  markets/  claims/   types.ts store.ts
  server/test/  vitest, no keys      server/scripts/  setup + live checks      server/fixtures/  seed data
  contracts/    AdvocateLedger.sol   web/  patient (/) and clinic (/clinic.html) UI   docs/  API.md, DEMO.md
```

Team guide and module ownership: [`TEAM.md`](TEAM.md).
