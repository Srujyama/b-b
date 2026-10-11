// Assertions over the real scraped dataset: loading, Car mapping, intel.
// Run: npx tsx scripts/test-listings.ts
import assert from "node:assert/strict";
import { loadListings, listListings, toCar, getCar } from "../src/listings.js";
import { buildAssistant } from "../src/assistant.js";

const raw = loadListings();
assert.ok(raw.length >= 50, `expected >=50 listings, got ${raw.length}`);

const summaries = listListings();
assert.equal(summaries.length, raw.length);
for (const s of summaries) {
  assert.ok(s.id && s.title && s.price > 0, `bad summary: ${JSON.stringify(s)}`);
  assert.match(s.phone, /^\+1\d{10}$/, `phone not E.164: ${s.phone} (${s.title})`);
}

const cars = raw.map((l) => toCar(l, raw));
for (const c of cars) {
  assert.ok(c.year > 2000 && c.miles > 0 && c.price > 0, JSON.stringify(c));
  assert.ok(c.target > 0 && c.target < c.price, `target ${c.target} vs price ${c.price}`);
}
assert.ok(
  cars.filter((c) => (c.priceHistory?.length ?? 0) >= 2).length >= 25,
  "expected roughly half the cars to carry real price cuts",
);
assert.ok(
  cars.filter((c) => c.marketMedian).length >= 40,
  "expected market medians for the 4 main models",
);

// getCar round-trip + prompt uses the intel
const netDrop = (c: (typeof cars)[number]) => {
  const h = c.priceHistory ?? [];
  return h.length >= 2 && h[0].price < h[h.length - 1].price;
};
const withHistory = raw.find((l) => {
  const c = toCar(l, raw);
  return netDrop(c) && c.marketMedian && c.marketMedian < c.price;
});
assert.ok(withHistory, "no listing with both history and below-asking median");
const car = getCar(withHistory.id)!;
assert.ok(car);
const prompt = (buildAssistant(car).model.messages[0] as { content: string }).content;
assert.ok(prompt.includes("PRICE HISTORY"), "prompt missing PRICE HISTORY section");
assert.ok(prompt.includes("median asking price"), "prompt missing MARKET section");
assert.ok(prompt.includes(car.marketMedian!.toLocaleString()), "anchor missing median comp");

// a car whose price went UP must not get the "they cut the price" leverage line
const raised = cars.find((c) => {
  const h = c.priceHistory ?? [];
  return h.length >= 2 && h[0].price > h[h.length - 1].price;
});
if (raised) {
  const p = (buildAssistant(raised).model.messages[0] as { content: string }).content;
  assert.ok(!p.includes("PRICE HISTORY"), "raised-price car wrongly got the price-cut leverage");
}

// unknown id
assert.equal(getCar("nope"), undefined);

console.log(`ok — ${raw.length} listings, ${cars.filter((c) => (c.priceHistory?.length ?? 0) >= 2).length} with price history, ${cars.filter((c) => c.marketMedian).length} with market median`);
