import type { FastifyError, FastifyInstance } from "fastify";

// One error shape for every route, matching docs/API.md: `{error: string}`. Without this, anything a handler
// throws (or a body Fastify could not parse) goes through Fastify's default handler, which answers
// `{statusCode, error: "Bad Request", message}` — and the web client shows `data.error`, i.e. "Bad Request"
// or "Internal Server Error" instead of the reason.
//   explicit statusCode 4xx/5xx -> as-is (404 unknown case, 409 wrong state, 400 bad body, 502 upstream)
//   "X is not configured" -> 503
//   anything else -> 500 (a bug), with the message only — the stack goes to the server log, never the client.
export function errorStatus(err: unknown): number {
  const e = err as { statusCode?: unknown; message?: unknown };
  const s = Number(e?.statusCode);
  if (Number.isInteger(s) && s >= 400 && s < 600) return s;
  return /not configured/i.test(String(e?.message ?? err)) ? 503 : 500;
}

/** Install the `{error}` handler on a route plugin (encapsulated: it covers that plugin's routes only). */
export function jsonErrors(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const code = errorStatus(err);
    if (code >= 500) req.log.error(err);
    return reply.code(code).send({ error: err?.message || String(err) });
  });
}

/** Tag an upstream (network / third-party API) failure as 502 so it is not reported as a server bug. */
export function upstream(what: string, err: unknown): Error {
  const e = err as Error & { statusCode?: number };
  if (e?.statusCode && e.statusCode >= 400 && e.statusCode < 600) return e;
  const why = e?.name === "TimeoutError" || e?.name === "AbortError" ? "timed out" : (e?.message ?? String(err));
  return Object.assign(new Error(`${what} is unreachable: ${why}`), { statusCode: 502 });
}
