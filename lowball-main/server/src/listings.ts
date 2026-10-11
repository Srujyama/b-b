import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultTarget, type Car, type PricePoint } from "./types.js";

// Gabe's scraper schema (scraping/README.md) — everything arrives as strings.
type RawListing = {
  id: string;
  url: string;
  make: string;
  model: string;
  year: string;
  trim?: string;
  price: string;
  mileage: string;
  price_changes?: string; // JSON string: [{date:"07/16/26", price:"$19,379"}, ...] newest first
  seller_name: string;
  seller_address?: string;
  seller_phone_number?: string;
  price_badge?: string;
  photos?: string; // JSON-encoded array of image URLs
};

const DATA_DIR =
  process.env.DATA_DIR ?? fileURLToPath(new URL("../../data", import.meta.url));

export function loadListings(): RawListing[] {
  const dir = join(DATA_DIR, "listings");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const listings: RawListing[] = [];
  for (const f of files) {
    try {
      listings.push(JSON.parse(readFileSync(join(dir, f), "utf8")));
    } catch (err) {
      console.warn(`skipping unparseable listing ${f}: ${(err as Error).message}`);
    }
  }
  return listings;
}

// `photos` arrives as a JSON-encoded array of URLs (scraper detail schema).
export function firstPhoto(raw?: string): string | undefined {
  if (!raw) return undefined;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && typeof arr[0] === "string" ? arr[0] : undefined;
  } catch {
    return undefined;
  }
}

function parsePriceHistory(raw?: string): PricePoint[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as { date: string; price: string }[];
    return arr
      .map((p) => ({ date: p.date, price: Number(String(p.price).replace(/[^0-9]/g, "")) }))
      .filter((p) => p.price > 0);
  } catch {
    return [];
  }
}

function toE164(raw?: string): string {
  const digits = (raw ?? "").replace(/[^0-9]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

function median(nums: number[]): number | undefined {
  if (!nums.length) return undefined;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// Median asking price of same make+model across the dataset — the market comp
// the assistant anchors against.
function marketMedianFor(listing: RawListing, all: RawListing[]): number | undefined {
  const comps = all.filter(
    (l) =>
      l.make.toLowerCase() === listing.make.toLowerCase() &&
      l.model.toLowerCase() === listing.model.toLowerCase(),
  );
  if (comps.length < 3) return undefined;
  return median(comps.map((l) => Number(l.price)).filter((p) => p > 0));
}

export function toCar(listing: RawListing, all: RawListing[]): Car {
  const price = Number(listing.price) || 0;
  const priceHistory = parsePriceHistory(listing.price_changes); // newest first
  const priceDrops = priceHistory.filter((p, i) => i + 1 < priceHistory.length && p.price < priceHistory[i + 1].price).length;
  const peak = priceHistory.length ? Math.max(...priceHistory.map((p) => p.price)) : 0;
  const marketMedian = marketMedianFor(listing, all);
  return {
    year: Number(listing.year) || 0,
    make: listing.make,
    model: listing.model,
    trim: listing.trim || undefined,
    miles: Number(listing.mileage) || 0,
    price,
    dealer: listing.seller_name,
    phone: toE164(listing.seller_phone_number),
    target: defaultTarget(price),
    priceHistory,
    priceDrops,
    totalDrop: peak > price ? peak - price : 0,
    marketMedian: marketMedian ?? null,
    marketDelta: marketMedian != null ? price - marketMedian : null,
  };
}

export function getCar(id: string): Car | undefined {
  const all = loadListings();
  const listing = all.find((l) => l.id === id);
  return listing && toCar(listing, all);
}

// Compact shape for the dashboard picker + the web browse view.
export function listListings() {
  const all = loadListings();
  return all.map((l) => {
    const car = toCar(l, all);
    const history = parsePriceHistory(l.price_changes);
    return {
      id: l.id,
      title: `${l.year} ${l.make} ${l.model}${l.trim ? ` ${l.trim}` : ""}`,
      year: car.year,
      make: car.make,
      model: car.model,
      trim: car.trim,
      price: car.price,
      miles: car.miles,
      dealer: car.dealer,
      location: l.seller_address ?? "",
      phone: car.phone,
      badge: l.price_badge || null,
      priceCuts: Math.max(0, history.length - 1),
      priceDrops: car.priceDrops ?? 0,
      totalDrop: car.totalDrop ?? 0,
      marketDelta: car.marketDelta ?? null,
      target: car.target,
      photo: firstPhoto(l.photos),
      url: l.url,
    };
  });
}
