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
  if (!k) throw new ContextDevError("Context.dev is not configured — set CONTEXT_DEV_API_KEY in bangbang/server/.env", 503);
  return k;
}

type Method = "GET" | "POST";

async function call<T>(method: Method, path: string, body?: unknown, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
  const key = contextDevKey();
  const url = new URL(CONTEXT_DEV_BASE + path);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}), Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new ContextDevError(`Context.dev ${path} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new ContextDevError(`Context.dev ${path} failed (HTTP ${res.status}${json?.error_code ? ` ${json.error_code}` : ""}): ${json?.message ?? text.slice(0, 200)}`, res.status === 401 || res.status === 403 ? 503 : 502, json?.error_code);
  }
  return json as T;
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
export type ScrapeOpts = { markdown?: boolean; highlightsQuery?: string; maxCharacters?: number; json?: { schema: object; instructions?: string } };
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
export async function brand(lookup: { name: string } | { domain: string }): Promise<Brand> {
  const body = "domain" in lookup ? { type: "by_domain", domain: lookup.domain } : { type: "by_name", name: lookup.name };
  const r = await call<{ brand: any }>("POST", "/brand/retrieve", body);
  const b = r.brand ?? {};
  if (!b.domain) throw new ContextDevError(`Context.dev brand lookup returned no domain for ${JSON.stringify(lookup)}`);
  return { domain: b.domain, title: b.title, description: b.description, phone: b.phone, address: b.address, source: src(`https://${b.domain}`, b.title, b.description) };
}

// ---------- map site URLs ----------
export type MappedUrl = { url: string; title?: string; description?: string };
export async function mapUrls(domain: string, opts: { search?: string; maxLinks?: number; urlRegex?: string } = {}): Promise<MappedUrl[]> {
  const r = await call<{ urls: MappedUrl[] }>("GET", "/web/urls", undefined, { domain, search: opts.search, maxLinks: opts.maxLinks ?? 25, urlRegex: opts.urlRegex, includeSubdomains: true });
  return r.urls ?? [];
}

export const contextDevSource = src;
