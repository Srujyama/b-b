// Live check for clinic mode: real Context.dev policy lookup + OpenAI criteria check + appeal letter on the demo denial.
// Needs CONTEXT_DEV_API_KEY and OPENAI_API_KEY in .env.  Run: npx tsx scripts/live-clinic.ts
import "dotenv/config";
import { draftAppeal } from "../src/claims/appeal.js";
import { loadDemoClaim } from "../src/routes/clinic.js";

const claim = await loadDemoClaim();
const out = await draftAppeal(claim, { onProgress: (m) => console.log("·", m) });
console.log("\nPOLICY:", out.policy?.title, "\n ", out.policy?.url);
for (const c of out.criteriaMet ?? []) console.log(`${c.met ? "MET    " : "NOT MET"} ${c.criterion}\n         ${c.evidence}`);
console.log("\n" + out.appealLetter);
