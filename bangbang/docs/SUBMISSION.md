# BangBang 帮帮: submission text

Ready to paste into the hackathon form. Each section is self-contained. Status words ("live-verified",
"mock-tested", "not deployed") match the "What's live vs. mocked" table in the [README](../README.md#whats-live-vs-mocked);
keep them in sync if anything changes before submitting.

## Project name

BangBang 帮帮

## One-line pitch

An AI patient advocate that explains a US hospital bill in the patient's own language, finds the billing errors,
and negotiates with the billing office in English on her behalf, with settlement and consent recorded on-chain.

## The problem

US hospitals bill uninsured patients list prices that are often several times what Medicare or insurers pay.
Itemized bills often contain duplicate charges and upcoded visits. Every nonprofit hospital must publish a 501(r)
financial-assistance policy, and many patients qualify for free or discounted care without knowing it. Getting any
of that money back means hours on the phone, in English, with someone who knows billing codes. Patients who don't
speak English mostly pay the full amount, or don't pay and end up in collections.

## What it does

Mrs. Lin speaks only Mandarin. Her household of three earns $41,000 a year, about 150% of the federal poverty line.
After an evening in the Stanford Health Care emergency department she receives an itemized self-pay bill for
$14,296. (The bill and patient are seed data we wrote; the hospital and its published policy are real.)

1. She uploads a photo or PDF of the bill. BangBang reads each line and explains it in plain Chinese. A
   deterministic audit flags a duplicated IV push, an ER visit billed at level 5 that fits level 4, and lab tests
   unbundled from a panel billed the same day: $2,230.60 of likely errors.
2. She talks to BangBang in Mandarin. It records her household size, income, the most she is willing to pay
   ($2,500) and her consent.
3. BangBang researches Medicare rates and the hospital's published prices for the largest charges, plus the
   hospital's financial-assistance policy and income thresholds. A price is kept only if it appears word for word in
   a cited source. The agent pays for each lookup itself, 0.05 AUSD per call over x402.
4. Her spending cap and a consent hash are recorded in a BNB Chain contract. Every offer and transcript turn of the
   negotiation is appended to a hash chain on that contract, and the contract rejects any deal above her cap.
5. BangBang's advocate agent negotiates out loud in English with a hospital billing agent. Both voices stream to her
   browser with a live Chinese transcript.
6. Fed-decision odds from Gemini's prediction markets give an expected interest-rate path, which BangBang uses to
   recommend paying a discounted lump sum or taking a payment plan. If a plan is better, a 0% loan comes from an
   XRPL community fund.
7. The agreed amount is locked in an XRPL escrow. When the hospital confirms a $0 balance, one atomic transaction
   releases the escrow and pays BangBang's small fee. In our demo run the hospital's confirmation is simulated, and
   the log says so.

A second mode serves doctors' offices: BangBang reads an insurance denial, looks up the payer's medical-necessity
policy, checks the criteria against the chart, and drafts the appeal letter.

## How we built it

- Server: Fastify and TypeScript. Web client: plain HTML, CSS and JavaScript modules with no build step,
  Mandarin-first for the patient flow, with a separate clinic page.
- LLM: Claude, through one shared helper (`server/src/llm.ts`, Anthropic SDK, default `claude-opus-5-5`). It reads
  bill images and PDFs, writes the Chinese explanations, translates the call, extracts quoted prices, and drafts
  appeals.
- The bill audit is deterministic code, not an LLM, so its findings are repeatable.
- `POST /api/cases/:id/run` runs the whole flow in order: research, financing advice, BNB mandate, XRPL credential,
  the negotiation, the optional loan, the escrow, the on-chain deal record and the release. Each step logs in English
  and Chinese. A failed step is reported, never skipped silently.
- Missing configuration returns a 503 that names the missing variable. Real routes never fall back to made-up data.
- 203 unit tests across 14 files run with no API keys.

## Ripple (XRPL)

All of this runs on XRPL devnet and has passed end to end against the live ledger (`npm run live:xrpl`, 7 fresh
faucet wallets, every transaction `tesSUCCESS`). A clinic social worker issues the patient a `FinancialHardship`
Credential (XLS-70), which she accepts. The settlement is a token escrow (XLS-85) in an issued `USD` token, locked
with a PREIMAGE-SHA-256 crypto-condition. When the hospital confirms a $0 balance, one AllOrNothing Batch (XLS-56)
finishes the escrow and pays the advocate fee together. For payment plans we built a community lending fund: a
Permissioned Domain (XLS-80) admits only holders of the fund's `VerifiedDonor` credential, and a private,
closed-ended Vault (XLS-65) bound to that domain holds the donations. On the live ledger, a deposit from a wallet
without the credential is rejected with `tecNO_AUTH`. A LoanBroker then issues a 0% loan (XLS-66) to the
credentialed patient, and the script repays it with LoanPay. Limits: the token is our own `USD`, not RLUSD; the
escrow secret is held in server memory; and the hospital's confirmation is simulated in the demo.

## Agora (AUSD)

BangBang's agent pays for its own research in AUSD. We built two x402 v2 paid endpoints, a fair-price lookup at
0.05 AUSD and an appeal at 0.50 AUSD, and a client (`paidFetch`) that the pipeline uses for every price lookup.
Payment is a gasless EIP-3009 `transferWithAuthorization` on Base Sepolia, signed by the agent and submitted by the
payee. The server verifies the payment, does the work, then settles, so a failed lookup is never charged. Status:
reading AUSD's EIP-712 domain from Base Sepolia works live. Our wallets hold no AUSD yet, so no real payment has
been made; the payment path is covered by unit tests.

## Gemini (prediction markets)

BangBang pulls Gemini's public FOMC prediction-market events and the current Fed target rate from FRED, turns the
outcome probabilities into an expected rate path, and uses it to compare a discounted lump-sum payment against the
present value of a payment plan. The recommendation is explained to Mrs. Lin in Chinese. The odds feed has been
checked live (`npm run live:gemini`). There is also a sandbox-only hedge (a small position on the rate-hike
outcome); it needs sandbox API keys we have not set, so it is unit-tested only.

## YZi Labs / BNB Chain

`AdvocateLedger.sol` gives the agent a mandate it cannot exceed. The patient's cap and a consent hash are recorded
with `openMandate`, or `openMandateWithSig` when she signs EIP-712 herself. Every offer and transcript turn is
appended to an on-chain hash chain. `recordDeal` reverts with `OverMandate` when the amount is above her cap, and
stores the transcript root, the log head and the XRPL settlement reference. The server can recompute the chain head
from the off-chain entries and check it against the contract. Status: the contract and server code are written and
unit-tested. The contract is not deployed yet because our BSC testnet wallet has no tBNB.

## ElevenLabs

We use ElevenLabs Conversational AI agents for a Mandarin intake interview, an English advocate, a hospital billing
persona, and an insurer persona for clinic appeals. A bridge connects two agents over WebSockets, resampling and
pacing each one's audio into the other's input in real time, streaming both voices to the browser and translating
each turn to Chinese. The agents' tools enforce the mandate in code: an accept above the patient's cap is refused.
Separately, an outbound phone agent can place a real call through Twilio, using an ElevenLabs Flash voice with
Claude Haiku as its language model. It is off by default and only dials numbers on an explicit allowlist. Status:
all voice code is unit-tested with mocks. We have not run it against ElevenLabs yet because we don't have the API
key.

## Context.dev

Context.dev is the research layer. BangBang searches and scrapes for Medicare rates and the hospital's published
prices, then keeps a price only if it is quoted word for word in the cited page. It also finds the hospital's 501(r)
financial-assistance policy and its income thresholds, and in clinic mode it finds the insurer's medical-policy
criteria. Status: unit-tested with mocks; the live check is ready to run once we have a key.

## Challenges

- Getting two voice agents to take turns over a bridge without talking over each other. We pace the audio in real
  time and depend on ElevenLabs' voice-activity detection; a call can still time out without a deal, and the run
  then fails visibly instead of pretending.
- Stopping the research step from inventing prices. We drop any number that is not quoted verbatim in its source,
  even when that leaves a gap.
- XRPL's Vault and Lending amendments exist only on devnet, so we issued our own stablecoin there instead of using
  RLUSD.
- No facilitator we found supports AUSD for x402, so the payee settles payments itself.
- Keeping the demo honest: anything simulated, such as the hospital's $0 confirmation, says so in the log.

## What's next

- Add the missing API keys and fund the testnet wallets, then run the full pipeline live: Claude, ElevenLabs,
  Context.dev, a real AUSD payment, and the BNB contract deployment.
- Place a real outbound call to an allowlisted test phone with the phone agent, then wire it into the pipeline.
- Replace the simulated hospital confirmation with a real signal from the billing office.
- Store cases and escrow secrets outside memory so a restart doesn't lose them.
- Add more languages beyond Mandarin, starting with Spanish and Vietnamese.
