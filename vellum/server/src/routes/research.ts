import type { FastifyInstance } from "fastify";
import type { Bill, CasePacket, CharityPolicy, FairPrice } from "../types.js";
import { emit, requireCase, updateCase } from "../store.js";
import { lookupFairPrice } from "../research/fairprice.js";
import { findCharityPolicy } from "../research/charity.js";
import { buildNegotiation } from "../research/facts.js";
import { cachedCharity, cachedFairPrice, rememberCharity, rememberFairPrice, type CacheLabel } from "../research/cache.js";
import { jsonErrors } from "./errors.js";

/** Research only the highest-charge codes: they carry the money, and it bounds Context.dev credits + latency. */
export const MAX_CODES = 4;
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export type FairPriceLookup = (code: string, description: string, hospital?: string) => Promise<FairPrice>;
export type ResearchOpts = {
  /** route each live fair-price lookup through the paid x402 endpoint (AUSD) */
  lookup?: FairPriceLookup;
  /** go to Context.dev first even when a cached result exists (the cache is still the fallback) */
  fresh?: boolean;
};

/** Progress marker stored on the case while research runs in the background (GET /api/cases/:id shows it). */
export type ResearchProgress = { state: "running" | "done" | "failed"; startedAt: string; finishedAt?: string; ms?: number; error?: string };
type WithProgress = CasePacket & { research?: ResearchProgress };

type Code = { code: string; description: string; charge: number };
type Plan = { c: CasePacket; bill: Bill; hospital: string; codes: Code[]; live: boolean; liveWhyNot?: string };

const httpErr = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

/** The unique coded lines, biggest total charge first, capped at MAX_CODES. */
export function topCodes(bill: Bill, max = MAX_CODES): Code[] {
  const byCode = new Map<string, Code>();
  for (const li of bill.lineItems) {
    if (!li.code) continue;
    const prev = byCode.get(li.code);
    byCode.set(li.code, { code: li.code, description: prev?.description ?? li.description, charge: (prev?.charge ?? 0) + li.charge });
  }
  return [...byCode.values()].sort((a, b) => b.charge - a.charge).slice(0, max);
}

/** Validate synchronously (404 / 409 / 503) so the route can answer before any research runs. */
function plan(id: string, opts: ResearchOpts): Plan {
  const c = requireCase(id);
  if (!c.bill) throw httpErr("case has no parsed bill — POST /api/cases first", 409);
  if (!c.patient) throw httpErr("case has no patient mandate (patient.maxPay)", 409);
  const bill = c.bill;
  const hospital = bill.provider.name;
  const codes = topCodes(bill);
  // Live research needs Context.dev (search/scrape) and Claude (reads the scraped text).
  const liveWhyNot = !process.env.CONTEXT_DEV_API_KEY
    ? "Context.dev is not configured — set CONTEXT_DEV_API_KEY in vellum/server/.env"
    : !process.env.ANTHROPIC_API_KEY
      ? "Claude is not configured — set ANTHROPIC_API_KEY in vellum/server/.env"
      : undefined;
  if (liveWhyNot) {
    const anyCached = codes.some((x) => cachedFairPrice(hospital, x.code)) || Boolean(cachedCharity(hospital));
    if (!anyCached) throw httpErr(`${liveWhyNot} (and there is no cached research for ${hospital})`, 503);
  }
  return { c, bill, hospital, codes, live: !liveWhyNot, liveWhyNot };
}

const cachedNote = (l: CacheLabel) => `cached Context.dev result from ${l.fetchedAt}`;

/** Does the research and returns the patch for the case (applied by runTracked, together with the progress marker). */
async function run(id: string, p: Plan, opts: ResearchOpts): Promise<Partial<CasePacket>> {
  const { c, bill, hospital, codes } = p;
  const lookup = opts.lookup ?? lookupFairPrice;
  const log = (message: string) => emit(id, { type: "log", message });
  log(`Researching fair prices for the ${codes.length} biggest billed codes${p.live ? " via Context.dev" : ""}`);
  if (!p.live) log(`Live research is off (${p.liveWhyNot}); using cached Context.dev results`);

  /** Live first (when asked or nothing cached), cached result otherwise or as the fallback. */
  async function resolve<T>(what: string, cached: () => (T & { cache: CacheLabel }) | undefined, live: () => Promise<T>, remember: (v: T) => void): Promise<T> {
    const hit = cached();
    if (hit && !opts.fresh) return hit;
    if (!p.live) {
      if (hit) return hit;
      throw new Error(`${p.liveWhyNot}; no cached result`);
    }
    try {
      const v = await live();
      remember(v);
      return v;
    } catch (e) {
      const msg = (e as Error).message;
      if (hit) {
        log(`${what}: Context.dev failed (${msg.slice(0, 160)}); using the ${cachedNote(hit.cache)}`);
        return hit;
      }
      throw new Error(`${msg} (no cached result to fall back on)`);
    }
  }

  const fairPrices: FairPrice[] = [];
  const failures: string[] = [];
  await Promise.all(
    codes.map(async ({ code, description, charge }) => {
      try {
        const fp = await resolve<FairPrice>(
          code,
          () => cachedFairPrice(hospital, code),
          () => lookup(code, description, hospital),
          (v) => rememberFairPrice(hospital, v),
        );
        fp.billed = charge;
        fairPrices.push(fp);
        const label = (fp as FairPrice & { cache?: CacheLabel }).cache;
        const bits = [fp.medicareRate !== undefined ? `Medicare ${usd(fp.medicareRate)}` : "", fp.hospitalCashPrice !== undefined ? `cash price ${usd(fp.hospitalCashPrice)}` : ""].filter(Boolean);
        const from = label ? ` — ${cachedNote(label)}` : "";
        if (bits.length) log(`${code}: billed ${usd(charge)}, ${bits.join(", ")} (${fp.sources.map((s) => s.url).join(", ")})${from}`);
        else log(`${code}: no verifiable published price found${from}`);
      } catch (e) {
        failures.push(`${code}: ${(e as Error).message}`);
        emit(id, { type: "error", message: `fair price ${code}: ${(e as Error).message}` });
      }
    }),
  );
  if (codes.length && failures.length === codes.length) throw httpErr(`fair-price research failed for every code: ${failures.join("; ")}`, 502);
  fairPrices.sort((a, b) => (b.billed ?? 0) - (a.billed ?? 0));

  log(`Looking up ${hospital}'s financial assistance policy (IRS 501(r))`);
  let charity: CharityPolicy | undefined = c.charity;
  try {
    charity = await resolve<CharityPolicy>(
      "charity policy",
      () => cachedCharity(hospital),
      () => findCharityPolicy(hospital, bill.provider.website, (m) => log(m)),
      (v) => v.hasFap && rememberCharity(hospital, v),
    );
    const label = (charity as CharityPolicy & { cache?: CacheLabel }).cache;
    if (charity.hasFap) {
      const t = [
        charity.freeCareBelowPctFpl ? `free below ${charity.freeCareBelowPctFpl}% FPL` : "",
        charity.discountBelowPctFpl ? `discount below ${charity.discountBelowPctFpl}% FPL` : "",
      ].filter(Boolean);
      log(`Found financial assistance policy: ${t.join(", ") || charity.summary}${label ? ` — ${cachedNote(label)}` : ""}`);
    } else log(`No financial assistance policy found for ${hospital}`);
  } catch (e) {
    emit(id, { type: "error", message: `charity policy: ${(e as Error).message}` });
  }

  const neg = buildNegotiation({ ...requireCase(id), fairPrices, charity });
  log(`Negotiation plan: open at ${usd(neg.opening)}, target ${usd(neg.target)}, walk away above ${usd(neg.walkaway)} (${neg.facts.length} facts)`);
  return { fairPrices, charity, facts: neg.facts, target: neg.target, opening: neg.opening, walkaway: neg.walkaway, status: "researched" };
}

function setProgress(id: string, research: ResearchProgress, patch: Partial<CasePacket> = {}): CasePacket {
  return updateCase(id, { ...patch, research } as Partial<WithProgress> as Partial<CasePacket>);
}

/** Research a case and wait for it (the pipeline uses this). Cached results first; live Context.dev otherwise. */
export async function researchCase(id: string, opts: ResearchOpts = {}): Promise<CasePacket> {
  const p = plan(id, opts);
  return runTracked(id, p, opts);
}

const inFlight = new Map<string, Promise<CasePacket>>();

function runTracked(id: string, p: Plan, opts: ResearchOpts): Promise<CasePacket> {
  const running = inFlight.get(id);
  if (running) return running;
  const t0 = Date.now();
  const startedAt = new Date(t0).toISOString();
  setProgress(id, { state: "running", startedAt });
  const job = run(id, p, opts)
    .then((patch) => {
      const ms = Date.now() - t0;
      emit(id, { type: "log", message: `Research done in ${(ms / 1000).toFixed(1)}s` });
      // one update: the case turns "researched" and the progress marker turns "done" together
      return setProgress(id, { state: "done", startedAt, finishedAt: new Date().toISOString(), ms }, patch);
    })
    .catch((e: Error) => {
      setProgress(id, { state: "failed", startedAt, finishedAt: new Date().toISOString(), ms: Date.now() - t0, error: e.message });
      throw e;
    })
    .finally(() => inFlight.delete(id));
  inFlight.set(id, job);
  return job;
}

/** Start research in the background and return the case right away (status flips to "researched" when done). */
export function startResearch(id: string, opts: ResearchOpts = {}): CasePacket {
  if (inFlight.has(id)) return { ...requireCase(id) };
  const p = plan(id, opts);
  runTracked(id, p, opts).catch((e: Error) => emit(id, { type: "error", message: `research failed: ${e.message}` }));
  return { ...requireCase(id) }; // a snapshot: the live packet changes as research finishes
}

export default async function researchRoutes(app: FastifyInstance) {
  jsonErrors(app);
  // 202: research runs in the background (it used to block for minutes on Context.dev and hit the proxy's
  // ~120s cut-off). Progress streams over /ws as log events; the finished case arrives as a 'case' event.
  app.post<{ Params: { id: string }; Body: { fresh?: unknown } | null }>("/api/cases/:id/research", async (req, reply) => {
    try {
      const fresh = (req.body as { fresh?: unknown } | null)?.fresh === true;
      return reply.code(202).send(startResearch(req.params.id, { fresh }));
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });
}
