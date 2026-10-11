// Re-push the current buildAssistant config onto the persistent browser-test
// assistant so dashboard "Talk to Assistant" tests match /negotiate exactly.
// Run from server/: npx tsx scripts/update-test-assistant.ts
import "dotenv/config";
import { buildAssistant } from "../src/assistant.js";
import { FIXTURE_CAR } from "./eval-fixtures.js";

const ASSISTANT_ID = "6ba93007-fcc1-4f77-a0b7-d807e730fe97";

// FIXTURE_CAR (real F-150 listing + full facts packet) instead of the bare
// FALLBACK_CAR so dashboard tests exercise the facts/BATNA/MESO sections too.
const res = await fetch(`https://api.vapi.ai/assistant/${ASSISTANT_ID}`, {
  method: "PATCH",
  headers: {
    Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ ...buildAssistant(FIXTURE_CAR), name: "Lowball Test (F-150)" }),
});
console.log(res.ok ? "test assistant updated" : `FAILED ${res.status} ${await res.text()}`);
