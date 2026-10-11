// Live proof for the research module against real Context.dev + Claude.
//   npx tsx scripts/live-research.ts [code] [description] [hospital]
// Needs CONTEXT_DEV_API_KEY and ANTHROPIC_API_KEY in vellum/server/.env. Defaults are DEMO SEED inputs only.
import "dotenv/config";
import { brand, search } from "../src/research/contextdev.js";
import { lookupFairPrice } from "../src/research/fairprice.js";
import { findCharityPolicy, fplPercent } from "../src/research/charity.js";

const [code = "99285", description = "Emergency department visit, high severity", hospital = "Stanford Health Care"] = process.argv.slice(2);

for (const k of ["CONTEXT_DEV_API_KEY", "ANTHROPIC_API_KEY"]) {
  if (!process.env[k]) {
    console.error(`${k} is not configured — set it in vellum/server/.env`);
    process.exit(1);
  }
}

console.log("fplPercent($30,000, household 3) =", fplPercent(30000, 3), "%");

const hits = await search(`${hospital} financial assistance policy`, { highlights: true });
console.log(`\n[search] ${hits.length} results; top:`, hits.slice(0, 3).map((h) => h.url));

const b = await brand({ name: hospital }).catch((e) => ({ error: (e as Error).message }));
console.log("\n[brand]", b);

console.log(`\n[fair price] ${code} ${description} @ ${hospital} ...`);
const fp = await lookupFairPrice(code, description, hospital);
console.log(JSON.stringify(fp, null, 2));

console.log(`\n[charity] ${hospital} ...`);
const cp = await findCharityPolicy(hospital, undefined, (m) => console.log("  ·", m));
console.log(JSON.stringify(cp, null, 2));
