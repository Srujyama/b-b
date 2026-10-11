// Live transcript translation (en <-> zh) via the OpenAI wrapper, with a small LRU cache so the
// repeated phrases of a call ("okay", "let me check") cost one call each.
import { llmText } from "../llm.js";
import type { Lang } from "../types.js";

const MAX = 500;
const cache = new Map<string, string>(); // Map keeps insertion order → oldest first = LRU victim

const SYSTEM: Record<Lang, string> = {
  zh: "You translate one line of a live phone call between a patient advocate and a US hospital billing office into Simplified Chinese for the patient, a Mandarin speaker with no English. Plain, warm everyday Mandarin. Keep every number and dollar amount exact (write amounts as e.g. 9,800美元). Briefly gloss US billing jargon in parentheses the first time it appears (e.g. 慈善医疗/经济援助). Output ONLY the translation.",
  en: "You translate one line of Mandarin Chinese spoken by a patient into natural English. Keep every number exact. Output ONLY the translation.",
};

export async function translateLine(text: string, to: Lang): Promise<string> {
  const t = text.trim();
  if (!t) return "";
  const key = `${to}\u0000${t}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit); // refresh recency
    return hit;
  }
  const out = (await llmText(SYSTEM[to], t, 0)).trim();
  cache.set(key, out);
  if (cache.size > MAX) cache.delete(cache.keys().next().value!);
  return out;
}

/** Test hook. */
export function clearTranslateCache() {
  cache.clear();
}
