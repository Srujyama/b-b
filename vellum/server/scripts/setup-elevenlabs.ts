// Create or update Vellum's ElevenLabs agents + tools, then print the ids for .env.
//   npx tsx scripts/setup-elevenlabs.ts            (idempotent: PATCHes agents whose id is already in .env)
//   npx tsx scripts/setup-elevenlabs.ts --help
// Env: ELEVENLABS_API_KEY (required); ELEVENLABS_TOOL_MODE=client|webhook (default client);
//      PUBLIC_URL (required for webhook mode); ELEVENLABS_TOOL_SECRET (optional webhook header);
//      ELEVENLABS_{ADVOCATE,HOSPITAL,INTAKE}_VOICE_ID, ELEVENLABS_LLM, ELEVENLABS_TTS_MODEL, ELEVENLABS_ZH_TTS_MODEL.
import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { need, opt } from "../src/env.js";
import { AGENTS, agentConfig, createVoiceGatewaySecret, listTools, toolConfig, toolMode, toolNamesForSpec, upsertAgent, upsertTool } from "../src/agent/elevenlabs.js";
import { outboundAgentConfig, publicVoiceUrl } from "../src/agent/call-plan.js";
import { checkElevenLabsConnection, smokeTestElevenLabs } from "../src/agent/connection.js";
import { speechOptions } from "../src/agent/speech.js";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`setup-elevenlabs: creates/updates 3 ElevenLabs agents (advocate en, hospital billing en, intake zh)
and their tools (log_offer, accept_offer, report_outcome, submit_intake), enables prompt/first_message/
language/voice overrides, and prints the agent ids to paste into vellum/server/.env.
Tool mode: ELEVENLABS_TOOL_MODE=client (default; no public URL needed) or webhook (needs PUBLIC_URL).
--outbound: configure a separate Haiku 5.5 + Eleven v4 Turbo phone representative.
--dry-run: print configs without credentials, network access, or placing a call.
--check: read-only ElevenLabs credential, voice, agent, and phone inventory checks.
--options: list supported speech models and voice choices without network access.
--smoke-test: generate one short sample using VOICE_TTS_MODEL and VOICE_VOICE_PRESET (uses TTS credits; no phone call).
Default speech: eleven_v4_turbo with Bella. Options also include eleven_v4 and eleven_flash_v2_5.
Outbound setup: PUBLIC_URL and VOICE_LLM_TOKEN required; see src/agent/voice.env.example.
Claude credentials are needed to run calls, not to check or configure ElevenLabs.
This script never places calls.`);
  process.exit(0);
}

const dryRun = process.argv.includes("--dry-run");
const check = process.argv.includes("--check");
const smoke = process.argv.includes("--smoke-test");
const options = process.argv.includes("--options");
if ((check || smoke || options) && (dryRun || process.argv.includes("--outbound") || [check, smoke, options].filter(Boolean).length > 1)) {
  throw new Error("Use --check, --smoke-test, or --options on its own; none can be combined with setup or --dry-run.");
}
if (options) {
  console.log(JSON.stringify(speechOptions(), null, 2));
  process.exit(0);
}
if (check) {
  const result = await checkElevenLabsConnection();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.connected ? 0 : 1);
}
if (smoke) {
  const { audio, ...metrics } = await smokeTestElevenLabs();
  const audioFile = join(tmpdir(), `vellum-elevenlabs-${randomUUID()}.mp3`);
  await writeFile(audioFile, audio, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ ...metrics, audioFile, note: "Time to first audio byte includes network latency. This is not end-to-end phone latency." }, null, 2));
  process.exit(0);
}
if (process.argv.includes("--outbound")) {
  const base = dryRun ? "https://your-voice-server.example" : publicVoiceUrl();
  let secretId = opt("ELEVENLABS_LLM_SECRET_ID");
  if (dryRun) secretId = "<ELEVENLABS_LLM_SECRET_ID>";
  else {
    need("ELEVENLABS_API_KEY");
    const token = need("VOICE_LLM_TOKEN");
    if (!secretId) {
      secretId = await createVoiceGatewaySecret(token);
      // Print immediately so a subsequent agent API failure doesn't lose this reference.
      console.log(`ELEVENLABS_LLM_SECRET_ID=${secretId}`);
    }
  }
  const config = outboundAgentConfig(base, secretId!);
  if (dryRun) console.log(JSON.stringify(config, null, 2));
  else {
    const id = await upsertAgent(config, opt("ELEVENLABS_OUTBOUND_AGENT_ID"));
    console.log(`ELEVENLABS_OUTBOUND_AGENT_ID=${id}`);
    console.log("Import your Twilio number into ElevenLabs and set ELEVENLABS_PHONE_NUMBER_ID. No calls were placed.");
    if (!opt("ANTHROPIC_API_KEY")) console.log("Claude credentials are deferred: set the shared ANTHROPIC_API_KEY before enabling calls.");
  }
  process.exit(0);
}

if (dryRun) {
  console.log(JSON.stringify(AGENTS.map((spec) => agentConfig(spec, [])), null, 2));
  process.exit(0);
}

need("ELEVENLABS_API_KEY");
const mode = toolMode();
const baseUrl = opt("PUBLIC_URL");
console.log(`tool mode: ${mode}${mode === "webhook" ? ` → ${baseUrl}/api/eleven/tools/:name` : ""}`);

const existing = await listTools();
const toolIds = new Map<string, string>();
const lines: string[] = [];
for (const spec of AGENTS) {
  const ids: string[] = [];
  for (const name of toolNamesForSpec(spec)) {
    if (!toolIds.has(name)) {
      const id = await upsertTool(toolConfig(name, mode, baseUrl), existing);
      toolIds.set(name, id);
      console.log(`  tool ${name} → ${id}`);
    }
    ids.push(toolIds.get(name)!);
  }
  const prior = opt(spec.envVar);
  const id = await upsertAgent(agentConfig(spec, ids), prior);
  console.log(`${prior ? "updated" : "created"} ${spec.name} → ${id}`);
  lines.push(`${spec.envVar}=${id}`);
}

console.log(`\nPaste into vellum/server/.env:\n${lines.join("\n")}`);
