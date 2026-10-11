# scraping/ — cars.com listing scraper

Playwright-based scraper that turns a car query into structured listings
with **dealer phone numbers**, ready for the negotiator bot.

## Layout

```
scraping/
  carscom/
    browser.py   # shared headful-Chrome context (passes Cloudflare)
    search.py    # query -> search URL -> listing cards (+ median price)
    detail.py    # vehicle-detail page HTML -> listing JSON schema
  collect.py     # CLI: run queries, scrape N listings into data/
```

## Setup

```bash
pip install playwright
python3 -m playwright install chromium   # or have Google Chrome installed
```

## Usage

```bash
# 50 listings across the default 5-model mix, near zip 10001
python3 -m scraping.collect --total 50 --zip 10001

# one specific query
python3 -m scraping.collect --make toyota --model camry --max-price 20000 --total 10
```

Outputs:

- `data/listings/<id>.json` — one file per listing
- `data/listings.json` — combined array
- `data/collection_report.json` — per-query median prices + latency stats

## Listing schema

Matches the agreed schema (`url, make, model, id, vin, year, sellers_note,
price, mileage, stock_number, engine, transmission, fuel, drive_train,
exterior_color, interior_color, price_changes, seller_name, seller_address,
seller_phone_number, features, photos`) plus negotiation-useful extras:
`seller_type, price_badge, trim, body_style, clean_title, single_owner`.

`price_changes` is real price history scraped from the VDP's price-history
table — gold for the negotiator ("you've dropped it three times already…").

## Caching — never fetch twice

`carscom/cache.py` backs every fetch with files in `data/`:

- `data/listings/<id>.json` — parsed details, 12h TTL. The dataset IS the
  cache: any listing already scraped is reused for free.
- `data/cache/searches/<key>.json` — search cards per query URL, 30min TTL.

Listings are saved the moment they parse (not at end-of-run), so a
crashed run keeps everything it scraped. A fully-cached query answers in
~4s (browser startup only, zero network). This also protects our IP:
Cloudflare escalates challenges after fetch bursts.

## Median price

Two ways, both free:

1. **Market median** — `search.median_price(cards)` over one search page
   (~50 comparable cars near the zip), computed at collect time and stored
   in `collection_report.json` per query.
2. **Cars.com's own judgment** — each listing's `price_badge`
   ("great_deal" / "good_deal" / …) reflects their internal market pricing.

## Known limitations

- **Headful Chrome required.** Cloudflare serves headless browsers (even
  `channel=chrome`) an empty shell. Headful passes instantly. Windows
  briefly open during a collection run.
- `seller_address` is city/state/zip (street number renders in a shadow
  component; not worth the effort — the phone number is the contact path).
- ~5% of detail fetches fail transiently; `collect.py` over-collects
  candidates to compensate and logs failures in the report.
- Latency (measured, 50-listing run, concurrency 4): ~4.6s mean / 3.9s
  median / 8.7s p95 per detail page; 96s wall-clock for 5 searches + 50
  details.
