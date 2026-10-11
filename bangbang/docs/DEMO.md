# BangBang 2-minute demo: shot list

One story, Mrs. Lin's $14,296 ER bill, told in six beats. Everything on screen is a live call except the labeled
seed data (the bill and the hospital persona). Record at 1080p, browser full-screen, UI language **中文** (toggle
to EN only where noted).

## Before you hit record (T-10 min)

- [ ] `GET /health`: every integration `true` (openai, elevenlabs, contextDev, xrpl, bnb, ausd).
- [ ] Wallets funded: tBNB on `BSC_PRIVATE_KEY`, AUSD on the agent wallet, Base Sepolia ETH on the payee,
      `npm run setup:xrpl` done (patient holds USD, fund exists).
- [ ] Dry run once: demo case → Run everything → finishes `settled`. Then **restart the server** (fresh state).
- [ ] Printed `server/fixtures/lin-er-bill.html` on the table for the photo shot. Phone on a stand.
- [ ] Second tab open on testnet.bscscan.com, devnet.xrpl.org and sepolia.basescan.org for the receipt cut-aways.
- [ ] If a teammate plays the billing rep (human mode), they are on headphones in a second browser.
- [ ] Mute notifications. Speakers on: the two agent voices are the moment.

## Shot list

| Time | Shot | On screen | Voice-over (EN; subtitles zh) |
|---|---|---|---|
| 0:00–0:12 | **Cold open.** Hands holding the printed bill; phone camera frames it. | Close on "$14,296.00 BALANCE DUE". | "Mrs. Lin speaks Mandarin. This is her emergency-room bill. She can't read it, and nobody at the hospital speaks her language." |
| 0:12–0:30 | **Photo → explained.** Tap 拍照或选择账单文件 → 读账单 (or 用示范账单试试 for the demo seed). | Bill screen: every line in plain Chinese; red flags for the duplicate IV push, level-5 ER visit, unbundled labs, ~$2,230. | "BangBang reads every line, explains it in Chinese, and finds about two thousand dollars of billing errors." |
| 0:30–0:45 | **Mandarin intake.** Tap the mic, she speaks. | Intake agent answers in Mandarin; form fills: household 3, income $41,000, max $2,500, consent ✓. | "She tells it, in Mandarin, what she can afford, and gives it permission to act for her." |
| 0:45–1:00 | **Run everything.** Research screen → 一键全部办理. | Feed streams in Chinese: Medicare and hospital prices with sources, "paid 0.05 AUSD over x402" lines, Stanford's financial-assistance policy, the ladder (open / target / walk-away), "mandate recorded on BNB". | "It researches fair prices and the hospital's charity policy, paying for its own data in AUSD, and writes her spending limit onto BNB Chain." |
| 1:00–1:35 | **The call (the moment).** Auto-switches to the negotiation room. | Two voices talking in English; live Chinese transcript under each line; ticker: asked $14,296 → current → saved %. Deal stamp lands. | Let the audio play for ~25 s, no VO. Then: "It argues in English with the hospital's billing agent, citing the errors and the charity policy. She follows every word in Chinese." |
| 1:35–1:50 | **Settlement.** Auto-switches to receipts. | Receipt timeline: XRPL Credential, EscrowCreate, Batch (EscrowFinish + fee), BNB recordDeal, x402 payments; Gemini card: lump sum vs plan with Fed odds bars. Cut-away: click the Batch receipt → devnet.xrpl.org showing tesSUCCESS. | "The money waits in an XRPL escrow and is released only when the hospital confirms a zero balance. Gemini's Fed odds tell her whether to pay now or take a 0% plan from a community fund." |
| 1:50–2:00 | **Close + clinic flash.** Two-second cut to `/clinic.html` with an appeal letter, then the logo. | "Same agent, for doctors' offices: insurance denials." End card: BangBang 帮帮 · repo URL. | "BangBang. Help, in your language." |

## If something breaks live

- **A step fails:** the feed shows the English error and the run continues where it can
  (`GET /api/cases/:id/run` lists step states). Re-press Run everything: finished steps are skipped (resume).
- **The agents talk over each other or stall:** switch the counterparty to 真人账单员 (human), and a teammate plays
  billing from the second browser. Start the run, press 去谈价钱, then 开始通话 in the room; the run waits for that call's outcome.
- **No deal within 4 minutes:** the run fails loudly. Cut to a recorded take of the call; don't fake the deal.
- **Escrow release** is the hospital's confirmation, simulated in the one-button run (the log says so). To show it
  as a separate beat, run with `{"confirm": false}` and press 医院确认余额为零 on camera.

## Talking points for judges (Q&A)

- Nothing core is hard-coded: prices, the charity policy, Fed odds and every on-chain record come from live calls;
  the receipts link to explorers.
- The mandate is enforced twice: in the tool handler (accept above her cap is refused) and in the contract
  (`OverMandate`).
- The negotiation log is tamper-evident: `GET /api/cases/:id/ledger` recomputes the hash chain from our copy of
  the entries and compares it with the on-chain head.
