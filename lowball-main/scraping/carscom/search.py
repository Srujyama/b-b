"""Search cars.com and collect vehicle-detail URLs (+ card prices).

Search URL format (all params optional except zip):
https://www.cars.com/shopping/results/?stock_type=used&makes[]=toyota
    &models[]=toyota-camry&list_price_max=15000&maximum_distance=100
    &zip=10001&page_size=50&page=1
"""

from __future__ import annotations

import html as html_lib
import re
import statistics
from urllib.parse import urlencode

BASE = "https://www.cars.com/shopping/results/"

# Fallback cap on how far past a card's vehicledetail href we scan for its
# title/dealer text, used only for the last card on the page (no next-card
# boundary to stop at). Cards run ~10-15KB apart on a rendered results page.
_CARD_WINDOW_MAX = 20_000

# The title link carries the year (and make/model/trim) as data- attributes,
# e.g. <a data-card-link="" ... data-year="2019" ...><span>Used 2019 Honda
# Civic EX-L</span></a>. Attribute order is stable but we don't rely on it.
_TITLE_RE = re.compile(
    r'<a data-card-link=""[^>]*data-year="(\d+)"[^>]*>\s*<span[^>]*>\s*([^<]+?)\s*</span>',
    re.S,
)
_TITLE_PREFIX_RE = re.compile(r"^(?:Used|New|Certified(?: Pre-Owned)?)\s+", re.I)

# Dealer name is the first weak-styled span after the title's </h2>; cars.com
# has no data-qa hook for it, so we anchor on the shared CSS var instead.
_DEALER_RE = re.compile(r"</h2>.*?fuse-color-text-weaker[^>]*>([^<]+)</span>", re.S)


def build_search_url(
    make: str | None = None,
    model: str | None = None,
    zip_code: str = "10001",
    max_price: int | None = None,
    min_price: int | None = None,
    year_min: int | None = None,
    year_max: int | None = None,
    max_distance: int = 100,
    stock_type: str = "used",
    page: int = 1,
    page_size: int = 50,
) -> str:
    params: list[tuple[str, str]] = [
        ("stock_type", stock_type),
        ("zip", zip_code),
        ("maximum_distance", str(max_distance)),
        ("page", str(page)),
        ("page_size", str(page_size)),
    ]
    if make:
        params.append(("makes[]", make.lower().replace(" ", "_")))
    if model and make:
        slug = f"{make.lower().replace(' ', '_')}-{model.lower().replace(' ', '_')}"
        params.append(("models[]", slug))
    if max_price:
        params.append(("list_price_max", str(max_price)))
    if min_price:
        params.append(("list_price_min", str(min_price)))
    if year_min:
        params.append(("year_min", str(year_min)))
    if year_max:
        params.append(("year_max", str(year_max)))
    return BASE + "?" + urlencode(params)


def parse_search_results(html: str) -> list[dict]:
    """Extract listing cards: detail URL, id, price, title, year, dealer.

    Cards link to /vehicledetail/<uuid>/ and carry a nearby price element;
    we pair ids with prices/title/dealer by scanning the card container
    blocks. title/year/dealer are best-effort — None if unparseable, and
    collect.py only ever relies on id/url/price so this stays safe either way.
    """
    # First pass: unique (listing_id, start_offset) in document order, so each
    # card's scan window can stop at the *next* card's href instead of a
    # guessed fixed size — card blocks vary in length (badge text, photo
    # counts, etc.) enough that a fixed window either misses fields or risks
    # bleeding into the next card.
    seen: set[str] = set()
    starts: list[tuple[str, int]] = []
    for m in re.finditer(r'href="/vehicledetail/([0-9a-f-]{36})/[^"]*"', html):
        listing_id = m.group(1)
        if listing_id not in seen:
            seen.add(listing_id)
            starts.append((listing_id, m.start()))

    cards: list[dict] = []
    for i, (listing_id, start) in enumerate(starts):
        next_start = starts[i + 1][1] if i + 1 < len(starts) else start + _CARD_WINDOW_MAX
        window = html[start:next_start]
        pm = re.search(r"\$([\d,]+)", window[:4000])

        title = year = dealer = None
        tm = _TITLE_RE.search(window)
        if tm:
            year = int(tm.group(1))
            title = _TITLE_PREFIX_RE.sub("", html_lib.unescape(tm.group(2).strip()))
        dm = _DEALER_RE.search(window)
        if dm:
            dealer = html_lib.unescape(dm.group(1).strip())

        cards.append(
            {
                "id": listing_id,
                "url": f"https://www.cars.com/vehicledetail/{listing_id}/",
                "price": int(pm.group(1).replace(",", "")) if pm else None,
                "title": title,
                "year": year,
                "dealer": dealer,
            }
        )
    return cards


def median_price(cards: list[dict]) -> float | None:
    prices = [c["price"] for c in cards if c.get("price")]
    return statistics.median(prices) if prices else None
