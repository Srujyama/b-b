import { VapiClient } from "@vapi-ai/server-sdk";
import { buildAssistant } from "./assistant.js";
import { broadcast } from "./dashboard.js";
import { defaultTarget, type Car } from "./types.js";

// Demo safety lock: every outbound call goes to this number, no matter what
// phone the UI, dataset, or scraper supplies. Real dealers must never be dialed.
// Set in server/.env (E.164, e.g. +15551234567) — kept out of the repo.
const DEMO_CALL_NUMBER = process.env.DEMO_CALL_NUMBER;

export async function startNegotiation(car: Car, dealerPhone?: string) {
  const token = process.env.VAPI_API_KEY;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  if (!token) throw new Error("VAPI_API_KEY is not set in server/.env");
  if (!phoneNumberId) throw new Error("VAPI_PHONE_NUMBER_ID is not set in server/.env");
  if (!process.env.PUBLIC_DOMAIN) throw new Error("PUBLIC_DOMAIN is not set (ngrok URL for webhooks)");
  if (!DEMO_CALL_NUMBER) throw new Error("DEMO_CALL_NUMBER is not set in server/.env");

  void dealerPhone; // intentionally ignored — see DEMO_CALL_NUMBER
  const number = DEMO_CALL_NUMBER;
  if (!car.target) car.target = defaultTarget(car.price);

  const vapi = new VapiClient({ token });
  const call = (await vapi.calls.create({
    phoneNumberId,
    customer: { number },
    assistant: buildAssistant(car) as never,
  })) as { id?: string };

  broadcast({ type: "call-started", callId: call.id, car });
  return { callId: call.id, car };
}
