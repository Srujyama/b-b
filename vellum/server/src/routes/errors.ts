import type { FastifyError, FastifyInstance } from "fastify";

// One error shape for every route, matching docs/API.md: `{error: string}`. Without this, anything a handler
// throws (or a body Fastify could not parse) goes through Fastify's default handler, which answers
// `{statusCode, error: "Bad Request", message}` — and the web client shows `data.error`, i.e. "Bad Request"
// or "Internal Server Error" instead of the reason.
//   explicit statusCode 4xx/5xx -> as-is (404 unknown case, 409 wrong state, 400 bad body, 502 upstream)
//   "X is not configured" -> 503
//   anything else -> 500 (a bug). The client gets a generic "internal error (request <id>)": an unclassified
//   throw carries whatever a library put in its message (a URL with a key in it, a file path, a query), so it is
//   not shown. The full error and stack go to the server log under the same request id.
// Messages we do send (explicit statusCode, or "not configured") still pass through redact(): they are authored
// here, but an upstream() wrapper embeds a library's reason, which may quote a URL.
export function errorStatus(err: unknown): number {
  return classifiedStatus(err) ?? 500;
}

/** The status our own code gave the error (explicit statusCode, or 503 for "not configured"); undefined for an unclassified throw. */
function classifiedStatus(err: unknown): number | undefined {
  const e = err as { statusCode?: unknown; message?: unknown };
  const s = Number(e?.statusCode);
  if (Number.isInteger(s) && s >= 400 && s < 600) return s;
  return /not configured/i.test(String(e?.message ?? err)) ? 503 : undefined;
}

/** Strip what must never reach a client even inside an intended message: URL credentials and query strings, bearer tokens, API-key-shaped strings. */
export function redact(msg: string): string {
  return msg
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1") // scheme://user:pass@host -> scheme://host
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*)\?[^\s#]*/gi, "$1?…") // drop query strings (?key=..., ?api_key=...)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 …")
    .replace(/\b(?:sk|pk|rk|xi)[-_][A-Za-z0-9_-]{16,}/g, "…");
}

/** The client-facing `{error}` text for an error the handler answers with `code`. */
export function errorMessage(err: unknown, code: number, reqId?: string): string {
  if (code >= 500 && classifiedStatus(err) === undefined) {
    return `internal error${reqId ? ` (request ${reqId})` : ""} — details are in the server log`;
  }
  const e = err as { message?: unknown };
  return redact(String(e?.message || err || "error"));
}

/** Install the `{error}` handler on a route plugin (encapsulated: it covers that plugin's routes only). */
export function jsonErrors(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const code = errorStatus(err);
    if (code >= 500) req.log.error(err);
    return reply.code(code).send({ error: errorMessage(err, code, req.id) });
  });
}

/**
 * The same `{error}` contract for the whole app. Call once on the ROOT instance in buildApp(), right after
 * Fastify() and before any register(): it then covers routes declared on the root (index.ts) or in plugins that
 * do not install jsonErrors themselves (bill.ts, voice.ts, summary.ts, pipeline.ts), and unknown routes, which
 * otherwise get Fastify's default `{statusCode, error: "Not Found", message}`. Child plugins that call
 * jsonErrors() keep their own (identical) handler.
 */
export function rootJsonErrors(app: FastifyInstance) {
  jsonErrors(app);
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: `no route ${req.method} ${req.url.split("?")[0]}` }));
}

/** Tag an upstream (network / third-party API) failure as 502 so it is not reported as a server bug. */
export function upstream(what: string, err: unknown): Error {
  const e = err as Error & { statusCode?: number };
  if (e?.statusCode && e.statusCode >= 400 && e.statusCode < 600) return e;
  const why = e?.name === "TimeoutError" || e?.name === "AbortError" ? "timed out" : (e?.message ?? String(err));
  return Object.assign(new Error(`${what} is unreachable: ${why}`), { statusCode: 502 });
}
