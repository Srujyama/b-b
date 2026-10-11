// One-button pipeline: POST /api/cases/:id/run drives the whole patient flow and reports progress over /ws.
//
//   research (fair prices bought over x402 in AUSD when the agent wallet is configured)
//   -> financing (Gemini Fed odds) -> BNB mandate -> XRPL hardship credential
//   -> negotiate (agent-vs-agent bridge, or wait for a human billing rep) while every offer and transcript
//      turn is hash-chained onto the BNB AdvocateLedger
//   -> [0% community-fund loan if Gemini says payment plan] -> XRPL escrow -> BNB recordDeal(ref = escrow tx)
//   -> hospital confirms a zero balance (Batch release) -> settled
//      (simulated by the pipeline by default; confirm:"portal" or PIPELINE_HOSPITAL_CONFIRM=portal waits for real
//       billing staff to confirm in /hospital.html, see routes/hospital.ts)
//
// Each step reuses the public route (via app.inject) or the module function, so the pipeline runs the exact
// code the individual buttons run. Every step emits an en+zh log; a failed step is reported (error event +
// GET /api/cases/:id/run), never hidden. Only research and negotiation are fatal; the rest degrade loudly.
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { opt } from "../env.js";
import { emit, requireCase, subscribe, updateCase } from "../store.js";
import type { CaseEvent, CasePacket, FairPrice, FinancingAdvice, Receipt } from "../types.js";
import { researchCase } from "./research.js";
import { paidFetch, type FetchLike } from "../chain/x402.js";
import { appendLog, recordDeal, type LedgerEntryBody } from "../chain/bnb.js";
import { defaultCtx, escrowFor, usdBalance } from "../chain/xrpl.js";
import { activeBridge, startAgentBridge } from "../agent/bridge.js";
import { FAIR_PRICE_AUSD } from "./x402.js";
import { orderFactsByLeverage, rankLeverage } from "../engine/leverage.js";

export type Counterparty = "agent" | "human";
export type StepName = "research" | "financing" | "mandate" | "credential" | "negotiate" | "loan" | "settle" | "recordDeal" | "confirm";
export type StepStatus = "pending" | "running" | "ok" | "skipped" | "failed";
export type StepState = { name: StepName; status: StepStatus; message?: string; startedAt?: string; endedAt?: string };
export type RunState = {
  caseId: string;
  counterparty: Counterparty;
  status: "running" | "done" | "failed";
  steps: StepState[];
  startedAt: string;
  endedAt?: string;
  error?: string;
  /** Set while the run is parked waiting on someone outside the pipeline (the hospital portal). */
  awaiting?: "hospital-portal";
};
/**
 * confirm: true = the pipeline confirms the $0 balance itself (simulated hospital, the demo default);
 *          false = skip it, leave it to POST /confirm-zero-balance;
 *          "portal" = WAIT for hospital staff to confirm in /hospital.html (up to hospitalTimeoutMs, default 30 min).
 * When a run omits `confirm`, PIPELINE_HOSPITAL_CONFIRM ("simulate" | "portal", default simulate) decides.
 */
export type ConfirmMode = boolean | "portal";
export type RunOptions = {
  counterparty?: Counterparty;
  confirm?: ConfirmMode;
  loanMonths?: number;
  humanTimeoutMs?: number;
  drainTimeoutMs?: number;
  hospitalTimeoutMs?: number;
};

type LogBody = Omit<LedgerEntryBody, "seq" | "at"> & { at?: string };

/** Everything the pipeline touches, injectable so the orchestration is unit-tested with no keys. */
export type PipelineDeps = {
  research(id: string): Promise<unknown>;
  financing(id: string): Promise<FinancingAdvice>;
  mandate(id: string): Promise<unknown>;
  credential(id: string): Promise<unknown>;
  /** Resolves when the call is over (deal or not). */
  negotiate(id: string, counterparty: Counterparty, opts: { humanTimeoutMs: number }): Promise<void>;
  loan(id: string, months: number): Promise<unknown>;
  settle(id: string): Promise<Receipt[]>;
  recordDeal(id: string, amountUsd: number, settlementRef: string): Promise<unknown>;
  confirm(id: string): Promise<unknown>;
  /** tx hash of the case's open XRPL escrow, if any */
  openEscrow(id: string): string | undefined;
  appendLog(id: string, body: LogBody): Promise<unknown>;
  bnbConfigured(): boolean;
  fundConfigured(): boolean;
  /** The patient wallet's spendable USD (XRPL). Optional: when absent or failing, only the advice decides the loan. */
  patientWalletUsd?(id: string): Promise<number>;
};

const STEP_ZH: Record<StepName, string> = {
  research: "查合理价格和慈善政策",
  financing: "看一次付清还是分期",
  mandate: "在 BNB 链上记录您的授权",
  credential: "在 XRPL 上签发经济困难证明",
  negotiate: "用英语和医院谈价钱",
  loan: "从互助基金开 0% 分期",
  settle: "把钱放进 XRPL 托管",
  recordDeal: "在 BNB 链上记录协议",
  confirm: "医院确认余额为零",
};
const STEP_EN: Record<StepName, string> = {
  research: "Research fair prices + charity policy",
  financing: "Lump sum vs payment plan (Gemini Fed odds)",
  mandate: "Record the patient's mandate on BNB Chain",
  credential: "Issue the hardship credential on XRPL",
  negotiate: "Negotiate with the billing office (in English)",
  loan: "Open a 0% community-fund loan (XRPL)",
  settle: "Lock the agreed amount in XRPL escrow",
  recordDeal: "Record the deal on BNB Chain",
  confirm: "Hospital confirms a $0 balance (escrow release)",
};
const PATIENT_STEPS: StepName[] = ["research", "financing", "mandate", "credential", "negotiate", "loan", "settle", "recordDeal", "confirm"];
const CLINIC_STEPS: StepName[] = ["negotiate"];

const runs = new Map<string, RunState>();
export const getRun = (caseId: string) => runs.get(caseId);
/** Test hook. */
export const _resetRuns = () => runs.clear();

const has = (k: string) => Boolean(opt(k));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const httpError = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

/** The confirm mode for a run that does not pick one (env PIPELINE_HOSPITAL_CONFIRM). Invalid values fail loudly. */
export function defaultConfirmMode(): ConfirmMode {
  const v = (opt("PIPELINE_HOSPITAL_CONFIRM") ?? "").trim().toLowerCase();
  if (v === "portal") return "portal";
  if (v === "simulate" || v === "") return true;
  throw httpError(`PIPELINE_HOSPITAL_CONFIRM=${v} is not valid — set it to "simulate" or "portal"`, 500);
}

/** Synchronous preconditions — a bad request gets an HTTP error instead of a background failure. */
export function assertRunnable(c: CasePacket) {
  if (runs.get(c.id)?.status === "running") throw httpError("a pipeline run is already in progress for this case", 409);
  if (c.mode === "clinic") {
    if (!c.claim) throw httpError("clinic case has no claim — POST /api/claims first", 409);
    return;
  }
  if (!c.bill) throw httpError("case has no parsed bill — POST /api/cases first", 409);
  if (!c.patient) throw httpError("case has no patient — complete intake first", 409);
  if (!c.patient.consent) throw httpError("the patient has not consented — Vellum will not act for her", 409);
  if (!(c.patient.maxPay > 0)) throw httpError("the patient has no spending mandate (patient.maxPay must be > 0)", 409);
}

/** Subscribes to the case's event bus like a WS client and hash-chains each offer / transcript turn onto BNB. */
export function ledgerSink(caseId: string, append: PipelineDeps["appendLog"], onError: (e: unknown) => void) {
  const closers: (() => void)[] = [];
  let chain: Promise<void> = Promise.resolve();
  let pending = 0;
  let landed = 0;
  let failedCount = 0;
  const sock = {
    readyState: 1,
    send(data: string) {
      let ev: CaseEvent;
      try {
        ev = JSON.parse(data) as CaseEvent;
      } catch {
        return;
      }
      let body: LogBody | undefined;
      if (ev.type === "offer") {
        body = { kind: "offer", by: ev.offer.by, amount: ev.offer.amount, ...(ev.offer.note ? { text: ev.offer.note } : {}), at: ev.offer.at };
      } else if (ev.type === "transcript") {
        body = { kind: "transcript", by: ev.line.role, text: ev.line.text, at: ev.line.at };
      }
      if (!body) return;
      const b = body;
      pending++;
      chain = chain
        .then(() => append(caseId, b))
        .then(
          () => void landed++,
          (e) => {
            if (failedCount++ === 0) onError(e);
          },
        )
        .finally(() => void pending--);
    },
    on(event: string, cb: () => void) {
      if (event === "close") closers.push(cb);
    },
  };
  subscribe(caseId, sock as unknown as WebSocket);
  return {
    close() {
      sock.readyState = 3;
      for (const c of closers) c();
    },
    drain: () => chain,
    stats: () => ({ pending, landed, failed: failedCount }),
  };
}

function waitFor(cond: () => boolean, timeoutMs: number, everyMs = Math.max(20, Math.min(500, timeoutMs / 10))): Promise<boolean> {
  return new Promise((resolve) => {
    if (cond()) return resolve(true);
    const started = Date.now();
    const t = setInterval(() => {
      if (cond()) {
        clearInterval(t);
        resolve(true);
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(t);
        resolve(false);
      }
    }, everyMs);
  });
}

const timeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref?.())]);

/**
 * Run the pipeline for a case. Resolves with the final RunState (never rejects: failures are recorded on it).
 * Call assertRunnable first if you want HTTP-style precondition errors.
 */
export async function runPipeline(caseId: string, deps: PipelineDeps, opts: RunOptions = {}): Promise<RunState> {
  const c = requireCase(caseId);
  const counterparty: Counterparty = opts.counterparty ?? "agent";
  const names = c.mode === "clinic" ? CLINIC_STEPS : PATIENT_STEPS;
  const run: RunState = {
    caseId,
    counterparty,
    status: "running",
    steps: names.map((name) => ({ name, status: "pending" })),
    startedAt: new Date().toISOString(),
  };
  runs.set(caseId, run);
  const log = (message: string, messageZh: string) => emit(caseId, { type: "log", message, messageZh });
  const step = (n: StepName) => run.steps.find((s) => s.name === n)!;
  const hasReceipt = (kind: string) => requireCase(caseId).receipts.some((r) => r.kind === kind);

  const skip = (n: StepName, why: string, whyZh: string) => {
    Object.assign(step(n), { status: "skipped", message: why, endedAt: new Date().toISOString() });
    log(`Skipped: ${STEP_EN[n]} — ${why}`, `跳过：${STEP_ZH[n]}（${whyZh}）`);
  };
  /** Run one step; returns its result, or undefined if it failed (already reported). */
  const exec = async <T>(n: StepName, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
    const s = step(n);
    Object.assign(s, { status: "running", startedAt: new Date().toISOString() });
    log(`Step: ${STEP_EN[n]}`, `下一步：${STEP_ZH[n]}`);
    try {
      const value = await fn();
      Object.assign(s, { status: "ok", endedAt: new Date().toISOString() });
      return { ok: true, value };
    } catch (e) {
      const error = errMsg(e);
      Object.assign(s, { status: "failed", message: error, endedAt: new Date().toISOString() });
      emit(caseId, { type: "error", message: `${STEP_EN[n]} failed: ${error}` });
      log(`Failed: ${STEP_EN[n]} — ${error}`, `这一步没成功：${STEP_ZH[n]}（详见英文错误）`);
      return { ok: false, error };
    }
  };
  const finish = (status: RunState["status"], error?: string) => {
    run.status = status;
    run.endedAt = new Date().toISOString();
    if (error) run.error = error;
    for (const s of run.steps) if (s.status === "pending") Object.assign(s, { status: "skipped", message: s.message ?? "not reached" });
    if (status === "done") log("Pipeline finished", "全部流程完成");
    else log(`Pipeline stopped: ${error}`, "流程中止了，详见错误信息");
    return run;
  };

  log(
    c.mode === "clinic" ? "Starting the clinic appeal call" : `Running everything for ${c.patient?.name ?? "the patient"} (counterparty: ${counterparty})`,
    "Vellum 开始一步一步帮您办理",
  );

  // ---------------- clinic: the appeal is already drafted at intake; argue it with the insurer ----------------
  if (c.mode === "clinic") {
    const r = await exec("negotiate", () => deps.negotiate(caseId, counterparty, { humanTimeoutMs: opts.humanTimeoutMs ?? 10 * 60_000 }));
    if (!r.ok) return finish("failed", r.error);
    return finish("done");
  }

  // ---------------- research (fatal) ----------------
  const pre = requireCase(caseId);
  if (pre.target != null && pre.facts.length) skip("research", "already researched", "已经查过了");
  else {
    const r = await exec("research", () => deps.research(caseId));
    if (!r.ok) {
      updateCase(caseId, { status: "failed" });
      return finish("failed", `research failed: ${r.error}`);
    }
  }

  // ---------------- lead with the strongest leverage (engine/leverage.ts: reorders, never drops a fact) ----------------
  try {
    const researched = requireCase(caseId);
    const ordered = orderFactsByLeverage(researched);
    if (ordered.length === researched.facts.length && ordered.some((f, i) => f !== researched.facts[i])) {
      updateCase(caseId, { facts: ordered });
      const top = rankLeverage(researched)[0];
      if (top) emit(caseId, { type: "log", message: `Facts ordered by leverage: leading with ${top.kind.replace(/_/g, " ")} ($${Math.round(top.amountAtStake).toLocaleString("en-US")} at stake)` });
    }
  } catch (e) {
    emit(caseId, { type: "error", message: `leverage ranking failed (facts left in research order): ${errMsg(e)}` });
  }

  // ---------------- financing (Gemini) ----------------
  const fin = await exec("financing", () => deps.financing(caseId));
  const advice = fin.ok ? fin.value : requireCase(caseId).financing;

  // ---------------- BNB mandate ----------------
  let mandateOk = hasReceipt("openMandate");
  if (mandateOk) skip("mandate", "mandate already on-chain", "授权已经在链上");
  else if (!deps.bnbConfigured())
    skip("mandate", "BNB Chain is built but not live here (set BSC_PRIVATE_KEY + ADVOCATE_LEDGER_ADDRESS); the off-chain mandate guard still refuses any amount above her cap", "BNB 链还没上线；Vellum 仍然不会同意超过您上限的金额");
  else {
    const r = await exec("mandate", () => deps.mandate(caseId));
    mandateOk = r.ok;
    if (!r.ok) log("Continuing with the off-chain mandate guard only (accept is still refused above her cap)", "链上授权没成功，但 Vellum 仍然不会同意超过您上限的金额");
  }

  // ---------------- XRPL hardship credential ----------------
  if (hasReceipt("CredentialAccept")) skip("credential", "credential already accepted", "证明已经签发");
  else await exec("credential", () => deps.credential(caseId));

  // ---------------- negotiation (fatal if no deal) ----------------
  let sink: ReturnType<typeof ledgerSink> | undefined;
  if (requireCase(caseId).agreedAmount != null) skip("negotiate", `deal already agreed at $${requireCase(caseId).agreedAmount}`, "已经谈好了");
  else {
    if (mandateOk && deps.bnbConfigured()) {
      sink = ledgerSink(caseId, deps.appendLog, (e) =>
        emit(caseId, { type: "error", message: `BNB negotiation log append failed: ${errMsg(e)}` }),
      );
      log("Every offer and transcript turn will be hash-chained onto the BNB AdvocateLedger", "每一次报价和每句话都会被加密记录在 BNB 链上，无法篡改");
    }
    const r = await exec("negotiate", () => deps.negotiate(caseId, counterparty, { humanTimeoutMs: opts.humanTimeoutMs ?? 10 * 60_000 }));
    sink?.close();
    const agreed = requireCase(caseId).agreedAmount;
    if (!r.ok || agreed == null) {
      const why = r.ok ? "the call ended without a deal" : r.error;
      if (r.ok) Object.assign(step("negotiate"), { status: "failed", message: why });
      // Never leave the case parked in "negotiating": nothing was agreed or paid and the research still holds,
      // so put it back to "researched" and say how to retry.
      const now = requireCase(caseId);
      updateCase(caseId, { status: now.target != null && now.facts.length ? "researched" : "failed" });
      log(
        `No deal on this call (${why}). Nothing was agreed and nothing was paid; the case is back to researched — run it again to retry the call`,
        "这次通话没有谈成。没有达成协议，也没有付钱。可以再试一次。",
      );
      return finish("failed", why);
    }
    log(`Deal agreed at $${agreed}`, `谈好了：${agreed} 美元`);
  }
  const amount = requireCase(caseId).agreedAmount!;
  const writeOff = amount === 0;

  // ---------------- optional 0% loan: Gemini said payment plan, or her wallet cannot cover the deal ----------------
  const wantsPlan = advice?.recommendation === "payment_plan";
  let short: { have: number } | undefined;
  if (!writeOff && !wantsPlan && deps.patientWalletUsd && !deps.openEscrow(caseId) && !hasReceipt("LoanSet")) {
    try {
      const have = await deps.patientWalletUsd(caseId);
      if (have < amount) short = { have };
    } catch (e) {
      emit(caseId, { type: "error", message: `could not read the patient wallet balance (the escrow step checks it again): ${errMsg(e)}` });
    }
  }
  if (writeOff) skip("loan", "nothing to pay: the balance was written off", "不用付钱");
  else if (hasReceipt("LoanSet")) skip("loan", "0% loan already open", "分期已经开好");
  else if (!wantsPlan && !short) skip("loan", "her wallet covers the deal and the Gemini odds favour paying the lump sum", "钱包够用，一次付清更划算");
  else if (!deps.fundConfigured()) skip("loan", "XRPL community fund not configured — set XRPL_VAULT_ID and XRPL_LOAN_BROKER_ID (npm run setup:xrpl)", "互助基金还没设置");
  else {
    if (short) log(`Her wallet holds $${short.have} but the deal is $${amount}: opening a 0% community-fund loan first`, "您的钱包不够付，先从互助基金开 0% 分期");
    await exec("loan", () => deps.loan(caseId, opts.loanMonths ?? 12));
  }

  // ---------------- XRPL escrow ----------------
  let escrowTx = deps.openEscrow(caseId);
  if (escrowTx) skip("settle", "escrow already open", "托管已经建立");
  else if (requireCase(caseId).status === "settled") skip("settle", "already settled", "已经结清");
  else if (writeOff) skip("settle", "the deal is $0 (a write-off): no money moves, so there is nothing to escrow", "全额减免，不用托管");
  else {
    const r = await exec("settle", () => deps.settle(caseId));
    if (r.ok) escrowTx = r.value.find((x) => x.kind === "EscrowCreate")?.txHash ?? r.value[0]?.txHash;
  }

  // ---------------- BNB deal record (after the log has landed) ----------------
  if (hasReceipt("recordDeal")) skip("recordDeal", "deal already recorded", "协议已经记录");
  else if (!mandateOk) skip("recordDeal", "no on-chain mandate for this case", "链上没有授权记录");
  else {
    if (sink && sink.stats().pending > 0) {
      log(`Waiting for ${sink.stats().pending} negotiation log entries to land on BNB`, "等谈判记录全部上链");
      if (!(await timeout(sink.drain(), opts.drainTimeoutMs ?? 120_000)))
        emit(caseId, { type: "error", message: `BNB log still has ${sink.stats().pending} entries in flight; recording the deal anyway` });
    }
    await exec("recordDeal", () => deps.recordDeal(caseId, amount, escrowTx ?? (writeOff ? "write-off (no escrow)" : "unsettled (XRPL escrow failed)")));
  }

  // ---------------- hospital confirms $0 → Batch release (a write-off just confirms: no escrow) ----------------
  const settledNow = () => requireCase(caseId).status === "settled";
  if (settledNow()) skip("confirm", "already settled", "已经结清");
  else if (!deps.openEscrow(caseId) && !writeOff) skip("confirm", "no open escrow to release", "没有可放行的托管");
  else if (opts.confirm === false) skip("confirm", "left for the hospital to confirm (POST /confirm-zero-balance)", "等医院确认");
  else if (opts.confirm === "portal") {
    const waitMs = opts.hospitalTimeoutMs ?? 30 * 60_000;
    await exec("confirm", async () => {
      run.awaiting = "hospital-portal";
      step("confirm").message = "waiting for the hospital to confirm in the hospital portal";
      log(
        "Waiting for the hospital to confirm in the hospital portal: billing staff check the account is at $0, then release the escrow",
        "正在等医院在医院端确认：医院工作人员核对您的账户余额为零后，托管款才会放行",
      );
      try {
        const released = await waitFor(() => (writeOff ? settledNow() : !deps.openEscrow(caseId) || settledNow()), waitMs);
        if (!released)
          throw new Error(
            `the hospital did not confirm in the hospital portal within ${Math.max(1, Math.round(waitMs / 60_000))} min — ${writeOff ? "nothing was paid" : "the money stays locked in escrow"} and the hospital can still confirm at /hospital.html`,
          );
      } finally {
        delete run.awaiting;
      }
      step("confirm").message = "confirmed by the hospital in the hospital portal";
      log("The hospital confirmed a $0 balance in the hospital portal", "医院已在医院端确认您的余额为零");
    });
  } else {
    log("Hospital billing confirms the account is at $0 (demo: the hospital side is simulated)", "医院确认您的账户余额为零（示范：医院一方是模拟的）");
    await exec("confirm", () => deps.confirm(caseId));
  }

  const failed = run.steps.filter((s) => s.status === "failed").map((s) => s.name);
  if (failed.length) log(`Finished with ${failed.length} failed step(s): ${failed.join(", ")}`, `完成了，但有 ${failed.length} 步没成功`);
  return finish("done");
}

// ---------------------------------------------------------------- default (live) dependencies

/** fetch over app.inject: lets our own agent pay our own x402 endpoint without knowing the listen address. */
export function injectFetch(app: FastifyInstance): FetchLike {
  return async (url, init = {}) => {
    const u = new URL(url, "http://vellum.local");
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const res = await app.inject({
      method: (init.method ?? "GET") as "GET",
      url: u.pathname + u.search,
      headers,
      ...(init.body != null ? { payload: init.body as string } : {}),
    });
    const h = new Headers();
    for (const [k, v] of Object.entries(res.headers)) if (v != null) h.set(k, Array.isArray(v) ? v.join(", ") : String(v));
    return new Response(res.statusCode === 204 ? null : new Uint8Array(res.rawPayload), { status: res.statusCode, headers: h });
  };
}

/** The advocate buys each fair-price lookup from the paywalled endpoint, paying AUSD per call. */
export function paidFairPrice(caseId: string, fetchImpl: FetchLike) {
  return async (code: string, description: string, hospital?: string): Promise<FairPrice> => {
    const qs = new URLSearchParams({ code, description, case: caseId, ...(hospital ? { hospital } : {}) });
    const { response, paid } = await paidFetch(`/x402/fair-price?${qs}`, {}, { fetchImpl });
    const data = (await response.json().catch(() => ({}))) as FairPrice & { error?: string };
    if (!response.ok) throw new Error(data.error ?? `x402 fair-price returned ${response.status}`);
    if (paid?.success)
      emit(caseId, { type: "log", message: `Paid ${FAIR_PRICE_AUSD} AUSD over x402 for ${code} (tx ${paid.transaction})`, messageZh: `Vellum 用 AUSD 付了 ${FAIR_PRICE_AUSD} 的数据费（${code}）` });
    return data;
  };
}

async function call<T>(app: FastifyInstance, url: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await app.inject({ method: "POST", url, payload: body });
  let data: any;
  try {
    data = res.json();
  } catch {
    data = { error: res.body };
  }
  if (res.statusCode >= 400) throw httpError(data?.message ?? data?.error ?? `${url} → ${res.statusCode}`, res.statusCode); // fastify default errors carry {message}, ours {error}
  return data as T;
}

export function liveDeps(app: FastifyInstance): PipelineDeps {
  const x402Ready = () => has("AGENT_EVM_PRIVATE_KEY") && has("PAYEE_EVM_PRIVATE_KEY");
  return {
    async research(id) {
      if (x402Ready()) {
        emit(id, { type: "log", message: `The advocate pays for its own data: ${FAIR_PRICE_AUSD} AUSD per fair-price lookup over x402 (Base Sepolia)`, messageZh: "Vellum 自己用 AUSD 付数据费" });
        return researchCase(id, { lookup: paidFairPrice(id, injectFetch(app)) });
      }
      emit(id, {
        type: "log",
        message: "x402 not configured (set AGENT_EVM_PRIVATE_KEY + PAYEE_EVM_PRIVATE_KEY) — looking prices up directly, unpaid",
        messageZh: "AUSD 支付未设置，直接查询价格",
      });
      return researchCase(id);
    },
    financing: (id) => call<FinancingAdvice>(app, `/api/cases/${id}/financing`),
    mandate: (id) => call(app, `/api/cases/${id}/mandate`),
    credential: (id) => call(app, `/api/cases/${id}/credential`),
    async negotiate(id, counterparty, { humanTimeoutMs }) {
      const c = requireCase(id);
      if (counterparty === "agent") {
        const handle = activeBridge(id) ?? (await startAgentBridge(id, c.mode === "clinic" ? "insurer" : "hospital"));
        await handle.done;
        return;
      }
      emit(id, {
        type: "log",
        message: "Waiting for the human billing rep: open the negotiation room and start the call",
        messageZh: "等待医院工作人员接通电话",
      });
      const ok = await waitFor(() => c.agreedAmount != null || c.status === "failed", humanTimeoutMs);
      if (!ok) throw new Error(`no outcome from the human call within ${Math.round(humanTimeoutMs / 60_000)} min`);
    },
    loan: (id, months) => call(app, `/api/cases/${id}/loan`, { months }),
    settle: (id) => call<Receipt[]>(app, `/api/cases/${id}/settle`),
    recordDeal: (id, amount, ref) => recordDeal(id, amount, ref),
    confirm: (id) => call(app, `/api/cases/${id}/confirm-zero-balance`),
    openEscrow: (id) => escrowFor(id)?.txHash,
    async patientWalletUsd() {
      const ctx = await defaultCtx();
      return usdBalance(ctx, ctx.actors.patient.address);
    },
    appendLog: (id, body) => appendLog(id, body),
    bnbConfigured: () => has("BSC_PRIVATE_KEY") && has("ADVOCATE_LEDGER_ADDRESS"),
    fundConfigured: () => has("XRPL_VAULT_ID") && has("XRPL_LOAN_BROKER_ID"),
  };
}

// ---------------------------------------------------------------- routes

export default async function pipelineRoutes(app: FastifyInstance, opts: { deps?: PipelineDeps } = {}) {
  app.post<{ Params: { id: string }; Body: RunOptions | null }>("/api/cases/:id/run", async (req, reply) => {
    try {
      const c = requireCase(req.params.id);
      const b = req.body ?? {};
      const counterparty = b.counterparty ?? "agent";
      if (counterparty !== "agent" && counterparty !== "human") return reply.code(400).send({ error: "counterparty must be 'agent' or 'human'" });
      const confirm = b.confirm ?? defaultConfirmMode();
      if (confirm !== true && confirm !== false && confirm !== "portal") return reply.code(400).send({ error: 'confirm must be true, false or "portal"' });
      if (b.hospitalTimeoutMs != null && !(Number(b.hospitalTimeoutMs) > 0)) return reply.code(400).send({ error: "hospitalTimeoutMs must be a positive number of milliseconds" });
      assertRunnable(c);
      const deps = opts.deps ?? liveDeps(app);
      const done = runPipeline(c.id, deps, { ...b, counterparty, confirm });
      void done.catch((e) => emit(c.id, { type: "error", message: `pipeline crashed: ${errMsg(e)}` }));
      return reply.code(202).send({ started: true, caseId: c.id, counterparty, confirm, steps: getRun(c.id)?.steps.map((s) => s.name) ?? [] });
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  app.get<{ Params: { id: string } }>("/api/cases/:id/run", async (req, reply) => {
    const r = getRun(req.params.id);
    return r ?? reply.code(404).send({ error: "no pipeline run for this case — POST /api/cases/:id/run" });
  });
}
