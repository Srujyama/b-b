// Durable research cache. Two layers, both checked before any Context.dev call:
//   1. runtime: DATA_DIR/research-cache.json (persistedMap), written with every new live result;
//   2. seed:    vellum/server/data/research-cache.json (committed), REAL results captured from earlier live
//               Context.dev runs, each with the sources it was read from. Never hand-written numbers.
// Fair prices are keyed by (hospital, code), charity policies by hospital. Anything served from here is labelled
// with `cache: { via: "context.dev (cached)", fetchedAt }` so the UI and logs can say where it came from.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { persistedMap } from "../persist.js";
import type { CharityPolicy, FairPrice } from "../types.js";

export const CACHED_VIA = "context.dev (cached)";
export type CacheLabel = { via: typeof CACHED_VIA; fetchedAt: string };
export type CachedFairPrice = FairPrice & { cache: CacheLabel };
export type CachedCharity = CharityPolicy & { cache: CacheLabel };

type Entry<T> = { value: T; fetchedAt: string };
type SeedFile = {
  fetchedAt: string;
  fairPrices: { hospital: string; code: string; fairPrice: FairPrice }[];
  charity: { hospital: string; policy: CharityPolicy }[];
};

export const SEED_FILE = fileURLToPath(new URL("../../data/research-cache.json", import.meta.url));

/** "STANFORD HEALTH CARE" / "Stanford Health Care, Inc." -> "stanford health care" */
export function hospitalKey(hospital: string): string {
  return hospital
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(inc|llc|corp|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const priceKey = (hospital: string, code: string) => `price|${hospitalKey(hospital)}|${code.trim().toUpperCase()}`;
const charityKey = (hospital: string) => `charity|${hospitalKey(hospital)}`;

let seed: Map<string, Entry<unknown>> | undefined;
function loadSeed(): Map<string, Entry<unknown>> {
  if (seed) return seed;
  seed = new Map();
  try {
    const f = JSON.parse(readFileSync(SEED_FILE, "utf8")) as SeedFile;
    for (const e of f.fairPrices ?? []) seed.set(priceKey(e.hospital, e.code), { value: e.fairPrice, fetchedAt: f.fetchedAt });
    for (const e of f.charity ?? []) seed.set(charityKey(e.hospital), { value: e.policy, fetchedAt: f.fetchedAt });
  } catch (err) {
    console.error(`[research-cache] could not read seed ${SEED_FILE}: ${(err as Error).message}`);
  }
  return seed;
}

const runtime = persistedMap<Entry<unknown>>("research-cache");

function get<T>(key: string): (T & { cache: CacheLabel }) | undefined {
  const e = runtime.map.get(key) ?? loadSeed().get(key);
  if (!e) return undefined;
  // a deep copy: callers mutate (billed) and the packet is persisted separately
  return { ...(structuredClone(e.value) as T), cache: { via: CACHED_VIA, fetchedAt: e.fetchedAt } };
}

const today = () => new Date().toISOString().slice(0, 10);
const strip = <T extends object>(v: T) => {
  const { cache: _c, billed: _b, ...rest } = v as T & { cache?: unknown; billed?: unknown };
  return rest;
};

export function cachedFairPrice(hospital: string, code: string): CachedFairPrice | undefined {
  return get<FairPrice>(priceKey(hospital, code));
}
export function cachedCharity(hospital: string): CachedCharity | undefined {
  return get<CharityPolicy>(charityKey(hospital));
}

/** Store a fresh live result (only ones that came back from Context.dev, never a cached one). */
export function rememberFairPrice(hospital: string, fp: FairPrice) {
  runtime.map.set(priceKey(hospital, fp.code), { value: strip(fp), fetchedAt: today() });
  runtime.save();
}
export function rememberCharity(hospital: string, policy: CharityPolicy) {
  runtime.map.set(charityKey(hospital), { value: strip(policy), fetchedAt: today() });
  runtime.save();
}

/** Test hook: forget runtime entries (the seed stays). */
export function clearRuntimeResearchCache() {
  runtime.map.clear();
  runtime.save();
}
/** Test/ops hook: re-read the runtime cache from DATA_DIR. */
export const reloadResearchCache = () => runtime.load();
