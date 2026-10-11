"""File cache in data/ — never fetch the same thing twice.

Cars.com rate-limits aggressively (Cloudflare challenges kick in after
bursts), so every fetch we skip is both latency saved and IP reputation
preserved. Layout:

    data/listings/<id>.json        parsed detail pages (the dataset IS the cache)
    data/cache/searches/<key>.json search-result cards per query URL

Listings barely change hour-to-hour -> 12h TTL. Inventory shifts faster
-> 30min TTL for searches. TTLs are mtime-based; delete a file to force
a refetch.
"""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
LISTINGS_DIR = DATA_DIR / "listings"
SEARCHES_DIR = DATA_DIR / "cache" / "searches"

LISTING_TTL_S = 12 * 3600
SEARCH_TTL_S = 30 * 60


def _fresh(path: Path, max_age_s: float) -> bool:
    return path.exists() and (time.time() - path.stat().st_mtime) < max_age_s


def get_listing(listing_id: str) -> dict | None:
    path = LISTINGS_DIR / f"{listing_id}.json"
    if _fresh(path, LISTING_TTL_S):
        return json.loads(path.read_text())
    return None


def put_listing(listing: dict) -> None:
    LISTINGS_DIR.mkdir(parents=True, exist_ok=True)
    (LISTINGS_DIR / f"{listing['id']}.json").write_text(
        json.dumps(listing, indent=2, ensure_ascii=False)
    )


def _search_key(url: str) -> str:
    return hashlib.sha1(url.encode()).hexdigest()[:16]


def get_search(url: str) -> list[dict] | None:
    path = SEARCHES_DIR / f"{_search_key(url)}.json"
    if _fresh(path, SEARCH_TTL_S):
        return json.loads(path.read_text())["cards"]
    return None


def put_search(url: str, cards: list[dict]) -> None:
    SEARCHES_DIR.mkdir(parents=True, exist_ok=True)
    (SEARCHES_DIR / f"{_search_key(url)}.json").write_text(
        json.dumps({"url": url, "cached_at": time.time(), "cards": cards}, indent=2)
    )
