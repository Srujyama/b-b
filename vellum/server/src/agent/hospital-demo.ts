import { opt } from "../env.js";
import { requireCase } from "../store.js";
import type { CasePacket } from "../types.js";
import { browserAgentConfig } from "./browser-demo.js";
import { conversationInit } from "./elevenlabs.js";
import { hospitalPrompt } from "./prompts.js";
import { resolveSpeechProfile, speechInstructions, speechOverride } from "./speech.js";

export function hospitalSpeechProfile() {
  const speech = resolveSpeechProfile({ voice: "eric" });
  const custom = opt("ELEVENLABS_HOSPITAL_VOICE_ID");
  if (custom && !/^[A-Za-z0-9_-]{1,100}$/.test(custom))
    throw Object.assign(new Error("Invalid ELEVENLABS_HOSPITAL_VOICE_ID"), { statusCode: 503 });
  return { ...speech, voiceId: custom ?? speech.voiceId, voiceName: custom ? "Configured hospital voice" : speech.voiceName };
}

/** Separate ElevenLabs session; only call-control tools, never the advocate's settlement tools. */
export function hospitalAgentConfig(baseUrl: string, secretId: string) {
  const config = browserAgentConfig(baseUrl, secretId, []);
  const speech = hospitalSpeechProfile();
  return {
    ...config, name: "Vellum Haiku Hospital Demo", tags: ["vellum", "hospital-demo"],
    conversation_config: {
      ...config.conversation_config,
      tts: { ...config.conversation_config.tts, ...speechOverride(speech) },
      agent: { ...config.conversation_config.agent, prompt: {
        ...config.conversation_config.agent.prompt,
        prompt: `You are Dana, an AI hospital billing representative in a synthetic demo. Without a case brief, say the account is unavailable and end the call.\n${speechInstructions(speech, "hospital")}`,
        custom_llm: { ...config.conversation_config.agent.prompt.custom_llm,
          url: `${baseUrl}/api/voice/hospital/llm/v1` },
      } },
    },
  };
}

export function hospitalDemoPrompt(packet: CasePacket): string {
  return `${hospitalPrompt(packet)}

DEMO BOUNDARY: You are an AI hospital billing persona in a simulated call, not a real hospital employee. No hospital was contacted and no adjustment, approval, payment or collections hold takes effect outside this demo. If asked, explain this plainly.
You represent the billing office, never the patient. You cannot see the advocate's budget, private strategy or maximum authorized payment. Learn their position only from what they say. Do not ask for card numbers, bank details or real identity documents.
Keep the exchange moving: acknowledge one specific point per turn, then give the corresponding revised amount or ask one necessary question. Do not repeat identity checks after the advocate introduces the synthetic account. Do not invent a concession just to force a deal; apply the stated billing rules and policy.
When you reach your best authorized amount, say it clearly and ask whether it works. After agreement, confirm the amount and simulated written terms, then wait for the advocate's confirmation and goodbye before using end_call. Never invoke log_offer, accept_offer or report_outcome; those belong to the advocate.
${speechInstructions(hospitalSpeechProfile(), "hospital")}`;
}

export function hospitalDemoInit(packet: CasePacket) {
  const init = conversationInit("hospital", packet);
  init.custom_llm_extra_body = { hospital_case_id: packet.id };
  init.conversation_config_override.agent.prompt.prompt = hospitalDemoPrompt(packet);
  init.conversation_config_override.tts = speechOverride(hospitalSpeechProfile());
  return init;
}

/** Read only the hospital's account/policy view; never inject browserDemoMemory or private facts. */
export function hospitalDemoContext(caseId: unknown) {
  if (typeof caseId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(caseId))
    throw Object.assign(new Error("Hospital demo requires hospital_case_id in custom LLM metadata"), { statusCode: 400 });
  const packet = requireCase(caseId);
  if (packet.mode !== "patient")
    throw Object.assign(new Error("Hospital demo requires a patient case"), { statusCode: 409 });
  return { authorized: packet.patient?.consent === true, prompt: hospitalDemoPrompt(packet) };
}
