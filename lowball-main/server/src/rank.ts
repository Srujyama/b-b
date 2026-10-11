import type { Car } from "./types.js";
import type { ScraperSearchCard } from "./scraper.js";

// No-haggle chains kill the call by policy — name-match on seller/dealer.
export const NO_HAGGLE = [
  /carmax/i,
  /carvana/i,
  /vroom/i,
  /echo\s*park/i,
  /enterprise car sales/i,
  /hertz car sales/i,
  /\bshift\b/i,
];

export function isNoHaggle(dealer: string | null | undefined): boolean {
  if (!dealer) return false;
  return NO_HAGGLE.some((re) => re.test(dealer));
}

export type RankedCard = { card: ScraperSearchCard; car: Car | undefined; score: number };

// Rank by negotiability: price-drop count/total, days on market, price vs comp median.
// Falls back to score 0 for facts a card's details couldn't be scraped.
export function rankCards(
  cards: ScraperSearchCard[],
  details: Map<string, Car>,
  median: number | null,
): RankedCard[] {
  const ranked = cards.map((card) => {
    const car = details.get(card.id);
    const priceDrops = car?.priceDrops ?? 0;
    const daysListed = car?.daysListed ?? 0;
    const marketDelta = car?.marketDelta ?? (median != null && card.price != null ? card.price - median : 0);
    const score = 2 * priceDrops + Math.min(daysListed, 60) / 10 + Math.max(0, marketDelta) / 500;
    return { card, car, score };
  });
  return ranked.sort((a, b) => b.score - a.score);
}

// Raw true facts only — no pre-written leverage phrasing, just what's demonstrably true.
export function buildBadgeReasons(car: Car): string[] {
  const reasons: string[] = [];
  if (car.priceDrops && car.priceDrops > 0 && car.totalDrop) {
    const noun = car.priceDrops === 1 ? "price drop" : "price drops";
    reasons.push(`${car.priceDrops} ${noun} totaling $${car.totalDrop.toLocaleString()}`);
  }
  if (car.daysListed != null) {
    reasons.push(`on the lot ${car.daysListed}+ days`);
  }
  if (car.marketDelta != null && car.marketDelta > 0) {
    reasons.push(`$${Math.round(car.marketDelta).toLocaleString()} over market median`);
  }
  return reasons;
}
