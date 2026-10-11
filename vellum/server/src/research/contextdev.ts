// Thin typed client for Context.dev (https://docs.context.dev). Every result carries Source{via:"context.dev"}.
// Endpoints verified against the live OpenAPI docs (2026-10-11):
//   POST /v1/web/search      {query, numResults(10-100), includeDomains?, highlightsOptions?, markdownOptions?}
//   POST /v1/web/scrape      {url, formats:{markdown?,highlights?,json?}, highlightsParams?, jsonParams?}
//   POST /v1/web/answers     {task, json_format, mode:"fast"|"ultra"} -> {json_content, sources:string[]}
//   POST /v1/brand/retrieve  {type:"by_name"|"by_domain", name|domain} -> {brand:{domain,title,...}}
//   GET  /v1/web/urls?domain=&search=&maxLinks= -> {urls:[{url,title?,description?}]}
// Auth: Authorization: Bearer $CONTEXT_DEV_API_KEY
import type { Source } from "../types.js";

export const CONTEXT_DEV_BASE = "https://api.context.dev/v1";

export class ContextDevError extends Error {
  constructor(message: string, public statusCode = 502, public errorCode?: string) {
    super(message);
  }
}

export function contextDevKey(): string {
  const k = process.env.CONTEXT_DEV_API_KEY;
  if (!k) throw new ContextDevError("Context.dev is not configured — set CONTEXT_DEV_API_KEY in vellum/server/.env", 503);
  return k;
}

type Method = "GET" | "POST";

// The plan runs ONE request at a time across the whole organisation (a second concurrent one gets 429).
// Calls queue here so this process never competes with itself, but other processes sharing the key
// (the Fly app, dev servers, live scripts, teammates) still can, and a scrape may hold the slot for
// 10s+. So a 429 (or 408/5xx) is retried with exponential backoff + jitter, honouring Retry-After,
// until a total retry budget runs out; then we give up with a 503 ("busy, try again"), never a 502.
const MAX_CONCURRENT = 1;
const DEFAULT_RETRY_BUDGET_MS = 90_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 15_000;
export const CONTEXT_DEV_BUSY = "Context.dev is busy (one request at a time on this plan); try again shortly";
function retryBudgetMs(): number {
  const v = Number(process.env.CONTEXT_DEV_RETRY_BUDGET_MS);
  return Number.isFinite(v) && v >= 0 && process.env.CONTEXT_DEV_RETRY_BUDGET_MS !== "" ? v : DEFAULT_RETRY_BUDGET_MS;
}
/** Retry-After is either delta-seconds ("2", "0.5") or an HTTP date; returns ms, or undefined if absent/garbled. */
export function parseRetryAfter(h: string | null, now = Date.now()): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  if (h.trim() !== "" && Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}
/** Exponential backoff with "equal jitter" (half fixed, half random) so competing processes spread out. */
function backoffMs(attempt: number): number {
  const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return exp / 2 + Math.random() * (exp / 2);
}
const retryable = (status: number) => status === 429 || status === 408 || status >= 500;
let active = 0;
const waiting: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((go) => waiting.push(go));
  else active++;
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next(); // hand the slot straight to the next caller
    else active--;
  }
}
/** The API's `message` is a string, or for validation errors a list of { message } objects. */
const errorText = (m: unknown): string | undefined =>
  typeof m === "string" ? m : Array.isArray(m) ? m.map((x) => (typeof x?.message === "string" ? x.message : JSON.stringify(x))).join("; ") : m == null ? undefined : JSON.stringify(m);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T>(method: Method, path: string, body?: unknown, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
  const key = contextDevKey();
  const url = new URL(CONTEXT_DEV_BASE + path);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  return withSlot(async () => {
    const deadline = Date.now() + retryBudgetMs();
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url.toString(), {
        method,
        headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}), Accept: "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      // rate limits and transient server errors are retried within the budget; 4xx validation/auth errors never are
      if (retryable(res.status)) {
        // wait at least what the server asked for, and at least our own backoff
        const wait = Math.max(parseRetryAfter(res.headers.get("retry-after")) ?? 0, backoffMs(attempt));
        await res.body?.cancel().catch(() => {}); // free the connection; we won't read this body
        if (Date.now() + wait > deadline) {
          const why = res.status === 429 ? CONTEXT_DEV_BUSY : `Context.dev is unavailable (HTTP ${res.status} on ${path}); try again shortly`;
          throw new ContextDevError(why, 503, res.status === 429 ? "RATE_LIMITED" : undefined);
        }
        await sleep(wait);
        continue;
      }
      const text = await res.text();
      let json: any;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        throw new ContextDevError(`Context.dev ${path} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
      }
      if (!res.ok) {
        throw new ContextDevError(`Context.dev ${path} failed (HTTP ${res.status}${json?.error_code ? ` ${json.error_code}` : ""}): ${errorText(json?.message) ?? text.slice(0, 200)}`, res.status === 401 || res.status === 403 ? 503 : 502, json?.error_code);
      }
      return json as T;
    }
  });
}

const src = (url: string, title?: string, snippet?: string): Source => ({ title: title || url, url, snippet: snippet?.slice(0, 500), via: "context.dev" });

// ---------- search ----------
export type SearchHit = { url: string; title: string; description: string; relevance?: string; highlights?: string[]; markdown?: string; source: Source };
export type SearchOpts = { numResults?: number; includeDomains?: string[]; excludeDomains?: string[]; highlights?: boolean | { maxCharacters?: number }; markdown?: boolean };

export function buildSearchBody(query: string, o: SearchOpts = {}) {
  const body: Record<string, unknown> = { query: query.slice(0, 500), numResults: Math.min(100, Math.max(10, o.numResults ?? 10)), country: "us" };
  if (o.includeDomains?.length) body.includeDomains = o.includeDomains;
  if (o.excludeDomains?.length) body.excludeDomains = o.excludeDomains;
  if (o.highlights) body.highlightsOptions = { enabled: true, maxCharacters: typeof o.highlights === "object" ? o.highlights.maxCharacters ?? 4000 : 4000 };
  if (o.markdown) body.markdownOptions = { enabled: true, useMainContentOnly: true };
  return body;
}

export async function search(query: string, o: SearchOpts = {}): Promise<SearchHit[]> {
  const r = await call<{ results: any[] }>("POST", "/web/search", buildSearchBody(query, o));
  return (r.results ?? []).map((x) => {
    const highlights = x.highlights?.code === "SUCCESS" && Array.isArray(x.highlights.highlights) ? (x.highlights.highlights as string[]) : undefined;
    const markdown = x.markdown?.code === "SUCCESS" && typeof x.markdown.markdown === "string" ? (x.markdown.markdown as string) : undefined;
    return { url: x.url, title: x.title ?? "", description: x.description ?? "", relevance: x.relevance, highlights, markdown, source: src(x.url, x.title, highlights?.[0] ?? x.description) };
  });
}

// ---------- scrape ----------
export type ScrapeOpts = { markdown?: boolean; highlightsQuery?: string; maxCharacters?: number; json?: { schema: object; instructions?: string }; /** ms to let a JavaScript-rendered page load its data */ waitForMs?: number };
export type ScrapeResult = { url: string; markdown?: string; highlights?: string[]; json?: Record<string, unknown>; errors: string[]; source: Source };

export function buildScrapeBody(url: string, o: ScrapeOpts = {}) {
  const formats: Record<string, boolean> = {};
  const body: Record<string, unknown> = { url, formats };
  if (o.markdown || (!o.highlightsQuery && !o.json)) {
    formats.markdown = true;
    body.sharedParams = { mainContentOnly: true };
  }
  if (o.highlightsQuery) {
    formats.highlights = true;
    body.highlightsParams = { query: o.highlightsQuery.slice(0, 2000), maxCharacters: o.maxCharacters ?? 6000 };
  }
  if (o.json) {
    formats.json = true;
    body.jsonParams = { schema: o.json.schema, ...(o.json.instructions ? { instructions: o.json.instructions } : {}) };
  }
  if (o.waitForMs) body.sharedParams = { ...(body.sharedParams as object | undefined), waitFor: o.waitForMs };
  return body;
}

export async function scrape(url: string, o: ScrapeOpts = {}): Promise<ScrapeResult> {
  const r = await call<any>("POST", "/web/scrape", buildScrapeBody(url, o));
  const errors: string[] = [];
  const pick = (k: string) => {
    const out = r?.[k];
    if (out?.requested && out.success === false) errors.push(`${k}: ${out.error_code ?? "failed"} ${out.message ?? ""}`.trim());
    return out?.success ? out.data : undefined;
  };
  const markdown = pick("markdown") as string | undefined;
  const highlights = pick("highlights") as string[] | undefined;
  const json = pick("json") as Record<string, unknown> | undefined;
  const finalUrl = r?.url ?? url;
  return { url: finalUrl, markdown, highlights, json, errors, source: src(finalUrl, undefined, highlights?.[0] ?? markdown?.slice(0, 300)) };
}

// ---------- answers (AI research) ----------
export type AnswerResult<T> = { json: T; sources: Source[]; partial: boolean };
export async function answer<T extends Record<string, unknown>>(task: string, jsonFormat: T, mode: "fast" | "ultra" = "fast"): Promise<AnswerResult<Partial<T>>> {
  const r = await call<{ json_content: Partial<T>; sources: string[]; partial?: boolean }>("POST", "/web/answers", { task: task.slice(0, 2000), json_format: jsonFormat, mode });
  return { json: r.json_content ?? {}, sources: (r.sources ?? []).map((u) => src(u)), partial: Boolean(r.partial) };
}

// ---------- brand / company data ----------
export type Brand = { domain: string; title?: string; description?: string; phone?: string; address?: Record<string, string>; source: Source };
const BRAND_NAME_MAX = 30; // the API rejects longer names, and many hospital names are longer
/** Fit a name into the API's limit by dropping whole trailing words ("Riverside Shore Memorial Hospital" -> "Riverside Shore Memorial"). */
export function brandQueryName(name: string): string {
  const words = name.trim().split(/\s+/);
  while (words.length > 1 && words.join(" ").length > BRAND_NAME_MAX) words.pop();
  return words.join(" ").slice(0, BRAND_NAME_MAX);
}

export async function brand(lookup: { name: string } | { domain: string }): Promise<Brand> {
  const body = "domain" in lookup ? { type: "by_domain", domain: lookup.domain } : { type: "by_name", name: brandQueryName(lookup.name) };
  const r = await call<{ brand: any }>("POST", "/brand/retrieve", body);
  const b = r.brand ?? {};
  if (!b.domain) throw new ContextDevError(`Context.dev brand lookup returned no domain for ${JSON.stringify(lookup)}`);
  return { domain: b.domain, title: b.title, description: b.description, phone: b.phone, address: b.address, source: src(`https://${b.domain}`, b.title, b.description) };
}

/** Resolve an organisation's official domain by name, once per process (a brand lookup costs 10 credits). */
const brandsByName = new Map<string, Promise<Brand>>();
export function brandByName(name: string): Promise<Brand> {
  const key = name.trim().toLowerCase();
  let p = brandsByName.get(key);
  if (!p) {
    p = brand({ name });
    brandsByName.set(key, p);
    p.catch(() => brandsByName.delete(key)); // don't cache failures
  }
  return p;
}

// ---------- map site URLs ----------
export type MappedUrl = { url: string; title?: string; description?: string };
export async function mapUrls(domain: string, opts: { search?: string; maxLinks?: number; urlRegex?: string } = {}): Promise<MappedUrl[]> {
  const r = await call<{ urls: MappedUrl[] }>("GET", "/web/urls", undefined, { domain, search: opts.search, maxLinks: opts.maxLinks ?? 25, urlRegex: opts.urlRegex, includeSubdomains: true });
  return r.urls ?? [];
}

export const contextDevSource = src;
