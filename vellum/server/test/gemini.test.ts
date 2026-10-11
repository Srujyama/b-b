import { describe, it, expect, vi, afterEach } from "vitest";
import Fastify from "fastify";
import {
  contractBps,
  contractPrice,
  normalize,
  parseFedEvents,
  fetchFedOdds,
  impliedRateChangeBps,
  financingAdvice,
  parseFredCsv,
  pickHedgeOutcome,
  pickProxyHedge,
  monthlyPayment,
  presentValue,
  FED_EVENTS_URL,
  type FedOdds,
} from "../src/markets/gemini.js";
import { createCase } from "../src/store.js";
import marketsRoutes from "../src/routes/markets.js";

// RECORDED FIXTURE — real response of
// GET https://api.gemini.com/v1/prediction-markets/events?status=active&category=Economics captured 2026-10-11
// (trimmed to the two FED events + one non-Fed event; long contract descriptions dropped, all prices verbatim).
const FIXTURE = {
  "data": [
    {
      "id": "255554",
      "title": "Fed decision in October?",
      "slug": "fed-decision-in-october",
      "type": "categorical",
      "category": "Economics",
      "ticker": "FED261030",
      "status": "active",
      "expiryDate": "2026-10-30T04:00:00.000Z",
      "contracts": [
        {
          "id": "255554-634771",
          "label": "Fed maintains rate",
          "prices": {
            "buy": {
              "yes": "0.86",
              "no": "0.18"
            },
            "sell": {
              "yes": "0.82",
              "no": "0.14"
            },
            "bestBid": "0.82",
            "bestAsk": "0.86",
            "lastTradePrice": "0.86"
          },
          "status": "active",
          "ticker": "MAINTAIN",
          "instrumentSymbol": "GEMI-FED261030-MAINTAIN",
          "marketState": "open",
          "expiryDate": "2026-10-30T04:00:00.000Z"
        },
        {
          "id": "255554-634701",
          "label": "Hike 25bps",
          "prices": {
            "buy": {
              "yes": "0.17",
              "no": "0.86"
            },
            "sell": {
              "yes": "0.14",
              "no": "0.83"
            },
            "bestBid": "0.14",
            "bestAsk": "0.17",
            "lastTradePrice": "0.14"
          },
          "status": "active",
          "ticker": "HIKE25",
          "instrumentSymbol": "GEMI-FED261030-HIKE25",
          "marketState": "open",
          "expiryDate": "2026-10-30T04:00:00.000Z"
        },
        {
          "id": "255554-634805",
          "label": "Hike >25bps",
          "prices": {
            "buy": {
              "yes": "0.03",
              "no": "0.97"
            },
            "sell": {
              "yes": "0.03",
              "no": "0.97"
            },
            "bestAsk": "0.03",
            "lastTradePrice": "0.03"
          },
          "status": "active",
          "ticker": "HIKEGT25",
          "instrumentSymbol": "GEMI-FED261030-HIKEGT25",
          "marketState": "open",
          "expiryDate": "2026-10-30T04:00:00.000Z"
        },
        {
          "id": "255554-634804",
          "label": "Cut >25bps",
          "prices": {
            "buy": {
              "yes": "0.02",
              "no": "0.99"
            },
            "sell": {
              "yes": "0.01",
              "no": "0.98"
            },
            "bestBid": "0.01",
            "bestAsk": "0.02",
            "lastTradePrice": "0.01"
          },
          "status": "active",
          "ticker": "CUTGT25",
          "instrumentSymbol": "GEMI-FED261030-CUTGT25",
          "marketState": "open",
          "expiryDate": "2026-10-30T04:00:00.000Z"
        },
        {
          "id": "255554-634678",
          "label": "Cut 25bps",
          "prices": {
            "buy": {
              "yes": "0.01",
              "no": "0.99"
            },
            "sell": {
              "yes": "0.01",
              "no": "0.99"
            },
            "bestAsk": "0.01",
            "lastTradePrice": "0.01"
          },
          "status": "active",
          "ticker": "CUT25",
          "instrumentSymbol": "GEMI-FED261030-CUT25",
          "marketState": "open",
          "expiryDate": "2026-10-30T04:00:00.000Z"
        }
      ]
    },
    {
      "id": "301111",
      "title": "Fed decision in December?",
      "slug": "fed-decision-in-december",
      "type": "categorical",
      "category": "Economics",
      "ticker": "FED261211",
      "status": "active",
      "expiryDate": "2026-12-11T05:00:00.000Z",
      "contracts": [
        {
          "id": "301111-735865",
          "label": "Hike 25bps",
          "prices": {
            "buy": {
              "yes": "0.77",
              "no": "0.32"
            },
            "sell": {
              "yes": "0.68",
              "no": "0.23"
            },
            "bestBid": "0.68",
            "bestAsk": "0.77",
            "lastTradePrice": "0.66"
          },
          "status": "active",
          "ticker": "HIKE25",
          "instrumentSymbol": "GEMI-FED261211-HIKE25",
          "marketState": "open",
          "expiryDate": "2026-12-11T05:00:00.000Z"
        },
        {
          "id": "301111-735866",
          "label": "Fed maintains rate",
          "prices": {
            "buy": {
              "yes": "0.29",
              "no": "0.78"
            },
            "sell": {
              "yes": "0.22",
              "no": "0.71"
            },
            "bestBid": "0.22",
            "bestAsk": "0.29",
            "lastTradePrice": "0.28"
          },
          "status": "active",
          "ticker": "MAINTAIN",
          "instrumentSymbol": "GEMI-FED261211-MAINTAIN",
          "marketState": "open",
          "expiryDate": "2026-12-11T05:00:00.000Z"
        },
        {
          "id": "301111-735864",
          "label": "Cut 25bps",
          "prices": {
            "buy": {
              "yes": "0.05"
            },
            "sell": {
              "no": "0.95"
            },
            "bestAsk": "0.05"
          },
          "status": "active",
          "ticker": "CUT25",
          "instrumentSymbol": "GEMI-FED261211-CUT25",
          "marketState": "open",
          "expiryDate": "2026-12-11T05:00:00.000Z"
        },
        {
          "id": "301111-735867",
          "label": "Hike >25bps",
          "prices": {
            "buy": {
              "yes": "0.04"
            },
            "sell": {
              "no": "0.96"
            },
            "bestAsk": "0.04"
          },
          "status": "active",
          "ticker": "HIKEGT25",
          "instrumentSymbol": "GEMI-FED261211-HIKEGT25",
          "marketState": "open",
          "expiryDate": "2026-12-11T05:00:00.000Z"
        },
        {
          "id": "301111-735863",
          "label": "Cut >25bps",
          "prices": {
            "buy": {
              "yes": "0.03"
            },
            "sell": {
              "no": "0.97"
            },
            "bestAsk": "0.03"
          },
          "status": "active",
          "ticker": "CUTGT25",
          "instrumentSymbol": "GEMI-FED261211-CUTGT25",
          "marketState": "open",
          "expiryDate": "2026-12-11T05:00:00.000Z"
        }
      ]
    },
    {
      "id": "4396",
      "title": "US GDP Growth in 2026?",
      "slug": "us-gdp-growth-in-2026",
      "type": "categorical",
      "category": "Economics",
      "ticker": "GDP2026",
      "status": "active",
      "expiryDate": "2027-02-28T13:29:00.000Z",
      "contracts": [
        {
          "id": "4396-35955",
          "label": "2.1 to 2.5",
          "prices": {
            "buy": {
              "yes": "0.4",
              "no": "0.64"
            },
            "sell": {
              "yes": "0.36",
              "no": "0.6"
            },
            "bestBid": "0.36",
            "bestAsk": "0.4",
            "lastTradePrice": "0.3"
          },
          "status": "active",
          "ticker": "21TO25",
          "instrumentSymbol": "GEMI-GDP2026-21TO25",
          "marketState": "open",
          "expiryDate": "2027-02-28T13:29:00.000Z"
        }
      ]
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 10
  }
};

const FETCHED_AT = "2026-10-11T12:00:00.000Z";

describe("parsing the recorded Gemini response", () => {
  const odds = parseFedEvents(FIXTURE, FETCHED_AT);

  it("keeps only FEDyymmdd events, nearest meeting first", () => {
    expect(odds.meetings.map((m) => m.eventTicker)).toEqual(["FED261030", "FED261211"]);
    expect(odds.meetings[0].title).toBe("Fed decision in October?");
    expect(odds.meetings[0].decisionDate).toBe("2026-10-30");
    expect(odds.meetings[0].url).toBe("https://www.gemini.com/predictions/fed-decision-in-october");
  });

  it("uses Gemini's instrumentSymbol verbatim", () => {
    const hike = odds.meetings[0].outcomes.find((o) => o.ticker === "HIKE25")!;
    expect(hike.instrumentSymbol).toBe("GEMI-FED261030-HIKE25");
  });

  it("prices: bid/ask mid, else last, else ask", () => {
    const oct = odds.meetings[0].outcomes;
    const maintain = oct.find((o) => o.ticker === "MAINTAIN")!;
    expect(maintain.priceSource).toBe("mid");
    expect(maintain.price).toBeCloseTo(0.84, 10); // (0.82 + 0.86) / 2
    const hikeGt = oct.find((o) => o.ticker === "HIKEGT25")!; // no bestBid, last 0.03
    expect(hikeGt.priceSource).toBe("last");
    const decCut = odds.meetings[1].outcomes.find((o) => o.ticker === "CUT25")!; // ask only
    expect(decCut.priceSource).toBe("ask");
    expect(decCut.price).toBe(0.05);
  });

  it("normalized probabilities sum to 1 and preserve ordering", () => {
    for (const m of odds.meetings) {
      expect(m.outcomes.reduce((a, o) => a + o.prob, 0)).toBeCloseTo(1, 10);
      expect(m.overround).toBeGreaterThan(0.9);
    }
    expect(odds.meetings[0].outcomes[0].ticker).toBe("MAINTAIN");
    expect(odds.meetings[1].outcomes[0].ticker).toBe("HIKE25");
  });

  it("implied rate path: small hike bias in Oct, bigger in Dec, adds up", () => {
    const [oct, dec] = odds.meetings;
    expect(oct.expectedBps).toBeGreaterThan(0);
    expect(oct.expectedBps).toBeLessThan(10);
    expect(dec.expectedBps).toBeGreaterThan(10);
    expect(impliedRateChangeBps(odds)).toBeCloseTo(oct.expectedBps + dec.expectedBps, 10);
  });

  it("hedge target is the most likely hike at the nearest meeting", () => {
    const { meeting, outcome } = pickHedgeOutcome(odds);
    expect(meeting.eventTicker).toBe("FED261030");
    expect(outcome.ticker).toBe("HIKE25");
  });

  it("proxy hedge: Brent nearest the Fed decision, highest strike with a real quote, price from sandbox else production", () => {
    const c = (event: string, ticker: string, prices: object = { buy: {}, sell: {} }) => ({ label: `$${ticker.slice(2)} or above`, ticker, instrumentSymbol: `GEMI-${event}-${ticker}`, prices });
    const ev = (ticker: string, expiryDate: string, contracts: ReturnType<typeof c>[]) => ({ id: ticker, title: ticker, slug: ticker, ticker, category: "Commodities", expiryDate, contracts });
    // the sandbox as observed: oil markets listed, books empty
    const sandbox = [
      ev("XAU2610312100", "2026-10-31T21:00:00.000Z", [c("XAU2610312100", "HI4200", { lastTradePrice: "0.53" })]),
      ev("WTI2610312100", "2026-10-31T21:00:00.000Z", [c("WTI2610312100", "HI99")]),
      ev("BRENT2610122100", "2026-10-12T21:00:00.000Z", [c("BRENT2610122100", "HI105")]),
      ev("BRENT2610312100", "2026-10-31T21:00:00.000Z", [c("BRENT2610312100", "HI102"), c("BRENT2610312100", "HI108"), c("BRENT2610312100", "HI105")]),
    ];
    const production = [
      ev("BRENT2610122100", "2026-10-12T21:00:00.000Z", [c("BRENT2610122100", "HI105", { bestAsk: "0.10" })]),
      ev("BRENT2610312100", "2026-10-31T21:00:00.000Z", [c("BRENT2610312100", "HI102", { bestBid: "0.60", bestAsk: "0.70" }), c("BRENT2610312100", "HI105", { lastTradePrice: "0.54" })]),
      ev("WTI2610312100", "2026-10-31T21:00:00.000Z", [c("WTI2610312100", "HI99", { bestAsk: "0.35" })]),
    ];
    const pick = pickProxyHedge(sandbox, production, "2026-10-30")!;
    expect(pick.contract.instrumentSymbol).toBe("GEMI-BRENT2610312100-HI105"); // HI108 has no quote anywhere
    expect(pick).toMatchObject({ limit: 0.54, priceFrom: "production" });
    // a sandbox quote wins over production
    sandbox[3].contracts[1].prices = { bestAsk: "0.20" };
    expect(pickProxyHedge(sandbox, production, "2026-10-30")).toMatchObject({ limit: 0.2, priceFrom: "sandbox", contract: { ticker: "HI108" } });
    // no Brent quote at all -> WTI; nothing quoted -> no hedge (never an invented price)
    expect(pickProxyHedge([sandbox[1]], production, "2026-10-30")?.contract.instrumentSymbol).toBe("GEMI-WTI2610312100-HI99");
    expect(pickProxyHedge([sandbox[0]], production)).toBeUndefined();
    expect(pickProxyHedge([sandbox[1]], [])).toBeUndefined();
  });
});

describe("pure helpers", () => {
  it("contractBps", () => {
    expect(contractBps("MAINTAIN")).toBe(0);
    expect(contractBps("HIKE25")).toBe(25);
    expect(contractBps("HIKEGT25")).toBe(50);
    expect(contractBps("CUT25")).toBe(-25);
    expect(contractBps("CUTGT25")).toBe(-50);
    expect(contractBps("WHATEVER")).toBeNull();
  });

  it("contractPrice ignores crossed books and missing data", () => {
    expect(contractPrice({ bestBid: "0.6", bestAsk: "0.5", lastTradePrice: "0.55" })).toEqual({ price: 0.55, source: "last" });
    expect(contractPrice({})).toBeNull();
    expect(contractPrice(undefined)).toBeNull();
  });

  it("normalize", () => {
    normalize([0.5, 0.3, 0.4]).forEach((p, i) => expect(p).toBeCloseTo([0.5, 0.3, 0.4][i] / 1.2, 12));
    expect(normalize([1, -1, NaN])).toEqual([1, 0, 0]);
    expect(() => normalize([0, 0])).toThrow(/no positive prices/);
  });

  it("annuity math", () => {
    expect(monthlyPayment(1200, 0, 12)).toBe(100);
    expect(monthlyPayment(1000, 12, 12)).toBeCloseTo(88.85, 2);
    expect(presentValue(100, 0, 12)).toBeCloseTo(1200, 10);
    expect(presentValue(100, 12, 12)).toBeLessThan(1200);
  });

  it("parseFredCsv takes the last numeric row", () => {
    expect(parseFredCsv("observation_date,DFEDTARU\n2026-10-10,4.00\n2026-10-11,.\n")).toEqual({ date: "2026-10-10", value: 4 });
  });

  it("rejects a response without Fed markets", () => {
    expect(() => parseFedEvents({ data: [] })).toThrow(/no active Fed-decision markets/);
    expect(() => parseFedEvents({})).toThrow(/data\[\]/);
  });
});

describe("financingAdvice — both directions", () => {
  const odds = parseFedEvents(FIXTURE, FETCHED_AT);
  const ctx = { odds, policyRatePct: 4, policyRateSource: "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFEDTARU" };

  it("big prompt-pay discount -> lump sum", () => {
    const a = financingAdvice(4200, 15, 12, 0, ctx);
    expect(a.recommendation).toBe("lump_sum");
    expect(a.detail.lumpSum).toBe(3570);
    expect(a.reason).toMatch(/lump sum is cheaper/);
    expect(a.reasonZh).toMatch(/一次性付清/);
    expect(a.fedOdds?.ticker).toBe("FED261030");
    expect(a.sources.some((s) => s.via === "gemini" && s.url.includes("fed-decision-in-october"))).toBe(true);
    expect(a.expectedRatePath).toBeGreaterThan(0);
  });

  it("tiny discount vs 0% plan -> payment plan", () => {
    const a = financingAdvice(4200, 1, 12, 0, ctx);
    expect(a.recommendation).toBe("payment_plan");
    expect(a.reason).toMatch(/plan is cheaper/);
    // break-even discount for a 0% 12-month plan at ~4% is ~2.2%
    expect(Number(a.detail.breakEvenDiscountPct)).toBeGreaterThan(1.5);
    expect(Number(a.detail.breakEvenDiscountPct)).toBeLessThan(3);
  });

  it("higher market-implied rates make the 0% plan worth more (break-even rises)", () => {
    const hawkish: FedOdds = {
      ...odds,
      meetings: odds.meetings.map((m) => ({ ...m, expectedBps: m.expectedBps + 100 })),
    };
    const base = financingAdvice(4200, 2.2, 12, 0, ctx);
    const hot = financingAdvice(4200, 2.2, 12, 0, { ...ctx, odds: hawkish });
    expect(Number(hot.detail.breakEvenDiscountPct)).toBeGreaterThan(Number(base.detail.breakEvenDiscountPct));
    expect(hot.recommendation).toBe("payment_plan");
  });

  it("if she'd have to put the lump sum on a medical credit card, the plan wins even at 10% off", () => {
    const a = financingAdvice(4200, 10, 12, 0, { ...ctx, fundLumpSumWith: "card" });
    expect(a.recommendation).toBe("payment_plan");
    expect(Number(a.detail.cardAprPct)).toBeGreaterThan(20);
  });

  it("a high-APR plan loses to even a small discount", () => {
    const a = financingAdvice(4200, 2, 12, 24, ctx);
    expect(a.recommendation).toBe("lump_sum");
  });

  it("validates inputs", () => {
    expect(() => financingAdvice(0, 10, 12, 0, ctx)).toThrow();
    expect(() => financingAdvice(100, 10, 0, 0, ctx)).toThrow();
  });
});

describe("network boundary + routes (fetch mocked)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const mockFetch = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u === FED_EVENTS_URL) return new Response(JSON.stringify(FIXTURE), { status: 200 });
    if (u.includes("fredgraph.csv")) return new Response("observation_date,DFEDTARU\n2026-10-11,4.00\n", { status: 200 });
    return new Response("not found", { status: 404 });
  });

  it("fetchFedOdds uses the public events endpoint", async () => {
    const odds = await fetchFedOdds(mockFetch as unknown as typeof fetch);
    expect(mockFetch).toHaveBeenCalledWith(FED_EVENTS_URL, expect.anything());
    expect(odds.meetings).toHaveLength(2);
  });

  it("fetchFedOdds fails loudly on HTTP errors", async () => {
    const bad = async () => new Response("down", { status: 503 });
    await expect(fetchFedOdds(bad as unknown as typeof fetch)).rejects.toThrow(/returned 503/);
  });

  it("GET /api/markets/fed and POST /api/cases/:id/financing", async () => {
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    const app = Fastify();
    await app.register(marketsRoutes);
    const fed = await app.inject({ method: "GET", url: "/api/markets/fed" });
    expect(fed.statusCode).toBe(200);
    expect(fed.json().meetings[0].eventTicker).toBe("FED261030");
    expect(fed.json().policyRate.upperPct).toBe(4);

    const c = createCase({ mode: "patient", target: 3000 });
    const r = await app.inject({ method: "POST", url: `/api/cases/${c.id}/financing`, payload: {} });
    expect(r.statusCode).toBe(200);
    expect(r.json().recommendation).toBe("lump_sum"); // default 10% off vs 0% 12-month plan at ~4%
    expect(r.json().detail.balance).toBe(3000);
    expect(c.financing?.recommendation).toBe("lump_sum");

    // ($0 targets / write-offs are covered below: main's rule is "nothing to finance")

    const none = createCase({ mode: "patient" });
    const r2 = await app.inject({ method: "POST", url: `/api/cases/${none.id}/financing`, payload: {} });
    expect(r2.statusCode).toBe(409);

    // a $0 target (full write-off) is an answer, not a missing balance: no market call, no plan
    const calls = (mockFetch as any).mock?.calls?.length;
    const zero = createCase({ mode: "patient", target: 0, bill: { provider: { name: "H" }, lineItems: [], totalCharges: 900, patientBalance: 900 } });
    const r3 = await app.inject({ method: "POST", url: `/api/cases/${zero.id}/financing`, payload: {} });
    expect(r3.statusCode).toBe(200);
    expect(r3.json()).toMatchObject({ recommendation: "lump_sum", reason: expect.stringMatching(/Nothing to finance/) });
    expect(zero.financing?.recommendation).toBe("lump_sum");
    if (calls !== undefined) expect((mockFetch as any).mock.calls.length).toBe(calls);
  });

  it("hedge route 503s without Gemini keys", async () => {
    const saved = { k: process.env.GEMINI_API_KEY, s: process.env.GEMINI_API_SECRET };
    process.env.GEMINI_API_KEY = ""; // blank, not deleted: dotenv would refill a deleted key from a local .env
    process.env.GEMINI_API_SECRET = "";
    try {
      const app = Fastify();
      await app.register(marketsRoutes);
      const c = createCase({ mode: "patient", target: 3000 });
      const r = await app.inject({ method: "POST", url: `/api/cases/${c.id}/hedge`, payload: {} });
      expect(r.statusCode).toBe(503);
      expect(r.json().error).toMatch(/GEMINI_API_KEY/);
    } finally {
      if (saved.k !== undefined) process.env.GEMINI_API_KEY = saved.k;
      if (saved.s !== undefined) process.env.GEMINI_API_SECRET = saved.s;
    }
  });
});
