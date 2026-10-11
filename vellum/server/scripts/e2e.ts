// End-to-end check of the KEYLESS Vellum flow, over HTTP, against a running server.
//
//   npm run e2e                                        # BASE_URL defaults to http://localhost:8787
//   BASE_URL=https://vellum-advocate.vercel.app npm run e2e
//
// Optional env:
//   E2E_TOOL_SECRET   sent as x-vellum-secret to POST /api/eleven/tools/:name when the server sets ELEVENLABS_TOOL_SECRET
//                     (falls back to ELEVENLABS_TOOL_SECRET from the environment)
//   E2E_LOAN          auto (default: loan if Gemini recommends a payment plan, or to fund a short patient wallet) | force | skip
//   E2E_TIMEOUT_MS    per-request timeout (default 120000; XRPL devnet submits take a few seconds each)
//   E2E_DEMO_BUDGET_MS        POST /api/cases/demo must answer within this (default 2000)
//   E2E_RESEARCH_TIMEOUT_MS   how long to poll for status 'researched' (default 30000)
//
// What it does (real calls, nothing simulated here): health -> POST /api/cases/demo (bundled fixture bill + patient,
// timed) -> GET case -> research (POST /research answers 202 at once; poll GET until 'researched': cached Context.dev
// results first, live otherwise; works with no keys for the demo hospital) -> financing (live Gemini Fed odds) -> XRPL devnet hardship credential -> a negotiation recorded through
// the tool webhook the way a human billing rep's call is (log_offer x3 descending, accept ABOVE the patient's
// walkaway must be refused, then accept at/below it) -> optional 0% community-fund loan (pipeline order: before the
// escrow; in auto mode also opened when the shared devnet patient wallet is too short to fund the escrow) -> XRPL
// escrow -> release through the hospital portal -> summary -> proof bundle (hash chain recomputed with
// web/verify-core.js) -> GET /api/fund -> the key-requiring endpoints must answer 503 with a message that names what
// to configure (SKIPped on a server where that key IS configured).
//
// Every XRPL step is a real devnet transaction signed by the SERVER's wallets (from its .env). A run spends the
// shared patient wallet's devnet USD; when it is short, auto mode borrows from the community-fund vault.
//
// KEYLESS against a local server: vellum/server/.env may hold Anthropic / ElevenLabs / Context.dev keys. dotenv does not
// override variables already set (even to ""), so blank them on the SERVER command to exercise the keyless path:
//   ANTHROPIC_API_KEY= ELEVENLABS_API_KEY= CONTEXT_DEV_API_KEY= DEV_PREVIEW= PORT=8899 npx tsx src/index.ts
//   BASE_URL=http://localhost:8899 npm run e2e
// The demo bill is always read by the built-in reader; with keys configured the 503 checks are SKIPped.
//
// The deployed server is shared: this script only ever creates and touches its OWN case (the id it got back).
// It exits non-zero if any step FAILs. SKIP is printed (with the reason) for a step that does not apply.
import { readFileSync } from "node:fs";
import { keccak256 } from "viem";

const BASE = (process.env.BASE_URL || "http://localhost:8787").replace(/\/$/, "");
const TIMEOUT = Number(process.env.E2E_TIMEOUT_MS) || 120_000;
const DEMO_BUDGET_MS = Number(process.env.E2E_DEMO_BUDGET_MS) || 2_000; // POST /api/cases/demo must answer within this
const RESEARCH_TIMEOUT_MS = Number(process.env.E2E_RESEARCH_TIMEOUT_MS) || 30_000; // poll this long for 'researched'
const RESEARCH_STEP = "research (POST /research → 202, poll until researched)";
let demoMs = 0;
let researchMs = 0;
const TOOL_SECRET =process.env.E2E_TOOL_SECRET || process.env.ELEVENLABS_TOOL_SECRET || "";
const LOAN_MODE = (process.env.E2E_LOAN || "auto").toLowerCase();

const fixture = JSON.parse(readFileSync(new URL("../fixtures/lin-er-bill.json", import.meta.url), "utf8")) as {
  patient: { name: string; maxPay: number; consent: boolean; language: string };
  _plantedErrors: { kind: string; amountAtStake: number }[];
};

type VerifyCore = {
  ZERO_HEAD: string;
  flattenEntries(bundle: unknown): Record<string, unknown>[];
  verifyEntries(
    keccak: (b: Uint8Array) => Uint8Array,
    entries: Record<string, unknown>[],
    opts?: { onChain?: { head: string; count: number } | null },
  ): { ok: boolean; head: string; count: number; firstBadIndex?: number; reason?: string; onChainMatch: boolean | null };
};

// ------------------------------------------------------------------ tiny harness

type Res = { status: number; json: any; text: string; headers: Headers };
const results: { name: string; outcome: "PASS" | "FAIL" | "SKIP"; reason: string }[] = [];
const links: string[] = [];

class Fail extends Error {}
class Skip extends Error {}
const fail = (msg: string): never => {
  throw new Fail(msg);
};
const skip = (msg: string): never => {
  throw new Skip(msg);
};
function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const ctl = AbortSignal.timeout(TIMEOUT);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctl,
    });
  } catch (e) {
    return fail(`${method} ${path}: request failed (${(e as Error).message})`);
  }
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, headers: res.headers };
}

const errText = (r: Res) => (r.json?.error ?? r.json?.message ?? r.text.slice(0, 300)) as string;
function ok(r: Res, what: string, status = 200) {
  if (r.status !== status) fail(`${what} → HTTP ${r.status}: ${errText(r)}`);
  return r.json;
}

function txLinks(receipts: { kind: string; txHash: string; explorerUrl?: string }[]): string {
  const out = receipts.map((r) => {
    if (r.explorerUrl) links.push(`${r.kind} ${r.txHash} ${r.explorerUrl}`);
    return `${r.kind} ${r.txHash}${r.explorerUrl ? ` ${r.explorerUrl}` : ""}`;
  });
  return out.join("\n         ");
}

const HASH64 = /^[0-9A-F]{64}$/i;

async function step(name: string, fn: () => Promise<string>, opts: { needs?: string[] } = {}) {
  const blocked = (opts.needs ?? []).filter((n) => results.find((r) => r.name === n)?.outcome !== "PASS");
  if (blocked.length) {
    results.push({ name, outcome: "FAIL", reason: `blocked: ${blocked.join(", ")} did not pass` });
    console.log(`FAIL  ${name} — blocked: ${blocked.join(", ")} did not pass`);
    return;
  }
  const t0 = Date.now();
  try {
    const reason = await fn();
    results.push({ name, outcome: "PASS", reason });
    console.log(`PASS  ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s) — ${reason}`);
  } catch (e) {
    const outcome = e instanceof Skip ? "SKIP" : "FAIL";
    const reason = e instanceof Fail || e instanceof Skip ? e.message : `unexpected error: ${(e as Error)?.stack ?? e}`;
    results.push({ name, outcome, reason });
    console.log(`${outcome}  ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s) — ${reason}`);
  }
}

// ------------------------------------------------------------------ the flow

let health: Record<string, boolean> = {};
let caseId = "";
let packet: any;
let financing: any;
let ceiling = 0;
let agreed = 0;
let escrowTx = "";
let loanId = "";
let loanAtSettle = ""; // the 409 that made auto mode open the loan inside the escrow step
const ourTxs: string[] = [];

const tool = (name: string, args: Record<string, unknown>) =>
  http("POST", `/api/eleven/tools/${name}`, { case_id: caseId, ...args }, TOOL_SECRET ? { "x-vellum-secret": TOOL_SECRET } : {});

async function toolOk(name: string, args: Record<string, unknown>) {
  const r = await tool(name, args);
  if (r.status === 401) fail(`${name} → 401 bad tool secret: this server sets ELEVENLABS_TOOL_SECRET; run with E2E_TOOL_SECRET=<it>`);
  return ok(r, `tool ${name}`) as { ok: boolean; message: string };
}

let loanNote = "";
async function openLoan(): Promise<string> {
  const rs = ok(await http("POST", `/api/cases/${caseId}/loan`, { months: 12 }), "POST /loan");
  const l = rs.find((r: any) => r.kind === "LoanSet");
  expect(l && HASH64.test(l.txHash) && l.detail?.loanId, `no LoanSet receipt: ${JSON.stringify(rs)}`);
  loanId = l.detail.loanId;
  ourTxs.push(l.txHash);
  loanNote = `loan ${loanId}, $${l.detail.principal} over ${l.detail.payments} months at 0% — ${txLinks(rs)}`;
  return loanNote;
}

async function main() {
  console.log(`Vellum keyless E2E against ${BASE}  (${new Date().toISOString()})\n`);

  await step("health", async () => {
    const h = ok(await http("GET", "/health"), "GET /health");
    expect(h?.ok === true, `GET /health did not say ok: ${JSON.stringify(h)}`);
    health = h;
    expect(h.xrpl === true, "server has no XRPL wallets configured (xrpl:false) — the on-ledger steps cannot run");
    const on = Object.entries(h).filter(([k, v]) => k !== "ok" && v === true).map(([k]) => k);
    const off = Object.entries(h).filter(([, v]) => v === false).map(([k]) => k);
    return `configured: ${on.join(", ") || "none"}; not configured: ${off.join(", ") || "none"}`;
  });

  await step(
    "create demo case (POST /api/cases/demo)",
    async () => {
      const t0 = Date.now();
      const c = ok(await http("POST", "/api/cases/demo", {}), "POST /api/cases/demo");
      demoMs = Date.now() - t0;
      expect(demoMs < DEMO_BUDGET_MS, `POST /api/cases/demo took ${demoMs}ms (budget ${DEMO_BUDGET_MS}ms)`);
      expect(typeof c?.id === "string" && c.id, "no case id returned");
      caseId = c.id;
      expect(c.status === "audited", `status is ${c.status}, expected audited`);
      expect(c.patient?.name === fixture.patient.name, `patient name ${c.patient?.name} != fixture ${fixture.patient.name}`);
      expect(c.patient?.consent === true, "patient consent is not true");
      expect(c.patient?.maxPay === fixture.patient.maxPay, `patient.maxPay ${c.patient?.maxPay} != fixture ${fixture.patient.maxPay}`);
      expect(c.bill?.lineItems?.length > 0, "bill has no line items");
      for (const p of fixture._plantedErrors) {
        const f = c.flags?.find((x: any) => x.kind === p.kind);
        expect(f, `audit missed the planted ${p.kind}`);
        expect(f.amountAtStake === p.amountAtStake, `${p.kind} at stake ${f.amountAtStake}, fixture says ${p.amountAtStake}`);
      }
      // the bundled demo statement is always read by the deterministic reader (keys or not): fast, no AI call
      expect(c.bill.reader === "builtin", `bill.reader is ${c.bill.reader} (expected "builtin")`);
      packet = c;
      return `case ${caseId}: ${c.bill.lineItems.length} lines, balance $${c.bill.patientBalance}, ${c.flags.length} flags; reader: built-in statement reader (bill.reader=${c.bill.reader}); patient ${c.patient.name}, consent, maxPay $${c.patient.maxPay}`;
    },
    { needs: ["health"] },
  );

  await step(
    "GET case",
    async () => {
      const c = ok(await http("GET", `/api/cases/${caseId}`), "GET /api/cases/:id");
      expect(c.id === caseId, "returned a different case");
      expect(c.status === "audited", `status ${c.status}`);
      expect(c.bill?.patientBalance === packet.bill.patientBalance, "balance differs from the create response");
      expect(c.bill?.reader === packet.bill.reader, `bill.reader ${c.bill?.reader} not persisted (create said ${packet.bill.reader})`);
      return `status ${c.status}, balance $${c.bill.patientBalance}${c.bill.reader ? `, bill.reader=${c.bill.reader} (stored on the case)` : ""}`;
    },
    { needs: ["create demo case (POST /api/cases/demo)"] },
  );

  await step(
    RESEARCH_STEP,
    async () => {
      const t0 = Date.now();
      const r = await http("POST", `/api/cases/${caseId}/research`, {});
      const accepted = ok(r, "POST /research", 202);
      const ackMs = Date.now() - t0;
      expect(accepted?.id === caseId, "POST /research returned another case");
      let c = accepted;
      while (c.status !== "researched" && c.research?.state !== "failed") {
        if (Date.now() - t0 > RESEARCH_TIMEOUT_MS) fail(`not researched after ${RESEARCH_TIMEOUT_MS}ms (status ${c.status}, research ${JSON.stringify(c.research)})`);
        await new Promise((res) => setTimeout(res, 250));
        c = ok(await http("GET", `/api/cases/${caseId}`), "GET /api/cases/:id");
      }
      researchMs = Date.now() - t0;
      expect(c.status === "researched", `research failed: ${c.research?.error ?? "unknown error"}`);
      expect(c.fairPrices?.length > 0 && c.fairPrices.length <= 4, `${c.fairPrices?.length} fair prices (expected 1-4: the top codes by charge)`);
      for (const fp of c.fairPrices)
        if (fp.medicareRate !== undefined) expect(fp.sources?.length > 0, `${fp.code}: Medicare $${fp.medicareRate} has no source`);
      expect(Array.isArray(c.facts) && c.facts.length > 0, "no negotiation facts built");
      expect(typeof c.walkaway === "number", "no walkaway on the researched case");
      const cached = c.fairPrices.filter((f: any) => f.cache).length;
      const prices = c.fairPrices.map((f: any) => `${f.code} ${f.medicareRate !== undefined ? `Medicare $${f.medicareRate}` : "no published price"}`).join(", ");
      const charity = c.charity?.hasFap ? `charity: free care <= ${c.charity.freeCareBelowPctFpl ?? "?"}% FPL${c.charity.cache ? " (cached)" : ""}` : "no charity policy";
      return `202 in ${ackMs}ms, researched in ${(researchMs / 1000).toFixed(1)}s; ${prices}; ${cached}/${c.fairPrices.length} from the cache (${c.fairPrices.find((f: any) => f.cache)?.cache?.via ?? "live"}); ${charity}; plan: open $${c.opening}, target $${c.target}, walk away $${c.walkaway}`;
    },
    { needs: ["create demo case (POST /api/cases/demo)"] },
  );

  await step(
    "financing (live Gemini Fed odds)",
    async () => {
      const a = ok(await http("POST", `/api/cases/${caseId}/financing`, {}), "POST /financing");
      expect(a.recommendation === "lump_sum" || a.recommendation === "payment_plan", `recommendation ${a.recommendation}`);
      expect(a.fedOdds?.outcomes?.length > 0, "no Fed odds outcomes in the advice");
      const sum = a.fedOdds.outcomes.reduce((s: number, o: any) => s + Number(o.prob), 0);
      expect(sum > 0.5 && sum < 1.5, `Fed odds probabilities sum to ${sum}`);
      financing = a;
      const odds = a.fedOdds.outcomes.map((o: any) => `${o.label} ${(o.prob * 100).toFixed(0)}%`).join(", ");
      return `${a.recommendation} — ${a.fedOdds.market} [${a.fedOdds.ticker}] fetched ${a.fedOdds.fetchedAt}: ${odds}`;
    },
    { needs: ["create demo case (POST /api/cases/demo)"] },
  );

  await step(
    "XRPL hardship credential (POST /credential)",
    async () => {
      const rs = ok(await http("POST", `/api/cases/${caseId}/credential`, {}), "POST /credential");
      expect(Array.isArray(rs) && rs.length, "no receipts");
      const kinds = rs.map((r: any) => r.kind);
      expect(kinds.includes("CredentialAccept") || kinds.includes("CredentialCreate"), `receipt kinds ${kinds.join(",")}`);
      for (const r of rs) {
        expect(r.chain === "xrpl" && HASH64.test(r.txHash), `bad receipt ${JSON.stringify(r)}`);
        ourTxs.push(r.txHash);
      }
      return txLinks(rs);
    },
    { needs: ["create demo case (POST /api/cases/demo)"] },
  );

  await step(
    "negotiation via tool webhook (human billing rep)",
    async () => {
      const c = ok(await http("GET", `/api/cases/${caseId}`), "GET case");
      ceiling = c.walkaway ?? c.patient?.maxPay;
      expect(ceiling > 0, "case has no walkaway / patient.maxPay");
      const balance = c.bill.patientBalance as number;
      const over = Math.round(ceiling * 1.2);
      const ladder = [Math.round(balance * 0.7), Math.round(balance * 0.4), over];
      for (const amount of ladder) {
        const r = await toolOk("log_offer", { amount, note: `e2e: billing rep offer $${amount}` });
        expect(r.ok, `log_offer ${amount} not ok: ${r.message}`);
      }
      const refused = await toolOk("accept_offer", { amount: over });
      expect(refused.ok === false && /REFUSED/.test(refused.message), `accept ABOVE walkaway ($${over} > $${ceiling}) was not refused: ${JSON.stringify(refused)}`);
      const mid = ok(await http("GET", `/api/cases/${caseId}`), "GET case");
      expect(mid.agreedAmount == null, `a refused accept still set agreedAmount=${mid.agreedAmount}`);
      agreed = Math.floor(ceiling * 0.94);
      const last = await toolOk("log_offer", { amount: agreed, note: "e2e: final offer after the audit findings" });
      expect(last.ok, `log_offer ${agreed}: ${last.message}`);
      const acc = await toolOk("accept_offer", { amount: agreed });
      expect(acc.ok, `accept at $${agreed} (<= walkaway $${ceiling}) failed: ${acc.message}`);
      const end = await toolOk("end_call", { outcome: "deal", amount: agreed, summary: "e2e: agreed with billing" });
      expect(end.ok, `end_call: ${end.message}`);
      const after = ok(await http("GET", `/api/cases/${caseId}`), "GET case");
      expect(after.agreedAmount === agreed, `agreedAmount ${after.agreedAmount}, expected ${agreed}`);
      expect(after.status === "agreed", `status ${after.status}, expected agreed`);
      const hosp = after.offers.filter((o: any) => o.by === "hospital").map((o: any) => o.amount);
      expect(hosp.length >= 4 && hosp.every((a: number, i: number) => i === 0 || a < hosp[i - 1]), `hospital offers not descending: ${hosp}`);
      return `offers $${hosp.join(" → $")}; accept $${over} refused (walkaway $${ceiling}); accepted $${agreed}; status agreed`;
    },
    { needs: ["create demo case (POST /api/cases/demo)"] },
  );

  // Same order as the one-button pipeline: the 0% loan (when Gemini says payment plan, or E2E_LOAN=force) comes BEFORE
  // the escrow, so the loan's disbursement is what funds it. In auto mode with a lump-sum recommendation the loan step
  // is decided (and reported) after the escrow step, because it is opened there only if the patient wallet is short.
  const LOAN_STEP = "0% community-fund loan (POST /loan)";
  const loanNeeds = ["negotiation via tool webhook (human billing rep)", "XRPL hardship credential (POST /credential)"];
  const loanBeforeEscrow = LOAN_MODE === "force" || (LOAN_MODE === "auto" && financing?.recommendation === "payment_plan");
  if (LOAN_MODE === "skip") await step(LOAN_STEP, async () => skip("E2E_LOAN=skip"), { needs: loanNeeds });
  else if (loanBeforeEscrow) await step(LOAN_STEP, openLoan, { needs: loanNeeds });

  await step(
    "XRPL escrow (POST /settle)",
    async () => {
      let r = await http("POST", `/api/cases/${caseId}/settle`, {});
      let topUp = "";
      // The devnet patient wallet is shared by every run (and by everyone on a deployed server); each settlement spends
      // its USD. When it is short the server says "open a 0% loan first", which is the product's own answer, so in
      // auto mode we do exactly that (a real LoanSet on devnet, reported below) and retry once.
      if (r.status === 409 && /patient wallet holds/.test(errText(r)) && LOAN_MODE === "auto" && !loanId) {
        loanAtSettle = errText(r);
        await openLoan();
        topUp = `patient wallet was short; opened 0% loan ${loanId.slice(0, 12)}… first (reported under the loan step), then retried\n         `;
        r = await http("POST", `/api/cases/${caseId}/settle`, {});
      }
      const rs = ok(r, "POST /settle");
      const e = rs.find((x: any) => x.kind === "EscrowCreate");
      expect(e && HASH64.test(e.txHash), `no EscrowCreate receipt: ${JSON.stringify(rs)}`);
      escrowTx = e.txHash;
      ourTxs.push(e.txHash);
      return `${topUp}$${agreed} locked — ${txLinks(rs)}`;
    },
    { needs: ["negotiation via tool webhook (human billing rep)", "XRPL hardship credential (POST /credential)"] },
  );

  if (LOAN_MODE === "auto" && !loanBeforeEscrow)
    await step(
      LOAN_STEP,
      async () => {
        if (loanId)
          return `opened at the escrow step: Gemini recommended ${financing?.recommendation ?? "unknown"}, but the shared devnet patient wallet was short (${loanAtSettle}) — ${loanNote}`;
        return skip(
          `Gemini recommended ${financing?.recommendation ?? "unknown"} and the patient wallet covered the escrow, so no loan was needed (E2E_LOAN=force to exercise it)`,
        );
      },
      { needs: loanNeeds },
    );

  await step(
    "hospital portal: release escrow",
    async () => {
      const d = ok(await http("GET", `/api/hospital/cases/${caseId}`), "GET /api/hospital/cases/:id");
      expect(d.stage === "awaiting_confirmation", `stage ${d.stage}, expected awaiting_confirmation`);
      expect(d.escrow?.state === "open" && d.escrow.txHash === escrowTx, `escrow view ${JSON.stringify(d.escrow)}`);
      expect(d.escrow.amount === agreed, `escrow amount ${d.escrow.amount} != agreed ${agreed}`);
      expect(!("fulfillment" in d.escrow), "hospital view leaked the escrow fulfillment");
      const l = ok(await http("GET", `/api/hospital/cases/${caseId}/ledger`), "GET /ledger");
      expect(l.escrow?.onLedger === true, `escrow not found on-ledger: ${JSON.stringify(l.escrow)}`);
      expect(l.credential?.onLedger === true, `credential not found on-ledger: ${JSON.stringify(l.credential)}`);
      const noAttest = await http("POST", `/api/hospital/cases/${caseId}/confirm-zero-balance`, { attest: false });
      expect(noAttest.status === 400, `confirm without attest answered ${noAttest.status}, expected 400`);
      const r = ok(
        await http("POST", `/api/hospital/cases/${caseId}/confirm-zero-balance`, { attest: true, staffName: "Vellum E2E (billing rep)" }),
        "POST hospital confirm-zero-balance",
      );
      const rs = r.receipts as any[];
      expect(rs?.some((x) => x.kind === "Batch" && HASH64.test(x.txHash)), `no Batch receipt: ${JSON.stringify(rs)}`);
      for (const x of rs) ourTxs.push(x.txHash);
      expect(r.case?.stage === "released", `stage after release ${r.case?.stage}`);
      const c = ok(await http("GET", `/api/cases/${caseId}`), "GET case");
      expect(c.status === "settled", `case status ${c.status}, expected settled`);
      const again = await http("POST", `/api/hospital/cases/${caseId}/confirm-zero-balance`, { attest: true });
      expect(again.status === 409, `second confirm answered ${again.status}, expected 409`);
      return `ledger check ok (escrow + credential on-ledger); released, status settled — ${txLinks(rs)}`;
    },
    { needs: ["XRPL escrow (POST /settle)"] },
  );

  await step(
    "summary (GET /summary)",
    async () => {
      const s = ok(await http("GET", `/api/cases/${caseId}/summary`), "GET /summary");
      expect(typeof s.en === "string" && typeof s.zh === "string" && s.en && s.zh, "summary has no en/zh text");
      expect(s.preview === false, "summary marked preview");
      expect(s.numbers?.agreedAmount === agreed, `summary agreedAmount ${s.numbers?.agreedAmount} != ${agreed}`);
      expect(s.numbers?.originalBill === packet.bill.patientBalance, `summary originalBill ${s.numbers?.originalBill}`);
      if (ourTxs.length) expect(s.steps?.credential === "done", `credential step ${s.steps?.credential}`);
      const passed = (n: string) => results.find((r) => r.name === n)?.outcome === "PASS";
      const wantEscrow = passed("hospital portal: release escrow") ? "released" : escrowTx ? "locked" : "none";
      expect(s.steps?.escrow === wantEscrow, `escrow step ${s.steps?.escrow}, expected ${wantEscrow} for this run`);
      if (loanId) expect(s.steps?.loan === "done", `loan step ${s.steps?.loan}`);
      return `saved $${s.numbers.saved} (${s.numbers.savedPct}%); steps ${JSON.stringify(s.steps)}; "${s.en.slice(0, 120)}…"`;
    },
    { needs: ["create demo case (POST /api/cases/demo)"] },
  );

  await step(
    "proof bundle (GET /proof) + hash chain recompute",
    async () => {
      const b = ok(await http("GET", `/api/cases/${caseId}/proof`), "GET /proof");
      expect(/^vellum-proof\//.test(b.format), `format ${b.format}`);
      expect(b.case?.id === caseId, "bundle is for another case");
      expect(b.preview === false, "bundle marked preview");
      const core = (await import(new URL("../../web/verify-core.js", import.meta.url).href)) as VerifyCore;
      const kec = (bytes: Uint8Array) => keccak256(bytes, "bytes");
      const entries = core.flattenEntries(b);
      const v = core.verifyEntries(kec, entries, { onChain: b.onChain ? { head: b.onChain.head, count: b.onChain.count } : null });
      expect(v.ok, `hash chain does not recompute: ${v.reason} at entry ${v.firstBadIndex}`);
      expect(v.head.toLowerCase() === String(b.claimedHead?.head).toLowerCase() && v.count === b.claimedHead?.count, `recomputed head ${v.head}/${v.count} != claimed ${b.claimedHead?.head}/${b.claimedHead?.count}`);
      expect(b.serverCheck?.ok === true && b.serverCheck.head === v.head, "server's own verifyChain disagrees with verify-core.js");
      const xr = (b.receipts?.xrpl ?? []).map((r: any) => r.txHash);
      const missing = ourTxs.filter((h) => !xr.includes(h));
      expect(missing.length === 0, `proof bundle is missing our XRPL txs: ${missing.join(", ")}`);
      const chainNote = entries.length
        ? `${entries.length} entries recomputed with verify-core.js, head ${v.head}`
        : `0 log entries (the negotiation log is only appended when the BNB AdvocateLedger is deployed: ${b.onChainReason ?? "n/a"}); empty chain head = ${core.ZERO_HEAD.slice(0, 10)}… verified`;
      return `${chainNote}; ${xr.length} XRPL receipts incl. all ${ourTxs.length} from this run; mandate ${b.mandate ? `cap $${b.mandate.maxAmountUsd}, anchored=${b.mandate.anchored}` : b.mandateReason}`;
    },
    { needs: ["create demo case (POST /api/cases/demo)"] },
  );

  await step(
    "community fund (GET /api/fund)",
    async () => {
      const f = ok(await http("GET", "/api/fund"), "GET /api/fund");
      expect(f.vault?.id && f.broker?.id, "fund state has no vault/broker");
      expect(Array.isArray(f.loans), "fund state has no loans array");
      if (loanId) {
        const mine = f.loans.find((l: any) => l.id === loanId);
        expect(mine, `loan ${loanId} not listed in /api/fund`);
        expect(mine.caseId === caseId, `fund lists loan ${loanId} for case ${mine.caseId}, expected ${caseId}`);
        return `vault ${f.vault.id.slice(0, 12)}… available $${f.vault.assetsAvailable}; our loan ${loanId.slice(0, 12)}… is ${mine.status}, case ${mine.caseId}`;
      }
      return `vault ${f.vault.id.slice(0, 12)}… available $${f.vault.assetsAvailable}, ${f.loans.length} loans (no loan opened this run)`;
    },
    { needs: ["health"] },
  );

  // ---- endpoints that need keys this deployment does not have: must be an actionable 503, not a 500 / hang
  const needs503 = async (needs: string, label: string, configured: boolean, why: string, method: string, path: string, body?: unknown) =>
    step(`${label} without keys → 503`, async () => {
      if (configured) skip(`${why} is configured on this server, so a 503 is not expected`);
      const r = await http(method, path, body);
      const msg = errText(r);
      expect(r.status === 503, `HTTP ${r.status} (expected 503): ${msg}`);
      expect(/not configured|not deployed/i.test(msg) && /[A-Z][A-Z0-9_]{5,}/.test(msg), `503 message does not say what to configure: "${msg}"`);
      return `503 "${msg}"`;
    }, { needs: [needs] });

  // NOTE: routes/clinic.ts creates the clinic case before it finds the key missing, so this leaves one "failed" clinic
  // case (ours, not anyone else's) in the store on a keyless server.
  await needs503("health", "POST /api/claims/demo", Boolean(health.contextDev && health.anthropic), "Context.dev + Anthropic", "POST", "/api/claims/demo", {});
  await needs503("create demo case (POST /api/cases/demo)", "GET /summary.mp3", Boolean(health.elevenlabs), "ElevenLabs", "GET", `/api/cases/${caseId}/summary.mp3`);
  await needs503("create demo case (POST /api/cases/demo)", "POST /mandate", Boolean(health.bnb), "BNB AdvocateLedger", "POST", `/api/cases/${caseId}/mandate`, {});

  // ---- report
  const failed = results.filter((r) => r.outcome === "FAIL");
  const skipped = results.filter((r) => r.outcome === "SKIP");
  console.log(`\nCase: ${caseId || "(none)"}${caseId ? `  ${BASE}/api/cases/${caseId}` : ""}`);
  console.log(`Timings: POST /api/cases/demo ${demoMs}ms; research (POST 202 → researched) ${researchMs}ms`);
  if (links.length) console.log(`On-ledger transactions (XRPL devnet):\n  ${links.join("\n  ")}`);
  console.log(`\n${results.length - failed.length - skipped.length} PASS, ${skipped.length} SKIP, ${failed.length} FAIL`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL ${f.name}: ${f.reason}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`FAIL  e2e crashed: ${(e as Error)?.stack ?? e}`);
  process.exit(1);
});
