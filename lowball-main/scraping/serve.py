"""Long-lived HTTP service wrapping the cars.com scraper.

The Node server (a separate process) hits this for live search + listing
lookups. We keep ONE warm, headful browser context open for the whole
process lifetime: Cloudflare re-challenges brand-new contexts, so a warm
session is what makes repeat searches ~1.4s instead of a fresh handshake.
A single asyncio.Semaphore(3) guards every page fetch (search or detail) so
we never open more than a few tabs against cars.com at once, and the
existing file cache (12h listings / 30min searches) is checked first on
every path — a fetch we skip is both latency saved and IP reputation kept.

Run:
    python3 -m scraping.serve
    python3 -m uvicorn scraping.serve:app --port 8090 --loop asyncio

Playwright's async driver is NOT compatible with uvloop (a documented
Playwright limitation — its pipe transport to the driver subprocess breaks
under uvloop, surfacing as bogus DNS errors like ERR_NAME_NOT_RESOLVED).
`uvicorn[standard]` auto-selects uvloop when it's importable, so the bare
`python3 -m uvicorn ...` invocation MUST pass `--loop asyncio`; the
`__main__` block below does this for you. lifespan startup below fails fast
with a clear error if it detects uvloop anyway.
"""

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from scraping.carscom import cache
from scraping.carscom.browser import browser_context, fetch_html
from scraping.carscom.detail import parse_detail
from scraping.carscom.search import build_search_url, median_price, parse_search_results

PORT = int(os.environ.get("SCRAPER_PORT", 8090))
FETCH_CONCURRENCY = 3
DETAIL_BASE = "https://www.cars.com/vehicledetail/{}/"

# Holds the warm context + semaphore for the process lifetime. A plain dict
# (rather than globals) so the lifespan block below can populate/clear it.
_state: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    if type(asyncio.get_event_loop()).__module__.startswith("uvloop"):
        raise RuntimeError(
            "Playwright cannot run under uvloop. Start with "
            "`python3 -m scraping.serve` or add `--loop asyncio` to the "
            "uvicorn CLI invocation."
        )
    async with browser_context() as ctx:
        _state["ctx"] = ctx
        _state["sem"] = asyncio.Semaphore(FETCH_CONCURRENCY)
        yield
    _state.clear()


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


async def _fetch(url: str) -> str | None:
    """Fetch one URL against the shared warm context, semaphore-bounded."""
    async with _state["sem"]:
        try:
            return await fetch_html(_state["ctx"], url)
        except Exception:
            return None


def _is_valid_listing(listing: dict | None) -> bool:
    return bool(listing and listing.get("id") and listing.get("price"))


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "browser": "warm" if "ctx" in _state else "cold"}


@app.get("/search")
async def search(
    make: str | None = None,
    model: str | None = None,
    zip: str = "10001",
    year_min: int | None = None,
    year_max: int | None = None,
    max_price: int | None = None,
    min_price: int | None = None,
    max_distance: int = 100,
):
    url = build_search_url(
        make=make,
        model=model,
        zip_code=zip,
        max_price=max_price,
        min_price=min_price,
        year_min=year_min,
        year_max=year_max,
        max_distance=max_distance,
    )
    cards = cache.get_search(url)
    if cards is None:
        html = await _fetch(url)
        if html is None:
            return JSONResponse(status_code=502, content={"error": "search fetch failed"})
        cards = parse_search_results(html)
        cache.put_search(url, cards)
    return {"search_url": url, "median": median_price(cards), "cards": cards}


@app.get("/listing/{listing_id}")
async def listing(listing_id: str):
    hit = cache.get_listing(listing_id)
    if hit:
        return hit
    url = DETAIL_BASE.format(listing_id)
    html = await _fetch(url)
    parsed = parse_detail(html, url) if html else None
    if not _is_valid_listing(parsed):
        return JSONResponse(
            status_code=404, content={"error": f"listing {listing_id} not found"}
        )
    cache.put_listing(parsed)
    return parsed


class BatchRequest(BaseModel):
    ids: list[str]


@app.post("/listings/batch")
async def listings_batch(body: BatchRequest):
    ids = body.ids[:12]
    listings: list[dict] = []
    failures: list[str] = []
    to_fetch: list[str] = []
    for lid in ids:
        hit = cache.get_listing(lid)
        if hit:
            listings.append(hit)
        else:
            to_fetch.append(lid)

    async def one(lid: str) -> None:
        url = DETAIL_BASE.format(lid)
        html = await _fetch(url)
        parsed = parse_detail(html, url) if html else None
        if not _is_valid_listing(parsed):
            failures.append(lid)
            return
        cache.put_listing(parsed)
        listings.append(parsed)

    await asyncio.gather(*(one(lid) for lid in to_fetch))
    return {"listings": listings, "failures": failures}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("scraping.serve:app", host="0.0.0.0", port=PORT, loop="asyncio")
