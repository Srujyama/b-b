export type PriceHistoryEntry = { date: string; price: number };
// Alias used by listings.ts (scraper-dataset loader) — same shape.
export type PricePoint = PriceHistoryEntry;

export type CompCard = { year: number; price: number; dealer: string; distanceMi?: number };

export type Car = {
  // identity — kept required so existing code (ingest.ts, negotiate.ts) still compiles
  year: number;
  make: string;
  model: string;
  miles: number;
  price: number;
  dealer: string;
  phone: string;
  target: number;

  // identity extras
  trim?: string;
  vin?: string;
  city?: string;

  // raw leverage facts (from listing scrape)
  priceHistory?: PriceHistoryEntry[];
  priceDrops?: number;
  totalDrop?: number;
  daysListed?: number;
  milesPerYear?: number;

  // market context
  marketMedian?: number | null;
  marketDelta?: number | null;
  comps?: CompCard[];

  // ladder
  opening?: number;

  // client
  clientName?: string;
};

export function defaultTarget(price: number): number {
  return Math.round((price * 0.91) / 100) * 100;
}
