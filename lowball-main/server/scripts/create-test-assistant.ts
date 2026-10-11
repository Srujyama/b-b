// Creates a persistent Vapi assistant with the same config /negotiate uses,
// so the negotiation brain + webhook pipeline can be tested via a browser
// call from the Vapi dashboard while PSTN numbers are blocked.
// Run from server/: npx tsx scripts/create-test-assistant.ts
import "dotenv/config";
import { buildAssistant } from "../src/assistant.js";
import { FALLBACK_CAR } from "../src/ingest.js";

const res = await fetch("https://api.vapi.ai/assistant", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    ...buildAssistant(FALLBACK_CAR),
    name: "Lowball Test (Camry)",
  }),
});

const body = await res.json();
if (!res.ok) {
  console.error("FAILED", res.status, JSON.stringify(body, null, 2));
  process.exit(1);
}
console.log("assistant id:", body.id);
console.log("talk to it:  https://dashboard.vapi.ai/assistants/" + body.id);
