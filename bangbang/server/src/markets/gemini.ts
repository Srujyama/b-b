// Gemini prediction markets -> Fed rate path -> "pay a discounted lump sum now, or take the payment plan?"
//
// Data (public, no auth): GET https://api.gemini.com/v1/prediction-markets/events?status=active&category=Economics
// Each FOMC meeting is one categorical event (ticker FEDyymmdd, e.g. FED261030) whose mutually exclusive contracts
// are the possible decisions (MAINTAIN, HIKE25, HIKEGT25, CUT25, CUTGT25). Prices are decimal strings in YES-space
// (0.86 = $0.86 per $1 payout).
//
// PRICE CHOICE (documented on purpose): per contract we use
//   1. the bid/ask MID when both bestBid and bestAsk exist (least biased live estimate),
//   2. else lastTradePrice,
//   3. else bestAsk alone (an upper bound — only illiquid tails hit this), else bestBid.
// The per-contract prices of one event never sum to exactly 1 (spread / overround), so we NORMALIZE them to
// probabilities that sum to 1 and report the raw overround.
//
// Current policy rate: FRED series DFEDTARU (Fed funds target range, upper limit) — public CSV, no key.
//
// Optional hedge: placeHedge() buys a small YES position in the Gemini SANDBOX only (never production).

import { need } from "../env.js";
import type { FinancingAdvice, Receipt, Source } from "../types.js";

export const GEMINI_PUBLIC_API = "https://api.gemini.com";
export const FED_EVENTS_URL = `${GEMINI_PUBLIC_API}/v1/prediction-markets/events?status=active&category=Economics`;
export const FRED_POLICY_RATE_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFEDTARU";
export const geminiEventUrl = (slug: string) => `https://www.gemini.com/predictions/${slug}`;

// ---------- shapes (local to this module; the shared one is FinancingAdvice in types.ts) ----------
export type RawPrices = {
  bestBid?: string;
  bestAsk?: string;
  lastTradePrice?: string;
  buy?: { yes?: string; no?: string };
  sell?: { yes?: string; no?: string };
};
export type RawContract = { label: string; ticker: string; instrumentSymbol: string; prices?: RawPrices; status?: string; marketState?: string };
export type RawEvent = { id: string; title: string; slug: string; ticker: string; category?: string; status?: string; expiryDate?: string; contracts?: RawContract[] };

export type PriceSource = "mid" | "last" | "ask" | "bid";
export type FedOutcome = {
  label: string;
  ticker: string; // contract ticker, e.g. HIKE25
  instrumentSymbol: string; // tradeable symbol as given by Gemini, e.g. GEMI-FED261030-HIKE25 (never built by us)
  bps: number | null; // policy-rate change this outcome means; null if the ticker isn't a recognised decision
  price: number; // YES price used (see PRICE CHOICE)
  priceSource: PriceSource;
  bestAsk?: number;
  prob: number; // normalized
};
export type FedMeeting = {
  eventTicker: string; // FED261030
  title: string;
  slug: string;
  url: string;
  decisionDate?: string; // ISO, parsed from the ticker (yymmdd)
  expiryDate?: string;
  outcomes: FedOutcome[]; // sorted by prob desc
  overround: number; // sum of raw prices before normalization
  expectedBps: number; // probability-weighted change at THIS meeting
};
export type FedOdds = { meetings: FedMeeting[]; fetchedAt: string; source: string };

// ---------- parsing (pure) ----------

/** Policy-rate change implied by a contract ticker. ">25bps" buckets are counted as 50bps (the next 25bp step). */
export function contractBps(ticker: string): number | null {
  const t = ticker.toUpperCase();
  if (t === "MAINTAIN" || t === "HOLD") return 0;
  const m = /^(HIKE|CUT)(GT)?(\d+)$/.exec(t);
  if (!m) return null;
  const n = Number(m[3]) + (m[2] ? 25 : 0);
  return m[1] === "HIKE" ? n : -n;
}

const num = (s?: string) => (s === undefined || s === null || s === "" || !Number.isFinite(Number(s)) ? undefined : Number(s));

/** YES price for one contract per the documented PRICE CHOICE, or null if the contract has no usable price. */
export function contractPrice(p: RawPrices | undefined): { price: number; source: PriceSource } | null {
  if (!p) return null;
  const bid = num(p.bestBid);
  const ask = num(p.bestAsk);
  const last = num(p.lastTradePrice);
  if (bid !== undefined && ask !== undefined && ask >= bid) return { price: (bid + ask) / 2, source: "mid" };
  if (last !== undefined) return { price: last, source: "last" };
  if (ask !== undefined) return { price: ask, source: "ask" };
  if (bid !== undefined) return { price: bid, source: "bid" };
  return null;
}

/** Scale non-negative weights to sum to 1. Throws on an all-zero vector rather than inventing probabilities. */
export function normalize(weights: number[]): number[] {
  const clean = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const sum = clean.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new Error("cannot normalize: no positive prices");
  return clean.map((w) => w / sum);
}

const FED_TICKER = /^FED(\d{2})(\d{2})(\d{2})$/;

/** FEDyymmdd -> ISO date of the decision (end of FOMC meeting window as Gemini names it). */
export function fedTickerDate(ticker: string): string | undefined {
  const m = FED_TICKER.exec(ticker);
  return m ? `20${m[1]}-${m[2]}-${m[3]}` : undefined;
}

/** Parse the events API response into Fed meetings with normalized outcome probabilities (nearest meeting first). */
export function parseFedEvents(json: unknown, fetchedAt = new Date().toISOString()): FedOdds {
  const data = (json as { data?: RawEvent[] })?.data;
  if (!Array.isArray(data)) throw new Error("Gemini events response has no data[] array");
  const meetings: FedMeeting[] = [];
  for (const ev of data) {
    if (!FED_TICKER.test(ev.ticker ?? "")) continue;
    const priced = (ev.contracts ?? [])
      .map((c) => ({ c, p: contractPrice(c.prices) }))
      .filter((x): x is { c: RawContract; p: { price: number; source: PriceSource } } => x.p !== null);
    if (!priced.length) continue;
    const overround = priced.reduce((a, x) => a + x.p.price, 0);
    const probs = normalize(priced.map((x) => x.p.price));
    const outcomes: FedOutcome[] = priced
      .map(({ c, p }, i) => ({
        label: c.label,
        ticker: c.ticker,
        instrumentSymbol: c.instrumentSymbol,
        bps: contractBps(c.ticker),
        price: p.price,
        priceSource: p.source,
        bestAsk: num(c.prices?.bestAsk),
        prob: probs[i],
      }))
      .sort((a, b) => b.prob - a.prob);
    meetings.push({
      eventTicker: ev.ticker,
      title: ev.title,
      slug: ev.slug,
      url: geminiEventUrl(ev.slug),
      decisionDate: fedTickerDate(ev.ticker),
      expiryDate: ev.expiryDate,
      outcomes,
      overround,
      expectedBps: meetingExpectedBps(outcomes),
    });
  }
  if (!meetings.length) throw new Error("no active Fed-decision markets (FEDyymmdd) found on Gemini");
  meetings.sort((a, b) => (a.decisionDate ?? a.eventTicker).localeCompare(b.decisionDate ?? b.eventTicker));
  return { meetings, fetchedAt, source: FED_EVENTS_URL };
}

/** Expected bps at one meeting over outcomes whose size we know (renormalized over those). */
export function meetingExpectedBps(outcomes: Pick<FedOutcome, "bps" | "prob">[]): number {
  const known = outcomes.filter((o) => o.bps !== null);
  const p = known.reduce((a, o) => a + o.prob, 0);
  if (p <= 0) return 0;
  return known.reduce((a, o) => a + (o.bps as number) * o.prob, 0) / p;
}

/** Cumulative market-implied policy-rate change (bps) across all listed meetings. Meetings are sequential
 *  decisions, so expectations add (E[sum] = sum of E). */
export function impliedRateChangeBps(odds: Pick<FedOdds, "meetings">): number {
  return odds.meetings.reduce((a, m) => a + m.expectedBps, 0);
}

// ---------- network ----------
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Live Fed-decision odds from Gemini's public prediction-markets API. */
export async function fetchFedOdds(fetchImpl: FetchLike = fetch): Promise<FedOdds> {
  const res = await fetchImpl(FED_EVENTS_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw Object.assign(new Error(`Gemini prediction-markets API returned ${res.status}`), { statusCode: 502 });
  return parseFedEvents(await res.json(), new Date().toISOString());
}

export type PolicyRate = { upperPct: number; date: string; source: string };

/** Parse FRED's CSV (header row, then DATE,VALUE rows; "." = missing) -> most recent value. */
export function parseFredCsv(csv: string): { date: string; value: number } {
  const rows = csv.trim().split(/\r?\n/).slice(1);
  for (let i = rows.length - 1; i >= 0; i--) {
    const [date, v] = rows[i].split(",");
    const value = Number(v);
    if (date && v !== "." && Number.isFinite(value)) return { date, value };
  }
  throw new Error("FRED CSV had no numeric observations");
}

/** Current Fed funds target (upper bound), from FRED. Public, no key. */
export async function fetchPolicyRate(fetchImpl: FetchLike = fetch): Promise<PolicyRate> {
  const res = await fetchImpl(FRED_POLICY_RATE_URL);
  if (!res.ok) throw Object.assign(new Error(`FRED DFEDTARU returned ${res.status}`), { statusCode: 502 });
  const { date, value } = parseFredCsv(await res.text());
  return { upperPct: value, date, source: FRED_POLICY_RATE_URL };
}

// ---------- the decision (pure) ----------

export type FinancingContext = {
  odds: FedOdds;
  policyRatePct: number; // current Fed funds target (upper), e.g. 4.0
  policyRateSource?: string;
  /** How she'd fund the lump sum: from savings (opportunity cost = savings yield ~ policy rate) or by
   *  borrowing on a medical credit card (variable APR = prime + margin; prime = policy rate + 3). */
  fundLumpSumWith?: "savings" | "card";
  cardMarginPct?: number; // card APR over prime; default 14 (typical card margin) — an assumption, shown in the reason
  planVariable?: boolean; // plan APR floats with the policy rate (in-house 0% plans are fixed: default false)
  now?: string; // ISO; defaults to odds.fetchedAt
};

const PRIME_SPREAD_PCT = 3; // US prime rate convention: Fed funds upper target + 3.00

/** Monthly payment for `principal` over `n` months at nominal `aprPct`. */
export function monthlyPayment(principal: number, aprPct: number, n: number): number {
  const i = aprPct / 100 / 12;
  if (Math.abs(i) < 1e-12) return principal / n;
  return (principal * i) / (1 - Math.pow(1 + i, -n));
}

/** Present value of `n` equal monthly payments discounted at nominal annual `ratePct`. */
export function presentValue(payment: number, ratePct: number, n: number): number {
  const r = ratePct / 100 / 12;
  let pv = 0;
  for (let t = 1; t <= n; t++) pv += payment / Math.pow(1 + r, t);
  return pv;
}

/** Average policy-rate change (bps) over the plan horizon: each meeting's expected change counts only for the
 *  share of the horizon after its decision date (a hike in month 11 barely matters for a 12-month plan). */
export function horizonAverageChangeBps(odds: Pick<FedOdds, "meetings">, nowIso: string, months: number): number {
  const now = Date.parse(nowIso);
  const end = now + months * 30.4375 * 864e5;
  let avg = 0;
  for (const m of odds.meetings) {
    const at = m.decisionDate ? Date.parse(m.decisionDate) : now;
    const from = Math.min(Math.max(at, now), end);
    avg += m.expectedBps * ((end - from) / (end - now || 1));
  }
  return avg;
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n: number, d = 1) => `${n.toFixed(d)}%`;

/**
 * PURE. Compare a discounted lump sum today vs. a `planMonths` plan at `planAprPct`, using the market-implied
 * rate path. Money paid later is worth less: we discount the plan's payments at her opportunity rate —
 * the savings yield (~ expected policy rate) if she pays from savings, or the variable card APR if she would
 * have to borrow the lump sum. Lump sum wins iff lumpSum < PV(plan payments).
 */
export function financingAdvice(
  balance: number,
  lumpSumDiscountPct: number,
  planMonths: number,
  planAprPct = 0,
  ctx: FinancingContext,
): FinancingAdvice & { detail: Record<string, number | string> } {
  if (!(balance > 0)) throw new Error("financingAdvice: balance must be > 0");
  if (!(planMonths >= 1)) throw new Error("financingAdvice: planMonths must be >= 1");
  if (lumpSumDiscountPct < 0 || lumpSumDiscountPct >= 100) throw new Error("financingAdvice: lumpSumDiscountPct must be in [0,100)");
  const now = ctx.now ?? ctx.odds.fetchedAt;
  const fundWith = ctx.fundLumpSumWith ?? "savings";
  const cardMargin = ctx.cardMarginPct ?? 14;

  const pathBps = impliedRateChangeBps(ctx.odds);
  const avgChangeBps = horizonAverageChangeBps(ctx.odds, now, planMonths);
  const expectedPolicyPct = ctx.policyRatePct + avgChangeBps / 100;
  const cardAprPct = expectedPolicyPct + PRIME_SPREAD_PCT + cardMargin;
  const oppRatePct = fundWith === "card" ? cardAprPct : expectedPolicyPct;
  const effPlanAprPct = planAprPct + (ctx.planVariable ? avgChangeBps / 100 : 0);

  const lumpSum = balance * (1 - lumpSumDiscountPct / 100);
  const payment = monthlyPayment(balance, effPlanAprPct, planMonths);
  const planNominal = payment * planMonths;
  const planPv = presentValue(payment, oppRatePct, planMonths);
  const breakEvenDiscountPct = (1 - planPv / balance) * 100;
  const lump = lumpSum < planPv;
  const edge = Math.abs(planPv - lumpSum);

  const near = ctx.odds.meetings[0];
  const top = near.outcomes[0];
  const oddsLine = near.outcomes.slice(0, 3).map((o) => `${o.label} ${pct(o.prob * 100, 0)}`).join(", ");
  const dir = pathBps > 0.5 ? "higher" : pathBps < -0.5 ? "lower" : "about flat";
  const dirZh = pathBps > 0.5 ? "上升" : pathBps < -0.5 ? "下降" : "基本不变";
  const fundEn = fundWith === "card" ? `borrowing it on a variable-rate medical credit card (~${pct(cardAprPct)} APR = prime + ${cardMargin}%)` : `paying from savings that would otherwise earn ~${pct(expectedPolicyPct, 2)}`;
  const fundZh = fundWith === "card" ? `用浮动利率的医疗信用卡借钱付（年利率约 ${pct(cardAprPct)}）` : `用存款支付（这笔钱存着大约能赚 ${pct(expectedPolicyPct, 2)}）`;
  const planEn = `${planMonths} payments of ${usd(payment)} at ${pct(effPlanAprPct)} APR${ctx.planVariable ? " (variable)" : ""}`;
  const planZh = `分 ${planMonths} 期，每月 ${usd(payment)}，年利率 ${pct(effPlanAprPct)}${ctx.planVariable ? "（浮动）" : ""}`;

  const reason =
    `Gemini's Fed markets (${near.title}: ${oddsLine}) imply rates ${dir} (${pathBps >= 0 ? "+" : ""}${pathBps.toFixed(1)} bps across ${ctx.odds.meetings.length} meeting${ctx.odds.meetings.length > 1 ? "s" : ""}; expected policy rate ~${pct(expectedPolicyPct, 2)} over the plan). ` +
    `Lump sum: ${usd(lumpSum)} today (${pct(lumpSumDiscountPct)} off), ${fundEn}. Plan: ${planEn} = ${usd(planNominal)}, worth ${usd(planPv)} in today's money. ` +
    (lump
      ? `The lump sum is cheaper by ${usd(edge)}; the plan would only win if the discount were under ${pct(breakEvenDiscountPct, 2)}.`
      : `The plan is cheaper by ${usd(edge)} in today's money; a lump sum would need a discount above ${pct(breakEvenDiscountPct, 2)} to win.`);
  const reasonZh =
    `根据 Gemini 预测市场（${near.title}：最可能的结果是「${top.label}」，概率 ${pct(top.prob * 100, 0)}），市场预计利率${dirZh}（合计 ${pathBps >= 0 ? "+" : ""}${pathBps.toFixed(1)} 个基点）。` +
    `一次性付清：今天付 ${usd(lumpSum)}（打 ${pct(lumpSumDiscountPct)} 折扣），${fundZh}。分期：${planZh}，共 ${usd(planNominal)}，折算成今天的钱约 ${usd(planPv)}。` +
    (lump ? `建议一次性付清，可以省 ${usd(edge)}。` : `建议选择分期付款，按今天的钱算可以省 ${usd(edge)}。`);

  const sources: Source[] = ctx.odds.meetings.map((m) => ({
    title: `Gemini prediction market: ${m.title} (${m.eventTicker})`,
    url: m.url,
    snippet: m.outcomes.map((o) => `${o.label} ${pct(o.prob * 100, 1)}`).join(", "),
    via: "gemini" as const,
  }));
  sources.push({ title: "Gemini prediction-markets API (raw prices)", url: ctx.odds.source, via: "gemini" });
  if (ctx.policyRateSource) sources.push({ title: `Fed funds target, upper (FRED DFEDTARU): ${pct(ctx.policyRatePct, 2)}`, url: ctx.policyRateSource, via: "other" });

  return {
    recommendation: lump ? "lump_sum" : "payment_plan",
    reason,
    reasonZh,
    fedOdds: {
      market: near.title,
      ticker: near.eventTicker,
      outcomes: near.outcomes.map((o) => ({ label: o.label, prob: Math.round(o.prob * 10000) / 10000 })),
      fetchedAt: ctx.odds.fetchedAt,
    },
    expectedRatePath: Math.round(pathBps * 10) / 10,
    sources,
    detail: {
      balance,
      lumpSum: round2(lumpSum),
      monthlyPayment: round2(payment),
      planNominal: round2(planNominal),
      planPresentValue: round2(planPv),
      opportunityRatePct: round2(oppRatePct),
      expectedPolicyRatePct: round2(expectedPolicyPct),
      cardAprPct: round2(cardAprPct),
      breakEvenDiscountPct: round2(breakEvenDiscountPct),
      fundLumpSumWith: fundWith,
    },
  };
}
const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------- optional: sandbox hedge ----------

/** The outcome that hurts a variable-rate plan: the most likely HIKE at the nearest meeting that has one. */
export function pickHedgeOutcome(odds: FedOdds): { meeting: FedMeeting; outcome: FedOutcome } {
  for (const meeting of odds.meetings) {
    const hikes = meeting.outcomes.filter((o) => (o.bps ?? 0) > 0).sort((a, b) => b.prob - a.prob);
    if (hikes.length) return { meeting, outcome: hikes[0] };
  }
  throw new Error("no hike outcome listed in any Fed market — nothing to hedge");
}

/**
 * Buy a small YES position on the hike outcome in the Gemini SANDBOX (env is hard-wired to "sandbox").
 * The symbol is taken from the sandbox's own event listing (instrumentSymbol), never constructed.
 */
export async function placeHedge(opts: { quantity?: string; odds?: FedOdds } = {}): Promise<Receipt> {
  const apiKey = need("GEMINI_API_KEY");
  const apiSecret = need("GEMINI_API_SECRET");
  const odds = opts.odds ?? (await fetchFedOdds());
  const { meeting, outcome } = pickHedgeOutcome(odds);
  const { createClient, HmacAuth } = await import("@gemini-markets/sdk/server");
  const gemini = await createClient({ env: "sandbox", auth: new HmacAuth({ apiKey, apiSecret }) });

  // Find the same event + contract in the sandbox listing (sandbox can list different events than production).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listed: any = await gemini.predictions.listEvents({ status: ["active"] } as never);
  const events: RawEvent[] = listed?.data ?? [];
  const ev = events.find((e) => e.ticker === meeting.eventTicker);
  const contract = ev?.contracts?.find((c) => c.ticker === outcome.ticker);
  if (!contract?.instrumentSymbol) {
    throw Object.assign(new Error(`Gemini sandbox does not list ${meeting.eventTicker}/${outcome.ticker} — cannot hedge`), { statusCode: 502 });
  }
  const sandboxPrice = contractPrice(contract.prices);
  const limit = num(contract.prices?.bestAsk) ?? sandboxPrice?.price ?? outcome.bestAsk ?? outcome.price;
  const price = Math.min(0.99, Math.max(0.01, Math.round(limit * 100) / 100)).toFixed(2);
  const quantity = opts.quantity ?? "1";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p: any = gemini.predictions;
  const terms = await p.getPredictionMarketsTermsStatus?.();
  if (terms && terms.hasAcceptedLatest === false) await p.acceptTerms();
  const order = await p.placeOrder({ symbol: contract.instrumentSymbol, orderType: "limit", side: "buy", outcome: "yes", price, quantity });
  const orderId = String(order?.orderId ?? order?.id ?? "");
  if (!orderId) throw Object.assign(new Error(`Gemini sandbox order returned no orderId: ${JSON.stringify(order)}`), { statusCode: 502 });
  return {
    chain: "gemini",
    kind: "prediction-hedge-order",
    txHash: orderId,
    explorerUrl: "https://exchange.sandbox.gemini.com/",
    detail: { env: "sandbox", symbol: contract.instrumentSymbol, outcome: "yes", label: outcome.label, price, quantity, marketProb: outcome.prob, status: order?.status },
    at: new Date().toISOString(),
  };
}
