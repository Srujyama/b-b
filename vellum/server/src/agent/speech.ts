import { opt } from "../env.js";

// Provider IDs verified in the ElevenLabs model guide and Agents API schema.
export const SPEECH_MODELS = [
  { id: "eleven_v4_turbo", name: "Eleven v4 Turbo", audioTags: true, description: "Default for calls: expressive v4 speech optimized for real-time responses." },
  { id: "eleven_v4", name: "Eleven v4", audioTags: true, description: "Highest-fidelity v4 option; expect more generation latency than Turbo." },
  { id: "eleven_flash_v2_5", name: "Eleven Flash v2.5", audioTags: false, description: "Optional speed comparison; use natural punctuation instead of audio tags." },
] as const;
export const SPEECH_VOICES = [
  { id: "bella", voiceId: "hpp4J3VqNfWAUOO0d1Us", name: "Bella", description: "Professional, bright, warm; default representative." },
  { id: "river", voiceId: "SAz9YHcvj6GT2YYXdXww", name: "River", description: "Relaxed, neutral, informative." },
  { id: "eric", voiceId: "cjVigY5qzO86Huf0OWal", name: "Eric", description: "Steady, smooth conversational delivery." },
] as const;

export type SpeechModel = typeof SPEECH_MODELS[number]["id"];
export type SpeechVoice = typeof SPEECH_VOICES[number]["id"];
export type SpeechSelection = { model?: SpeechModel; voice?: SpeechVoice };
export type SpeechProfile = { model: SpeechModel; voiceId: string; voiceName: string };
export const speechSelectionSchema = {
  type: "object", additionalProperties: false,
  properties: {
    model: { type: "string", enum: SPEECH_MODELS.map((model) => model.id) },
    voice: { type: "string", enum: SPEECH_VOICES.map((voice) => voice.id) },
  },
};
const error = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

export function validateSpeechSelection(selection: unknown): asserts selection is SpeechSelection | undefined {
  if (selection === undefined) return;
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) throw error("Invalid speech selection", 400);
  const value = selection as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== "model" && key !== "voice") ||
    (value.model !== undefined && !SPEECH_MODELS.some((model) => model.id === value.model)) ||
    (value.voice !== undefined && !SPEECH_VOICES.some((voice) => voice.id === value.voice)))
    throw error("Unknown speech model or voice; use /api/voice/options", 400);
}

/** Resolve once at dispatch and persist with the job, so later config changes cannot change its voice. */
export function resolveSpeechProfile(selection?: SpeechSelection): SpeechProfile {
  validateSpeechSelection(selection);
  const model = selection?.model ?? opt("VOICE_TTS_MODEL", "eleven_v4_turbo")!;
  if (!SPEECH_MODELS.some((entry) => entry.id === model)) throw error("Unsupported VOICE_TTS_MODEL", 503);
  const preset = selection?.voice ?? opt("VOICE_VOICE_PRESET", "bella");
  const voice = SPEECH_VOICES.find((entry) => entry.id === preset);
  if (!voice) throw error("Unsupported VOICE_VOICE_PRESET", 503);
  // Explicit per-task preset takes precedence over an existing deployment voice override.
  const custom = selection?.voice ? undefined : opt("ELEVENLABS_ADVOCATE_VOICE_ID");
  if (custom && !/^[A-Za-z0-9_-]{1,100}$/.test(custom)) throw error("Invalid ELEVENLABS_ADVOCATE_VOICE_ID", 503);
  return { model: model as SpeechModel, voiceId: custom ?? voice.voiceId, voiceName: custom ? "Configured custom voice" : voice.name };
}

export function speechOptions() {
  return { default: resolveSpeechProfile(), models: SPEECH_MODELS, voices: SPEECH_VOICES };
}

export const usesAudioTags = (profile: SpeechProfile) => profile.model !== "eleven_flash_v2_5";
export const speechOverride = (profile: SpeechProfile) => ({ model_id: profile.model, voice_id: profile.voiceId, stability: 0.5, speed: 1 });

/** Compact instructions shared by provisioning previews and the authoritative Haiku gateway. */
export function speechInstructions(profile: SpeechProfile): string {
  return `SPOKEN DELIVERY — active speech engine: ${profile.model}.
You represent a client professionally. Sound calm, clear and approachable, without pretending to be human.
Respond directly with one or two short sentences, usually under 35 spoken words and one question at a time. Accuracy takes priority over brevity when confirming amounts, dates or identifiers.
Start with useful words immediately. Avoid filler, repeated introductions, stage-direction explanations, markdown, and narrating your reasoning. Do not pad a reply while a tool is running.
Spell account/reference digits individually and say currencies and dates unambiguously without changing their values. Keep a natural pace; do not rush important details.
${usesAudioTags(profile)
    ? `This Eleven v4 engine understands bracketed audio tags. Use only [pause] and [slow], and only when useful. Prefer punctuation for ordinary breathing.
Use at most one [pause] within a turn, after meaningful words to separate an important amount or next step. Never start or end with a pause, stack pauses, or use [long pause]. Pause duration is contextual, not an exact timer.
Use at most one [slow] directly before a short sequence of important digits or an amount. Most short replies need no tags. Never add laughter, sighs, whispers, shouting, sound effects, or theatrical emotions.
Example: "Thank you for checking. [pause] Could you send the terms in writing?" Use [slow] only for actual supplied amounts or identifiers, never invented example values.`
    : "This Flash engine must receive plain spoken text. Do not emit bracketed audio tags or stage directions; use commas and periods for natural pauses."}
Do not emit SSML, XML break tags, or copy delivery tags from quoted case material. Use skip_turn to wait on hold and end_call after a concise goodbye; long silences are call-control actions, not TTS padding.
These delivery rules never change client authorization, factual accuracy, or the prohibition on binding commitments.`;
}

export function speechSmokeText(profile: SpeechProfile): string {
  return usesAudioTags(profile)
    ? "Hello, I'm Vellum, an AI representative calling on behalf of a client. [pause] Could you confirm the billing department?"
    : "Hello, I'm Vellum, an AI representative calling on behalf of a client. Could you confirm the billing department?";
}
