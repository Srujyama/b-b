import OpenAI from "openai";
import { scraperSearch, scraperGetListingsBatch, type ScraperSearchCard } from "./scraper.js";
import { buildPacket } from "./packet.js";
import { rankCards, isNoHaggle, buildBadgeReasons } from "./rank.js";
import { loadListings, toCar, firstPhoto } from "./listings.js";
import type { Car, CompCard } from "./types.js";

// Built packets from the last /search, keyed by listing id, so /negotiate can
// reuse them without re-scraping.
export const packetCache = new Map<string, Car>();

export type CardView = {
  id: string;
  year: number;
  make: string;
  model: string;
  trim?: string;
  price: number;
  miles: number;
  dealer: string;
  city?: string;
  phone: string;
  badge?: { label: string; reasons: string[] };
  photo?: string;
  url?: string;
  reasons: string[];
  negotiability: {
    priceDrops: number;
    totalDrop: number;
    daysListed: number | null;
    marketDelta: number | null;
  };
};

export type ExtractedParams = {
  make: string | null;
  model: string | null;
  zip: string | null;
  year_min: number | null;
  year_max: number | null;
  max_price: number | null;
  min_price: number | null;
};

export type SearchResult = {
  params: ExtractedParams;
  search_url: string;
  median: number | null;
  cards: CardView[];
};

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    make: { type: ["string", "null"] },
    model: { type: ["string", "null"] },
    zip: { type: ["string", "null"] },
    year_min: { type: ["number", "null"] },
    year_max: { type: ["number", "null"] },
    max_price: { type: ["number", "null"] },
    min_price: { type: ["number", "null"] },
  },
  required: ["make", "model", "zip", "year_min", "year_max", "max_price", "min_price"],
  additionalProperties: false,
};

async function extractParams(query: string): Promise<ExtractedParams> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set in server/.env");
  const openai = new OpenAI({ apiKey });
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: {
      type: "json_schema",
      json_schema: { name: "car_search_params", strict: true, schema: EXTRACT_SCHEMA },
    },
    messages: [
      {
        role: "system",
        content:
          "Extract used-car search filters from a free-text request. Return make, model, zip, year_min, year_max, max_price, min_price. " +
          "A zip code is REQUIRED in the output — if a city, state, or region is mentioned, output a plausible real US zip for it " +
          "(you know US zip codes); default to 10001 only if the text gives no location at all. " +
          'Lowercase make/model and join multi-word names with underscores, cars.com slug style (e.g. "F-150" -> "f_150", "Model 3" -> "model_3"). ' +
          "Use null for any field absent from the text (zip is the only field that may never be null).",
      },
      { role: "user", content: query },
    ],
  });
  return JSON.parse(res.choices[0]?.message?.content ?? "{}");
}

function toCompCard(card: ScraperSearchCard): CompCard | null {
  if (card.price == null || card.year == null || !card.dealer) return null;
  return { year: card.year, price: card.price, dealer: card.dealer };
}

export async function handleSearch(query: string): Promise<SearchResult> {
  const params = await extractParams(query);
  try {
    return await scraperBackedSearch(params);
  } catch (err) {
    // Live scraper down or not deployed — serve from the bundled dataset so
    // search keeps working in production without the Python sidecar.
    console.warn(`scraper unavailable, using disk dataset: ${(err as Error).message}`);
    return datasetSearch(params);
  }
}

// cars.com slug style used by extractParams ("F-150" -> "f_150") applied to
// dataset values ("Honda", "Civic") so both sides compare equal.
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function datasetSearch(params: ExtractedParams): SearchResult {
  const all = loadListings();
  const matches = all.filter((l) => {
    if (params.make && slugify(l.make) !== params.make) return false;
    if (params.model && slugify(l.model) !== params.model) return false;
    const year = Number(l.year) || 0;
    if (params.year_min != null && year && year < params.year_min) return false;
    if (params.year_max != null && year && year > params.year_max) return false;
    const price = Number(l.price) || 0;
    if (params.max_price != null && price && price > params.max_price) return false;
    if (params.min_price != null && price && price < params.min_price) return false;
    return !isNoHaggle(l.seller_name);
  });

  const prices = matches.map((l) => Number(l.price)).filter((p) => p > 0).sort((a, b) => a - b);
  const median = prices.length >= 5 ? prices[Math.floor(prices.length / 2)] : null;

  const scored = matches
    .map((listing) => ({ listing, car: toCar(listing, all) }))
    .sort((a, b) => {
      const score = (c: Car) =>
        (c.priceDrops ?? 0) * 2 +
        ((c.totalDrop ?? 0) > 0 ? 1 : 0) +
        (c.marketDelta != null && c.marketDelta < 0 ? 1 : 0);
      return score(b.car) - score(a.car);
    })
    .slice(0, 5);

  const cards: CardView[] = scored.map(({ listing, car }, i) => {
    packetCache.set(listing.id, car);
    const reasons = buildBadgeReasons(car);
    return {
      id: listing.id,
      year: car.year,
      make: car.make,
      model: car.model,
      trim: car.trim,
      price: car.price,
      miles: car.miles,
      dealer: car.dealer,
      city: listing.seller_address || undefined,
      phone: car.phone,
      photo: firstPhoto(listing.photos),
      url: listing.url,
      badge: i === 0 ? { label: "🔥 most negotiable", reasons } : undefined,
      reasons,
      negotiability: {
        priceDrops: car.priceDrops ?? 0,
        totalDrop: car.totalDrop ?? 0,
        daysListed: car.daysListed ?? null,
        marketDelta: car.marketDelta ?? null,
      },
    };
  });

  return { params, search_url: "dataset://local", median, cards };
}

async function scraperBackedSearch(params: ExtractedParams): Promise<SearchResult> {
  const result = await scraperSearch(params);

  // Median only counts as a real comp median with enough priced cards behind it;
  // otherwise buildPacket falls back to defaultTarget (see packet.ts).
  const pricedCount = result.cards.filter((c) => c.price != null).length;
  const median = pricedCount >= 5 ? result.median : null;

  const candidates = result.cards.filter((c) => c.price != null && !isNoHaggle(c.dealer));
  const top8 = candidates.slice(0, 8);

  const { listings, failures } = await scraperGetListingsBatch(top8.map((c) => c.id));
  const failedIds = new Set(failures);
  const usable = top8.filter((c) => !failedIds.has(c.id));

  const details = new Map<string, Car>();
  const photoById = new Map<string, string>();
  for (const card of usable) {
    const listing = listings.find((l) => l.id === card.id);
    if (!listing) continue;
    const photo = firstPhoto(listing.photos);
    if (photo) photoById.set(card.id, photo);
    // Year-scope median + comps to ±2yr of THIS car (per spec): an unscoped
    // "toyota corolla" search mixed 2014s into a 2024's market, which produced
    // a 23% lowball target and a 2014 cited as a comp on a live call.
    const carYear = Number(listing.year) || card.year || 0;
    const inYearBand = (y: number | null) => y != null && carYear > 0 && Math.abs(y - carYear) <= 2;
    // Model-scope too: a make-only search mixes models ("lamborghini" returned
    // Uruses as comps for a Huracan). Prefer same-model cards, fall back to
    // year-band-only when the model pool is too thin.
    const modelKey = (listing.model || "").trim().toLowerCase().split(/\s+/)[0] || "";
    const sameModel = (t: string | null) => modelKey.length > 1 && t != null && t.toLowerCase().includes(modelKey);
    const bandPrices = (requireModel: boolean) =>
      candidates
        .filter((c) => c.price != null && inYearBand(c.year) && (!requireModel || sameModel(c.title)))
        .map((c) => c.price as number)
        .sort((a, b) => a - b);
    const modelPrices = bandPrices(true);
    const yearPrices = bandPrices(false);
    const scopedMedian =
      modelPrices.length >= 5
        ? modelPrices[Math.floor(modelPrices.length / 2)]
        : yearPrices.length >= 5
          ? yearPrices[Math.floor(yearPrices.length / 2)]
          : median;
    // Only cheaper cars work as BATNA leverage — an alternative above asking is no alternative.
    const compPool = usable.filter(
      (c) => c.id !== card.id && inYearBand(c.year) && c.price != null && c.price < (card.price ?? Infinity),
    );
    const comps = [...compPool.filter((c) => sameModel(c.title)), ...compPool.filter((c) => !sameModel(c.title))]
      .map(toCompCard)
      .filter((c): c is CompCard => c !== null);
    const car = buildPacket(listing, { median: scopedMedian, comps });
    details.set(card.id, car);
    packetCache.set(card.id, car);
  }

  const ranked = rankCards(usable, details, median).slice(0, 5);

  const cards: CardView[] = ranked.map(({ card, car }, i) => {
    const reasons = car ? buildBadgeReasons(car) : [];
    return {
      id: card.id,
      year: car?.year ?? card.year ?? 0,
      make: car?.make ?? params.make ?? "",
      model: car?.model ?? params.model ?? "",
      trim: car?.trim,
      price: car?.price ?? card.price ?? 0,
      miles: car?.miles ?? 0,
      dealer: car?.dealer ?? card.dealer ?? "",
      city: car?.city,
      phone: car?.phone ?? "",
      badge: i === 0 ? { label: "🔥 most negotiable", reasons } : undefined,
      photo: photoById.get(card.id),
      url: card.url,
      reasons,
      negotiability: {
        priceDrops: car?.priceDrops ?? 0,
        totalDrop: car?.totalDrop ?? 0,
        daysListed: car?.daysListed ?? null,
        marketDelta: car?.marketDelta ?? null,
      },
    };
  });

  return { params, search_url: result.search_url, median, cards };
}
