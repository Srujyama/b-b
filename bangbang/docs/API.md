# BangBang server API (contract — keep routes and shapes in sync with src/types.ts)

Base: `http://localhost:8787`. All JSON. Shapes = `src/types.ts`. Errors: `{error: string}` with 4xx/5xx;
a missing key is a 503 `{error: "X is not configured — set Y"}`.

## Cases & live events
| Method | Path | Body → Response | Owner |
|---|---|---|---|
| GET | /health | → which integrations are configured | scaffold |
| GET | /api/cases, /api/cases/:id | → CasePacket[] / CasePacket | scaffold |
| WS | /ws?case=:id | server pushes `CaseEvent` (see types.ts) incl. `audio` chunks | scaffold |

## Patient flow (Mrs. Lin)
| Method | Path | Body → Response | Owner |
|---|---|---|---|
| POST | /api/cases | multipart (`bill` file: image/pdf, `patient` JSON field) OR JSON `{patient, billText}` → CasePacket (status `audited`, bill parsed, flags, zh explanations) | bill |
| POST | /api/cases/demo | `{}` → CasePacket built from fixtures/lin-er-bill.* (runs the same parse+audit code) | bill |
| POST | /api/cases/:id/research | `{}` → CasePacket with fairPrices, charity, facts, target/opening/walkaway (status `researched`) | research |
| POST | /api/cases/:id/financing | `{}` → FinancingAdvice (Gemini Fed odds) | markets |
| GET | /api/markets/fed | → current Fed-decision market odds (public Gemini data) | markets |
| POST | /api/cases/:id/hedge | `{}` → Receipt (Gemini SANDBOX YES order hedging rate risk) | markets |
| POST | /api/cases/:id/mandate | `{}` → Receipt (BNB AdvocateLedger.openMandate) (status `mandated`) | bnb |
| GET | /api/cases/:id/ledger | → on-chain mandate + log entries + chain-head verification | bnb |
| POST | /api/cases/:id/credential | `{}` → Receipt[] (XRPL CredentialCreate by clinic + CredentialAccept by patient) | xrpl |
| GET | /api/intake/signed-url | → `{signedUrl, init}`; browser sends `init` (conversation_initiation_client_data) first, forwards client tool calls to /api/eleven/tools/:name with case_id | voice |
| POST | /api/cases/:id/negotiate | `{counterparty: "agent" \| "human"}` → `{mode, advocateSignedUrl?, hospitalSignedUrl?}`; `agent` = server bridges two ElevenLabs agents and streams audio+transcript over /ws | voice |
| POST | /api/cases/:id/negotiate/stop | `{}` → stops the bridge | voice |
| POST | /api/eleven/tools/:name | ElevenLabs server-tool webhook (`log_offer`, `accept_offer`, `end_call`, `submit_intake`) | voice |
| POST | /api/cases/:id/settle | `{}` → Receipt[] (XRPL EscrowCreate with crypto-condition for agreedAmount) | xrpl |
| POST | /api/cases/:id/confirm-zero-balance | `{}` (hospital side) → Receipt[] (Batch: EscrowFinish + advocate fee) (status `settled`) | xrpl |
| POST | /api/cases/:id/loan | `{months}` → Receipt[] (0% LoanSet from the community-fund LoanBroker; donor deposits happen once in setup:xrpl — closed-ended vault). Requires accepted hardship credential + agreedAmount | xrpl |
| POST | /api/cases/:id/run | `{counterparty}` → starts the whole pipeline, progress over /ws | pipeline |

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
