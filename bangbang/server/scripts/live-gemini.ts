// Live proof for the Gemini track (public data, no key needed):
//   npx tsx scripts/live-gemini.ts                 # real Fed odds + FRED policy rate -> advice for a $4,200 bill
//   npx tsx scripts/live-gemini.ts 3100 8 12 0     # balance, lump-sum discount %, plan months, plan APR %
//   npx tsx scripts/live-gemini.ts --hedge         # ALSO places a 1-contract YES hedge in the Gemini SANDBOX
//                                                  # (needs GEMINI_API_KEY + GEMINI_API_SECRET for a sandbox account)
import "dotenv/config";
import { fetchFedOdds, fetchPolicyRate, financingAdvice, impliedRateChangeBps, placeHedge } from "../src/markets/gemini.js";

const args = process.argv.slice(2);
const hedge = args.includes("--hedge");
const [balance = 4200, discount = 10, months = 12, apr = 0] = args.filter((a) => !a.startsWith("--")).map(Number);

const [odds, rate] = await Promise.all([fetchFedOdds(), fetchPolicyRate()]);
console.log(`policy rate (FRED DFEDTARU ${rate.date}): ${rate.upperPct}%`);
for (const m of odds.meetings) {
  console.log(`\n${m.eventTicker}  ${m.title}  (overround ${m.overround.toFixed(3)}, E[change] ${m.expectedBps.toFixed(1)} bps)  ${m.url}`);
  for (const o of m.outcomes) {
    console.log(`  ${o.instrumentSymbol.padEnd(26)} ${o.label.padEnd(20)} ${o.priceSource.padEnd(4)} ${o.price.toFixed(3)}  -> ${(o.prob * 100).toFixed(1)}%`);
  }
}
console.log(`\nimplied cumulative change: ${impliedRateChangeBps(odds).toFixed(1)} bps`);

for (const fund of ["savings", "card"] as const) {
  const a = financingAdvice(balance, discount, months, apr, { odds, policyRatePct: rate.upperPct, policyRateSource: rate.source, fundLumpSumWith: fund });
  console.log(`\n[fund lump sum with ${fund}] => ${a.recommendation}`);
  console.log(a.reason);
  console.log(a.reasonZh);
  console.log(a.detail);
}

if (hedge) {
  const receipt = await placeHedge({ odds, quantity: "1" });
  console.log("\nGemini SANDBOX hedge:", receipt);
}
