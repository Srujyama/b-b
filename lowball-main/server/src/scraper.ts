// Thin typed client for the Python scraper HTTP service (scraping/serve.py).
const TIMEOUT_MS = 60_000;

export type ScraperSearchCard = {
  id: string;
  url: string;
  price: number | null;
  title: string | null;
  year: number | null;
  dealer: string | null;
};

export type ScraperSearchResult = {
  search_url: string;
  median: number | null;
  cards: ScraperSearchCard[];
};

export type ScraperSearchParams = {
  make?: string | null;
  model?: string | null;
  zip?: string | null;
  year_min?: number | null;
  year_max?: number | null;
  max_price?: number | null;
  min_price?: number | null;
  max_distance?: number | null;
};

// Raw parsed listing shape as returned by GET /listing/:id (matches data/listings/*.json).
export type RawListing = {
  url?: string;
  make: string;
  model: string;
  id: string;
  vin?: string;
  year: string;
  sellers_note?: string;
  price: string;
  mileage: string;
  stock_number?: string;
  engine?: string;
  transmission?: string;
  fuel?: string;
  drive_train?: string;
  exterior_color?: string;
  interior_color?: string;
  price_changes?: string;
  seller_name: string;
  seller_address?: string;
  seller_phone_number?: string;
  features?: string;
  photos?: string;
  seller_type?: string;
  price_badge?: string;
  trim?: string;
  body_style?: string;
  clean_title?: boolean;
  single_owner?: boolean;
};

function baseUrl(): string {
  return process.env.SCRAPER_URL ?? "http://localhost:8090";
}

async function get<T>(path: string): Promise<T> {
  const url = `${baseUrl()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`scraper request failed: ${res.status} ${res.statusText} (${url})`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`scraper request timed out after ${TIMEOUT_MS / 1000}s (${url})`);
    }
    if (err instanceof TypeError) {
      throw new Error(
        `scraper service not running — start it with: python3 -m scraping.serve (tried ${url})`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const url = `${baseUrl()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`scraper request failed: ${res.status} ${res.statusText} (${url})`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`scraper request timed out after ${TIMEOUT_MS / 1000}s (${url})`);
    }
    if (err instanceof TypeError) {
      throw new Error(
        `scraper service not running — start it with: python3 -m scraping.serve (tried ${url})`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function scraperSearch(params: ScraperSearchParams): Promise<ScraperSearchResult> {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") qs.set(key, String(value));
  }
  return get<ScraperSearchResult>(`/search?${qs.toString()}`);
}

export async function scraperGetListing(id: string): Promise<RawListing> {
  return get<RawListing>(`/listing/${id}`);
}

export async function scraperGetListingsBatch(
  ids: string[],
): Promise<{ listings: RawListing[]; failures: string[] }> {
  return post<{ listings: RawListing[]; failures: string[] }>("/listings/batch", { ids });
}
