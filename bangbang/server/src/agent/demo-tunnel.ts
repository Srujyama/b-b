// Temporary demo tunnel. Follow provider URL rotations and update the existing browser agent.
import { spawn } from "node:child_process";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { need } from "../env.js";
import { apiBase, upsertAgent } from "./elevenlabs.js";
import { browserAgentConfig } from "./browser-demo.js";

const freeOrigin = /^https:\/\/[a-z0-9-]+\.(?:lhr\.life|localhost\.run)$/;
export function tunnelOrigin(line: string): string | undefined {
  try {
    const event = JSON.parse(line);
    if (event.type !== "v1.tcpip_forward.register.accepted" || typeof event.id !== "string" || !event.id.startsWith("localhost/")) return;
    const url = `https://${event.id.slice("localhost/".length)}`;
    return freeOrigin.test(url) ? url : undefined;
  } catch { return; } // SSH banners and non-JSON diagnostic lines are not commands.
}

export async function syncBrowserTunnel(url: string, envFile: string, f: typeof fetch = fetch): Promise<void> {
  if (!freeOrigin.test(url)) throw new Error("Unsupported free tunnel origin");
  const id = need("ELEVENLABS_BROWSER_AGENT_ID"), secret = need("ELEVENLABS_LLM_SECRET_ID");
  const boundedFetch: typeof fetch = (input, init = {}) => f(input, { ...init, signal: AbortSignal.timeout(10_000) });
  const response = await boundedFetch(`${apiBase()}/v1/convai/agents/${encodeURIComponent(id)}`, {
    headers: { "xi-api-key": need("ELEVENLABS_API_KEY") },
  });
  if (!response.ok) throw new Error(`Cannot read browser agent (${response.status})`);
  const existing = await response.json() as { conversation_config?: { agent?: { prompt?: { tool_ids?: unknown } } } };
  const tools = existing.conversation_config?.agent?.prompt?.tool_ids;
  if (!Array.isArray(tools) || tools.length !== 3 || !tools.every((id) => typeof id === "string"))
    throw new Error("Provision the three browser client tools with --browser first");
  await upsertAgent(browserAgentConfig(url, secret, tools), id, boundedFetch);
  // Read immediately before writing: preserve unrelated settings, never print credentials.
  const original = await readFile(envFile, "utf8");
  const line = `PUBLIC_URL=${url}`;
  const next = /^PUBLIC_URL=.*$/m.test(original) ? original.replace(/^PUBLIC_URL=.*$/m, line) : `${original.trimEnd()}\n${line}\n`;
  const temporary = `${envFile}.tunnel-${randomUUID()}`;
  try {
    await writeFile(temporary, next, { mode: 0o600, flag: "wx" });
    await rename(temporary, envFile);
  } finally { await unlink(temporary).catch(() => {}); }
  process.env.PUBLIC_URL = url;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
  const { config } = await import("dotenv"); config({ path: envFile, quiet: true });
  need("ELEVENLABS_API_KEY"); need("ELEVENLABS_BROWSER_AGENT_ID"); need("ELEVENLABS_LLM_SECRET_ID");
  const port = Number(process.env.VOICE_GATEWAY_PORT) || 8788;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid voice gateway port");
  const ssh = spawn("ssh", ["-T", "-o", "BatchMode=yes", "-o", "IdentityAgent=none", "-o", "IdentitiesOnly=yes",
    "-o", "IdentityFile=/dev/null", "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${join(tmpdir(), "bangbang-tunnel-known-hosts")}`,
    "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", "-o", "ExitOnForwardFailure=yes",
    "-R", `80:127.0.0.1:${port}`, "nokey@localhost.run", "--", "--output", "json"], { stdio: ["ignore", "pipe", "inherit"] });
  let previous: string | undefined;
  let updates = Promise.resolve();
  createInterface({ input: ssh.stdout! }).on("line", (line) => {
    const origin = tunnelOrigin(line);
    if (!origin || origin === previous) return;
    previous = origin;
    updates = updates.then(async () => {
      await syncBrowserTunnel(origin, envFile);
      console.log(`Voice HTTPS ready: ${origin} (ElevenLabs and local .env updated)`);
    }).catch(() => {
      console.error("Tunnel URL synchronization failed. Check the saved agent IDs/key and rerun --browser before restarting this launcher.");
      process.exitCode = 1; ssh.kill("SIGTERM");
    });
  });
  ssh.once("error", () => { console.error("Could not start ssh for the demo tunnel"); process.exitCode = 1; });
  ssh.once("close", (code) => { if (code) process.exitCode = 1; console.log("Demo tunnel stopped. Restart this launcher to reconnect."); });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => ssh.kill(signal));
}
