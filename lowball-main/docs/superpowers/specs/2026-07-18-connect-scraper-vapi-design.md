# Connect the cars.com scraper to the Vapi negotiation server

**Date:** 2026-07-18 · **Status:** approved (autonomous session; decisions recorded here)

## Problem

The Vapi server (`server/`) can only ingest via an Apify actor that was never
set up, falling back to one hardcoded Camry. Gabe's scraper (`scraping/`)
already produces 50 rich cars.com listings in `data/listings/*.json`, every one
with a dealer phone number, 49 with real price-drop history. The two halves
have never met.

## Approaches considered

- **A. Wire `/ingest` to an Apify cars.com actor.** Rejected: the scraper is
  local Playwright, not an Apify actor; would add network + cost + flake to a
  demo that needs to be bulletproof.
- **B. Server reads `data/listings/` directly (chosen).** Zero new infra, works
  offline, the dataset is already the cache. Scraper and server stay decoupled
  through files on disk.
- **C. Scraper pushes to the server after each run.** Extra moving part, no
  benefit at demo scale.

## Design

### New module: `server/src/listings.ts`

- `loadListings()` — read every `data/listings/*.json` (dir resolved relative
  to the module, `DATA_DIR` env override), parse Gabe's schema.
- `listingSummary()` — compact shape for a dashboard picker: id, title, price,
  mileage, dealer, phone, badge, number of price cuts.
- `toCar(listing)` — map to the shared `Car` contract: numeric price/mileage/
  year, `seller_name` → dealer, `seller_phone_number` → E.164 phone,
  `defaultTarget(price)` target. Attaches negotiation intel (below).

### `Car` contract gains optional intel (`server/src/types.ts`)

```ts
priceHistory?: { date: string; price: number }[]  // parsed price_changes
marketMedian?: number                             // median asking of same make+model in dataset
```

Optional fields keep every existing caller working.

### Assistant prompt uses the intel (`server/src/assistant.ts`)

- Price history → a PRICE HISTORY section: "they cut the price 3 times,
  $23,850 → $19,379 — they are motivated, reference this."
- Market median (when below asking) → the ANCHOR step cites it instead of an
  invented comp.

### Routes (`server/src/index.ts`)

- `GET /listings` — summaries of all scraped listings.
- `POST /negotiate` — body may now be `{ listingId, dealerPhone? }` instead of
  `{ car, dealerPhone? }`. `dealerPhone` override kept (demo calls a teammate,
  not a real dealer). Unknown id → 404.

## Error handling

- Missing/empty `data/listings/` → `GET /listings` returns `[]`, negotiate by
  id → 404 with a clear message.
- Unparseable listing file → skipped with a warning, never crashes the demo.
- Listing with no phone and no override → existing "No dealer phone number
  provided" error.

## Testing

- `server/scripts/test-listings.ts` — assertions over the real dataset:
  50 load, mapping types correct, E.164 phones, intel present.
- `npm run typecheck`.
- Boot server, `GET /health` + `GET /listings`, `POST /negotiate` with a
  listingId and no Vapi key → fails at the Vapi-key check, proving the wiring
  reaches the call-creation step.
