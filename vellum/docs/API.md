# Vellum server API (contract — keep routes and shapes in sync with src/types.ts)

Base: `http://localhost:8787`. All JSON. Shapes = `src/types.ts`. Errors: `{error: string}` with 4xx/5xx;
a missing key is a 503 `{error: "X is not configured — set Y"}`.

## Cases & live events
| Method | Path | Body → Response | Owner |
|---|---|---|---|
| GET | /health | → which integrations are configured | scaffold |
| GET | /api/cases, /api/cases/:id | → CasePacket[] / CasePacket | scaffold |
| WS | /ws?case=:id | server pushes `CaseEvent` (see types.ts) incl. `audio` chunks | scaffold |

`CasePacket.activity` retains the latest 200 public execution updates. Each update has
`{id, at, stage, kind, message}` and is pushed as `{type: "activity", entry}` before its
original log/offer/deal event. The initial WebSocket `case` snapshot includes history;
clients deduplicate by activity ID and preserve its server order after reconnecting.
Stages are `review`, `research`, `plan`, `call`, and `outcome`. Audio is not retained there.

## Patient flow
| Method | Path | Body → Response | Owner |
|---|---|---|---|
| POST | /api/cases/start | JSON `{message, caseId?, billText?, imageDataUrl?}` or multipart (`message`, optional `bill` file and `caseId`) → 202 CasePacket immediately; `intake.state` advances from `running` to `needs_bill`, `done`, or `failed` over WS. Needs Claude. A follow-up can attach a bill to the same unparsed case; concurrent analysis / replacing an audited bill returns 409. Does not infer consent or a payment limit. | bill |
| POST | /api/cases | multipart (`bill` file: image, PDF or text, `patient` JSON field) OR JSON `{patient, billText}` → CasePacket (status `audited`, bill parsed, flags, zh explanations) | bill |
| POST | /api/cases/demo | `{}` → CasePacket built from fixtures/lin-er-bill.* (runs the same parse+audit code) | bill |
| POST | /api/cases/:id/research | `{}` → CasePacket with fairPrices, charity, facts, target/opening/walkaway (status `researched`) | research |
| POST | /api/cases/:id/financing | `{lumpSumDiscountPct?: [0,100) = 10, planMonths?: 1-120 = 12, planAprPct?: [0,100] = 0, fundLumpSumWith?: "savings"\|"card", planVariable?: boolean}` → FinancingAdvice (Gemini Fed odds; keyless). 400 on a bad field (checked before any network call), 409 if the case has no balance, 502 if Gemini/FRED is unreachable (8 s timeout) | markets |
| GET | /api/markets/fed | → current Fed-decision market odds (public Gemini data; keyless). 502 `{error: "... is unreachable: ..."}` if Gemini or FRED is down (8 s timeout) | markets |
| POST | /api/cases/:id/hedge | `{}` → Receipt (Gemini SANDBOX YES order hedging rate risk) | markets |
| POST | /api/cases/:id/mandate | `{}` → Receipt (BNB AdvocateLedger.openMandate) (status `mandated`) | bnb |
| GET | /api/cases/:id/ledger | → on-chain mandate + log entries + chain-head verification | bnb |
| POST | /api/cases/:id/credential | `{}` → Receipt[] (XRPL CredentialCreate by clinic + CredentialAccept by patient) | xrpl |
| GET | /api/intake/signed-url | → `{signedUrl, init}`; browser sends `init` (conversation_initiation_client_data) first, forwards client tool calls to /api/eleven/tools/:name with case_id | voice |
| POST | /api/cases/:id/negotiate | `{counterparty: "agent" \| "human"}` → `{mode, advocateSignedUrl?, hospitalSignedUrl?}`; `agent` = server bridges two ElevenLabs agents and streams audio+transcript over /ws | voice |
| POST | /api/cases/:id/negotiate/stop | `{}` → stops the bridge | voice |
| POST | /api/eleven/tools/:name | ElevenLabs server-tool webhook (`log_offer`, `accept_offer`, `report_outcome` (= `end_call`), `submit_intake`). With `ELEVENLABS_TOOL_SECRET` set, needs header `x-vellum-secret` unless it is a same-origin browser call (`Sec-Fetch-Site: same-origin`, our page forwarding client tools) | voice |
| POST | /api/cases/:id/settle | `{}` → Receipt[] (XRPL EscrowCreate with crypto-condition for agreedAmount) | xrpl |
| POST | /api/cases/:id/confirm-zero-balance | `{}` (hospital side) → Receipt[] (Batch: EscrowFinish + advocate fee) (status `settled`) | xrpl |
| POST | /api/cases/:id/loan | `{months}` → Receipt[] (0% LoanSet from the community-fund LoanBroker; donor deposits happen once in setup:xrpl — closed-ended vault). Requires accepted hardship credential + agreedAmount | xrpl |
| POST | /api/cases/:id/run | `{counterparty?: "agent"\|"human", confirm?: boolean (default true: simulate the hospital's $0 confirmation), loanMonths?: number}` → 202 `{started, caseId, counterparty, steps}`; runs research (x402-paid when AUSD keys exist) → financing → mandate → credential → negotiate (BNB log of every offer/turn) → [loan if payment_plan] → settle → BNB recordDeal → confirm-zero-balance; progress as en+zh `log` + `error` events over /ws. 409 if a run is in progress, no bill/patient, no consent or maxPay ≤ 0. Re-running resumes (finished steps are skipped) | pipeline |
| GET | /api/cases/:id/run | → RunState `{status: running\|done\|failed, steps: [{name, status: pending\|running\|ok\|skipped\|failed, message?}], error?}` (404 before the first run) | pipeline |

## Clinic flow (doctor's office)
| Method | Path | Body → Response | Owner |
|---|---|---|---|
| POST | /api/claims | `{claim: ClaimCase-without-derived-fields}` → CasePacket mode `clinic` with policy, criteriaMet, appealLetter | clinic |
| POST | /api/claims/demo | `{}` → same, from fixtures/denial-*.json | clinic |

## Paid agent APIs (x402, AUSD on Base Sepolia)
| Method | Path | Notes | Owner |
|---|---|---|---|
| GET | /x402/fair-price?code=&description=&hospital= | 402 → pay 0.05 AUSD → FairPrice | x402 |
| POST | /x402/appeal | 402 → pay 0.50 AUSD → ClaimCase with appealLetter | x402 |
| GET | /api/x402/payments | → Receipts of settled x402 payments | x402 |
