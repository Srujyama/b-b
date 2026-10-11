# Server API — for the frontend

This replaces the old "paste a cars.com URL" flow. Read this before wiring the
new UI: text search → 5 ranked cards → tap a card → call starts.

## What changed vs before

- **Old flow (legacy, still works):** `POST /ingest {url}` scraped one cars.com
  URL via Apify, then `POST /negotiate {car}` called it. Keep this working for
  anyone still testing with a single pasted URL — nothing about it changed.
- **New flow:** the user types a free-text request ("F-150 Raptor, 2017+,
  under 35k, near Eatontown NJ"). The server extracts search filters with a
  cheap OpenAI call, searches cars.com through the Python scraper service,
  ranks the results by how negotiable they look, and returns the top 5 as
  cards. The frontend shows the cards; the user taps one; the server starts
  the call from a cached packet — no second scrape needed.
- Both flows end up calling `startNegotiation`, so the live-call dashboard
  (`WS /dashboard`) and Vapi wiring are unchanged either way.

## Running both processes

This feature needs **two servers** running side by side:

```bash
# 1. Python scraper service (cars.com search + listing detail + caching)
python3 -m scraping.serve   # NOT bare uvicorn — Playwright breaks under uvloop (see scraping/serve.py)

# 2. Node/Fastify API server
cd server
npm install   # first time only
npm run dev   # tsx watch src/index.ts, defaults to :8081
```

`server/.env` needs `SCRAPER_URL` pointed at the scraper (defaults to
`http://localhost:8090` if unset — see `server/.env.example`), plus the usual
`OPENAI_API_KEY`, `VAPI_API_KEY`, `VAPI_PHONE_NUMBER_ID`, `PUBLIC_DOMAIN`
(ngrok URL for Vapi webhooks).

If the scraper isn't running, `/search` returns **502** with a message telling
you how to start it — don't confuse that with a 500 from the Node server
itself.

## Endpoints

### `POST /search`

Free-text car request → 5 ranked, tappable cards.

**Request**

```json
{ "query": "F-150 Raptor, 2017+, under 35k, near Eatontown NJ" }
```

- `400` if `query` is missing/empty.
- `502` if the scraper service is unreachable or errors — the error message
  says how to start it.

**Response**

```json
{
  "params": {
    "make": "ford",
    "model": "f_150",
    "zip": "07724",
    "year_min": 2017,
    "year_max": null,
    "max_price": 35000,
    "min_price": null
  },
  "search_url": "https://www.cars.com/shopping/results/?stock_type=used&zip=07724&maximum_distance=100&page=1&page_size=50&makes%5B%5D=ford&models%5B%5D=ford-f_150&list_price_max=35000&year_min=2017",
  "median": 33000,
  "cards": [
    {
      "id": "9921eab7-18ae-431a-8b00-6aca193a7f09",
      "year": 2018,
      "make": "Ford",
      "model": "F-150",
      "trim": "Raptor",
      "price": 34489,
      "miles": 105075,
      "dealer": "DCH Kay Honda",
      "city": "Eatontown, NJ 07724",
      "phone": "(848) 208-3511",
      "badge": {
        "label": "🔥 most negotiable",
        "reasons": [
          "3 price drops totaling $1,001",
          "on the lot 31+ days",
          "$1,489 over market median"
        ]
      },
      "reasons": [
        "3 price drops totaling $1,001",
        "on the lot 31+ days",
        "$1,489 over market median"
      ],
      "negotiability": {
        "priceDrops": 3,
        "totalDrop": 1001,
        "daysListed": 31,
        "marketDelta": 1489
      }
    }
  ]
}
```

- `make`/`model` in `params` are cars.com slug style (lowercase, multi-word
  joined with underscores — e.g. `f_150`, `model_3`) because the LLM
  extraction step produces search filters directly, not display text.
- `median` is the comp-price median **only when backed by enough priced
  comps** (>=5); otherwise it's `null` and each card's negotiation target
  falls back to a flat discount off asking (`defaultTarget`, ~9% off).
- `cards` is capped at 5, already sorted best-negotiability-first. Only
  `cards[0]` carries `badge`; every card carries its own `reasons`.
- No-haggle dealers (CarMax, Carvana, Vroom, EchoPark, Enterprise Car Sales,
  Hertz Car Sales, Shift) and listings with no price are filtered out before
  ranking — they never appear as cards.
- Every card returned here is cached server-side (`packetCache`, keyed by
  `id`) so `POST /negotiate {listingId}` doesn't need to re-scrape.

#### `CardView` fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | cars.com listing UUID — pass this as `listingId` to `/negotiate` |
| `year` | number | |
| `make` / `model` | string | display case (e.g. `"Ford"` / `"F-150"`), not the slug used in `params` |
| `trim` | string? | omitted if unknown |
| `price` | number | current asking price, USD |
| `miles` | number | odometer |
| `dealer` | string | seller/dealer name |
| `city` | string? | seller address as scraped, e.g. `"Eatontown, NJ 07724"` |
| `phone` | string | dealer phone as scraped (not guaranteed E.164) |
| `badge` | `{label, reasons}`? | present only on the #1 ranked card |
| `reasons` | string[] | plain-English true facts backing the negotiability score, e.g. `"3 price drops totaling $1,001"`. Empty array if nothing scraped for this listing. |
| `negotiability` | object | raw numbers behind `reasons`, for a UI that wants its own copy: `{priceDrops, totalDrop, daysListed, marketDelta}`. `daysListed`/`marketDelta` are `null` when unknown. |

### `POST /negotiate`

Starts a live Vapi call. Two ways to call it:

**New flow — by listing id (preferred):**

```json
{
  "listingId": "9921eab7-18ae-431a-8b00-6aca193a7f09",
  "clientName": "Gabe",
  "dealerPhone": "+15555550123"
}
```

- `listingId` must be a card id returned from a **recent** `/search` call
  (packets live in an in-memory cache, not persisted). `404` with
  `{"error": "unknown listingId — run /search first"}` if it's missing or the
  server restarted since.
- `clientName` optional, defaults to `"Gabe"`. This is who the agent says
  it's calling on behalf of — spoken in the call, not just a label.
- `dealerPhone` optional. **Volunteer-demo override:** pass a different
  number here (e.g. a volunteer's cell) to route the call to them instead of
  the real dealer, for the "you be the dealer" bit. Falls back to the
  listing's scraped dealer phone if omitted.

**Legacy flow — by full car object (still supported):**

```json
{
  "car": {
    "year": 2018, "make": "Ford", "model": "F-150",
    "miles": 105075, "price": 34489,
    "dealer": "DCH Kay Honda", "phone": "(848) 208-3511",
    "target": 32000
  },
  "dealerPhone": "+15555550123"
}
```

Used by `/ingest`'s paste-a-URL path, or any caller that already built a full
`Car` object itself. `car.target` should already be set (both `/ingest` and
`/search` compute it); if you build one by hand and skip it, `negotiate.ts`
still fills it with `defaultTarget(price)` as a safety net.

- `400` if neither `listingId` nor `car` is present.
- `500` if the Vapi call fails to start (missing env vars, bad phone number,
  etc.) — message is the raw error.

**Response** (both flows)

```json
{
  "callId": "8f14e45f-ceea-467e-9c25-0e598cee7dd8",
  "car": { "...": "the full Car packet used for the call" }
}
```

### `POST /ingest` (legacy, unchanged)

```json
{ "url": "https://www.cars.com/vehicledetail/9921eab7-18ae-431a-8b00-6aca193a7f09/" }
```

Scrapes one listing via Apify, enriches it into a `Car` with OpenAI, returns
the `Car`. Feed the result straight into `POST /negotiate {car}`. `400` if
`url` is missing. Falls back to a canned demo car (`FALLBACK_CAR`, a 2019
Camry) if `APIFY_TOKEN`/`APIFY_ACTOR_ID`/`OPENAI_API_KEY` aren't configured.

### `GET /health`

```json
{
  "ok": true,
  "vapi": true,
  "vapiPhone": true,
  "apify": false,
  "openai": true,
  "publicDomain": "https://lowball.ngrok.app",
  "scraper": "http://localhost:8090"
}
```

`scraper` is just the configured `SCRAPER_URL` (or the default) — this
doesn't ping it, it's a config echo so you can eyeball what the server thinks
it should hit.

## `WS /dashboard`

Connect to `ws://<server>/dashboard`. Every message is `{"type": ..., ...}`
JSON, fanned out to every connected client (`server/src/dashboard.ts`). Event
catalog, from `server/src/webhook.ts` (Vapi webhook → broadcast) and
`negotiate.ts` (call start):

| `type` | Shape | When |
|---|---|---|
| `hello` | `{type: "hello", clients: number}` | Sent once, immediately on connect. `clients` is the current connected-dashboard count. |
| `call-started` | `{type: "call-started", callId: string \| undefined, car: Car}` | `startNegotiation` fires this right after creating the Vapi call — before the phone even rings. |
| `transcript` | `{type: "transcript", role: string, text: string, final: boolean}` | Live captions. `role` is `"assistant"` or `"user"` (the dealer). `final: false` messages are partial/interim and get superseded by a `final: true` one for the same turn. |
| `offer` | `{type: "offer", price: number}` | Fired every time the agent calls the `log_offer` tool — i.e. any time the dealer names a price. Drives the live price ticker. |
| `deal` | `{type: "deal", price: number}` | Fired when the agent calls `accept_offer`. Comes before `call-ended`. |
| `call-ended` | `{type: "call-ended", outcome: "deal" \| "no_deal", price?: number}` | Fired when the agent calls `end_call`, just before it hangs up. |
| `status` | `{type: "status", status: string}` | Raw Vapi call status updates (e.g. `"in-progress"`, `"ended"`). |
| `report` | `{type: "report", summary: string, endedReason: string}` | Vapi's end-of-call report, arrives after the call actually disconnects. |

## `clientName` plumbing

`clientName` flows: optional field on `POST /negotiate` → defaults to
`"Gabe"` if omitted → stamped onto the `Car` packet → `buildAssistant` reads
`car.clientName` and has the agent introduce itself as calling "on behalf of
{clientName}" in the first line of the call, and refers to them by name
throughout the negotiation (e.g. "Gabe can do thirty two thousand dollars
with a deposit today..."). There's no separate `/search`-time client name —
it's only asked for at the point a call actually starts, so the same search
results can be reused for different clients.
