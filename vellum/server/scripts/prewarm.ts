// Warm a server's research cache for the demo bill, so the demo's research step answers from the cache.
//
//   npm run prewarm                                         # BASE_URL defaults to http://localhost:8787
//   BASE_URL=https://vellum-app.fly.dev npm run prewarm
//   PREWARM_FRESH=1 npm run prewarm                         # go to Context.dev first (spends credits); the cache
//                                                           # is still the fallback, and new live results are stored
//
// It creates one demo case (POST /api/cases/demo), starts research (POST /research -> 202) and polls GET /api/cases/:id
// until the case is 'researched', then prints what each code resolved to and where it came from (live or cached).
// Exits non-zero if research fails or does not finish within PREWARM_TIMEOUT_MS (default 180000).
const BASE = (process.env.BASE_URL || "http://localhost:8787").replace(/\/$/, "");
const FRESH = /^(1|true|yes)$/i.test(process.env.PREWARM_FRESH ?? "");
const TIMEOUT_MS = Number(process.env.PREWARM_TIMEOUT_MS) || 180_000;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = { error: text.slice(0, 300) };
  }
  return { status: res.status, json };
}

function die(msg: string): never {
  console.error(`prewarm FAILED: ${msg}`);
  process.exit(1);
}

async function main() {
  console.log(`Prewarming research for the demo bill on ${BASE}${FRESH ? " (fresh: live Context.dev first)" : ""}`);
  let t0 = Date.now();
  const demo = await call("POST", "/api/cases/demo", {});
  if (demo.status !== 200) die(`POST /api/cases/demo -> HTTP ${demo.status}: ${demo.json?.error ?? ""}`);
  const id = demo.json.id as string;
  console.log(`  demo case ${id} in ${Date.now() - t0}ms (${demo.json.bill?.provider?.name})`);

  t0 = Date.now();
  const r = await call("POST", `/api/cases/${id}/research`, FRESH ? { fresh: true } : {});
  if (r.status !== 202 && r.status !== 200) die(`POST /research -> HTTP ${r.status}: ${r.json?.error ?? ""}`);
  console.log(`  POST /research -> ${r.status} in ${Date.now() - t0}ms`);
  let c = r.json;
  while (c.status !== "researched" && c.research?.state !== "failed") {
    if (Date.now() - t0 > TIMEOUT_MS) die(`not researched after ${TIMEOUT_MS}ms (research ${JSON.stringify(c.research)})`);
    await new Promise((res) => setTimeout(res, 500));
    const g = await call("GET", `/api/cases/${id}`);
    if (g.status !== 200) die(`GET /api/cases/${id} -> HTTP ${g.status}`);
    c = g.json;
  }
  if (c.status !== "researched") die(`research failed: ${c.research?.error ?? "unknown error"}`);
  console.log(`  researched in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  for (const fp of c.fairPrices ?? []) {
    const what = fp.medicareRate !== undefined ? `Medicare $${fp.medicareRate}` : "no verifiable published price";
    const from = fp.cache ? `${fp.cache.via}, fetched ${fp.cache.fetchedAt}` : "live Context.dev";
    console.log(`    ${fp.code.padEnd(6)} ${what.padEnd(30)} [${from}] ${fp.sources?.map((s: { url: string }) => s.url).join(" ") ?? ""}`);
  }
  const ch = c.charity;
  if (ch) console.log(`    charity ${ch.hasFap ? `free care <= ${ch.freeCareBelowPctFpl ?? "?"}% FPL` : "no policy found"} [${ch.cache ? `${ch.cache.via}, fetched ${ch.cache.fetchedAt}` : "live Context.dev"}]`);
  console.log(`  ladder: open $${c.opening}, target $${c.target}, walk away $${c.walkaway}`);
}

main().catch((e) => die((e as Error).message));
