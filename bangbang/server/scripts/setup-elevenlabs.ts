// Create or update BangBang's ElevenLabs agents + tools, then print the ids for .env.
//   npx tsx scripts/setup-elevenlabs.ts            (idempotent: PATCHes agents whose id is already in .env)
//   npx tsx scripts/setup-elevenlabs.ts --help
// Env: ELEVENLABS_API_KEY (required); ELEVENLABS_TOOL_MODE=client|webhook (default client);
//      PUBLIC_URL (required for webhook mode); ELEVENLABS_TOOL_SECRET (optional webhook header);
//      ELEVENLABS_{ADVOCATE,HOSPITAL,INTAKE}_VOICE_ID, ELEVENLABS_LLM, ELEVENLABS_TTS_MODEL, ELEVENLABS_ZH_TTS_MODEL.
import "dotenv/config";
import { need, opt } from "../src/env.js";
import { AGENTS, agentConfig, createVoiceGatewaySecret, listTools, toolConfig, toolMode, toolNamesForSpec, upsertAgent, upsertTool } from "../src/agent/elevenlabs.js";
import { outboundAgentConfig, publicVoiceUrl } from "../src/agent/call-plan.js";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`setup-elevenlabs: creates/updates 3 ElevenLabs agents (advocate en, hospital billing en, intake zh)
and their tools (log_offer, accept_offer, report_outcome, submit_intake), enables prompt/first_message/
language/voice overrides, and prints the agent ids to paste into bangbang/server/.env.
Tool mode: ELEVENLABS_TOOL_MODE=client (default; no public URL needed) or webhook (needs PUBLIC_URL).
--outbound: configure a separate Haiku 5.5 + ElevenLabs Flash phone representative.
--dry-run: print configs without credentials, network access, or placing a call.
Outbound setup: PUBLIC_URL and VOICE_LLM_TOKEN required; see src/agent/voice.env.example.
This script never places calls.`);
  process.exit(0);
}

const dryRun = process.argv.includes("--dry-run");
if (process.argv.includes("--outbound")) {
  const base = dryRun ? "https://your-voice-server.example" : publicVoiceUrl();
  let secretId = opt("ELEVENLABS_LLM_SECRET_ID");
  if (dryRun) secretId = "<ELEVENLABS_LLM_SECRET_ID>";
  else {
    need("ELEVENLABS_API_KEY");
    need("ANTHROPIC_API_KEY");
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

console.log(`\nPaste into bangbang/server/.env:\n${lines.join("\n")}`);
