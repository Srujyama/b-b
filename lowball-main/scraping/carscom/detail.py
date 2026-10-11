"""Parse a cars.com vehicle-detail page (VDP) into our listing schema.

Field sources inside the page:
- <script id="initial-activity-data">: vin, listing_id, price, mileage,
  year/make/model/trim, colors, drivetrain, fuel, dealer_name, seller_type.
- <script id="CarsWeb.VehicleDetailController.show">: dealer phone number
  (call_source_dni_metadata.seller.phoneNumber), stock number, features.
- DOM: engine + transmission text (basics list), seller's notes,
  price-history table, photo gallery URLs, seller address.
"""

from __future__ import annotations

import html as html_lib
import json
import re


def _script_json(html: str, script_id: str) -> dict:
    m = re.search(
        r'<script[^>]*id="%s"[^>]*>(.*?)</script>' % re.escape(script_id),
        html,
        re.S,
    )
    if not m:
        return {}
    try:
        return json.loads(m.group(1).strip()) or {}
    except json.JSONDecodeError:
        return {}


def _strip_tags(fragment: str) -> str:
    text = re.sub(r"<[^>]+>", " ", fragment)
    return re.sub(r"\s+", " ", html_lib.unescape(text)).strip()


def _basics(html: str) -> dict[str, str]:
    """The 'Basics' list: '<value> <label>' items, e.g. '... engine engine'."""
    out: dict[str, str] = {}
    for item in re.findall(r'<li data-qa="basics-entry">(.*?)</li>', html, re.S):
        text = _strip_tags(item)
        for label in ("engine", "transmission", "drivetrain", "fuel type",
                      "exterior color", "interior color"):
            if text.lower().endswith(label):
                out[label] = text[: -len(label)].strip()
    return out


def _sellers_note(html: str) -> str:
    m = re.search(
        r"Seller's notes</h2>\s*<cars-line-clamp[^>]*>(.*?)</cars-line-clamp>",
        html,
        re.S,
    )
    return _strip_tags(m.group(1)) if m else ""


def _price_history(html: str) -> list[dict[str, str]]:
    i = html.find("price-history-table")
    if i == -1:
        return []
    rows = re.findall(r"<tr>\s*<td>.*?</tr>", html[i : i + 4000], re.S)
    out = []
    for row in rows:
        cells = [_strip_tags(c) for c in re.findall(r"<td>(.*?)</td>", row, re.S)]
        if len(cells) >= 3:
            out.append({"date": cells[0], "price": cells[2]})
    return out


def _photos(html: str, limit: int = 10) -> list[str]:
    seen: list[str] = []
    for url in re.findall(r'https://[^"\s]+cstatic-images\.com[^"\s]*\.jpg', html):
        url = html_lib.unescape(url)
        if url not in seen and "/stock_photos/" not in url:
            seen.append(url)
        if len(seen) >= limit:
            break
    return seen


def _seller_address(html: str) -> str:
    """Street address shown in the seller section, e.g. '57-15 Northern Blvd'."""
    m = re.search(
        r'>\s*([^<>]{4,60}?)\s*<[^>]*>\s*</?[^>]*>*\s*'
        r"([A-Z][A-Za-z .']+,\s*[A-Z]{2}\s+\d{5})",
        html,
    )
    if m:
        return f"{m.group(1).strip()}, {m.group(2).strip()}"
    m = re.search(r"([A-Z][A-Za-z .']+,\s*[A-Z]{2}\s+\d{5})", html)
    return m.group(1).strip() if m else ""


def parse_detail(html: str, url: str) -> dict:
    """Map a VDP's HTML to the target listing JSON schema."""
    activity = _script_json(html, "initial-activity-data")
    show = _script_json(html, "CarsWeb.VehicleDetailController.show")
    dni = (show.get("call_source_dni_metadata") or {})
    dims = dni.get("dimensions") or {}
    seller = dni.get("seller") or {}
    basics = _basics(html)

    def first(value) -> str:
        return value[0] if isinstance(value, list) and value else (value or "")

    return {
        "url": url,
        "make": activity.get("make") or first(dims.get("make")),
        "model": activity.get("model") or first(dims.get("model")),
        "id": activity.get("listing_id") or dims.get("listingId") or "",
        "vin": activity.get("vin") or dims.get("vin") or "",
        "year": str(activity.get("year") or dims.get("year") or ""),
        "sellers_note": _sellers_note(html),
        "price": str(activity.get("price") or dims.get("price") or ""),
        "mileage": str(activity.get("mileage") or dims.get("mileage") or ""),
        "stock_number": dims.get("stockNumber") or "",
        "engine": basics.get("engine", ""),
        "transmission": basics.get("transmission")
        or first(dims.get("transTypeId")),
        "fuel": activity.get("fuel_type") or basics.get("fuel type", ""),
        "drive_train": activity.get("drivetrain")
        or first(dims.get("drvTrnId")),
        "exterior_color": activity.get("exterior_color")
        or basics.get("exterior color", ""),
        "interior_color": activity.get("interior_color")
        or basics.get("interior color", ""),
        "price_changes": json.dumps(_price_history(html)),
        "seller_name": html_lib.unescape(activity.get("dealer_name") or ""),
        "seller_address": _seller_address(html),
        "seller_phone_number": seller.get("phoneNumber") or "",
        "features": json.dumps(dims.get("normFeatureId") or []),
        "photos": json.dumps(_photos(html)),
        # extras beyond the base schema, useful for the negotiator bot
        "seller_type": activity.get("seller_type") or "",
        "price_badge": activity.get("price_badge") or "",
        "trim": activity.get("trim") or first(dims.get("trim")),
        "body_style": first(dims.get("bodyStyle")),
        "clean_title": activity.get("clean_title"),
        "single_owner": activity.get("single_owner"),
    }
