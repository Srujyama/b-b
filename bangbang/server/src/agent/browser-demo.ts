import { requireCase } from "../store.js";
import type { CasePacket } from "../types.js";
import { advocateInitForHuman, type ConversationInit } from "./elevenlabs.js";
import { outboundAgentConfig } from "./call-plan.js";
import { resolveSpeechProfile, speechInstructions, speechOverride } from "./speech.js";
import type { VoiceMemory } from "./shared-context.js";

/** A separate browser agent: microphone audio goes to ElevenLabs, never to Twilio. */
export function browserAgentConfig(baseUrl: string, secretId: string, toolIds: string[]) {
  const phone = outboundAgentConfig(baseUrl, secretId);
  return {
    name: "BangBang Haiku Browser Rehearsal", tags: ["bangbang", "browser-rehearsal"],
    conversation_config: {
      ...phone.conversation_config,
      agent: { ...phone.conversation_config.agent, dynamic_variables: { dynamic_variable_placeholders: { case_id: "" } },
        prompt: { ...phone.conversation_config.agent.prompt, tool_ids: toolIds,
          custom_llm: { ...phone.conversation_config.agent.prompt.custom_llm, url: `${baseUrl}/api/voice/browser/llm/v1/chat/completions` },
          built_in_tools: {
            end_call: phone.conversation_config.agent.prompt.built_in_tools.end_call,
            skip_turn: phone.conversation_config.agent.prompt.built_in_tools.skip_turn,
          },
        },
      },
      conversation: { max_duration_seconds: 240 },
    },
    // Demo client tools update simulated negotiation state. No phone webhook required.
    platform_settings: { auth: { enable_auth: true }, overrides: phone.platform_settings.overrides, privacy: { record_voice: false } },
  };
}

export function browserDemoInit(packet: CasePacket): ConversationInit {
  const init = advocateInitForHuman(packet);
  const speech = resolveSpeechProfile();
  init.custom_llm_extra_body = { browser_case_id: packet.id };
  init.conversation_config_override.tts = speechOverride(speech);
  init.conversation_config_override.agent.first_message = "Hello, I'm BangBang, an AI advocate in this simulated billing call. Have I reached patient billing?";
  init.conversation_config_override.agent.prompt.prompt += `\n\nBROWSER REHEARSAL: The billing representative is a teammate and the account is a demonstration. No hospital has been called. Any tool-recorded agreement is simulated, not a binding settlement or payment authorization. Do not claim any real-world payment or provider confirmation occurred.\n${speechInstructions(speech)}`;
  return init;
}

/** Demo reads the same in-process CasePacket the product updates on every turn. */
export function browserDemoMemory(caseId: unknown): VoiceMemory {
  if (typeof caseId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(caseId))
    throw Object.assign(new Error("Browser rehearsal requires browser_case_id in custom LLM metadata"), { statusCode: 400 });
  const c = requireCase(caseId);
  const facts = c.facts.slice(0, 20).map((fact) => fact.slice(0, 500));
  const notes = [JSON.stringify({ simulation: true, status: c.status,
    currentPatientBalance: c.bill?.patientBalance, maxOfferUsd: c.walkaway ?? c.patient?.maxPay,
    recentOffers: c.offers.slice(-5), simulatedAgreedAmount: c.agreedAmount }).slice(0, 4000)];
  return { revision: `${c.status}:${c.offers.length}:${c.facts.length}`, facts, notes,
    authorized: c.mode === "clinic" || c.patient?.consent === true };
}
