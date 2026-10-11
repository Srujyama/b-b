#!/usr/bin/env node
// Fails a PR whose branch belongs to stream A/B/C but edits files owned by another stream or by D (shared files).
// D branches may edit anything. Override for one PR with the `cross-stream-ok` label.
// Usage: check-ownership.mjs <branch> <file>...   (CI passes the PR's changed files)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const map = JSON.parse(readFileSync(fileURLToPath(new URL("../ownership.json", import.meta.url)), "utf8"));

function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") { re += ".*"; i++; }
    else if (ch === "*") re += "[^/]*";
    else re += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
const owners = Object.entries(map.streams).map(([id, s]) => ({ id, name: s.name, res: s.paths.map(globToRegex) }));

// "feat/voice" also matches feat/voice-2, feat/voice/turns, feat/voice_x; "chore/" matches any chore/... branch.
export function streamForBranch(branch) {
  const hit = Object.keys(map.branches)
    .filter((p) => (p.endsWith("/") ? branch.startsWith(p) : branch === p || /^[-/_]/.test(branch.slice(p.length)) && branch.startsWith(p)))
    .sort((a, b) => b.length - a.length)[0];
  return hit && map.branches[hit];
}
export function ownerOf(file) {
  return owners.find((o) => o.res.some((r) => r.test(file)))?.id ?? "D";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [branch, ...files] = process.argv.slice(2);
  const stream = streamForBranch(branch ?? "");
  if (!stream) {
    console.log(`::warning::branch "${branch}" matches no stream (use feat/voice, feat/rails, feat/research, feat/product, chore/*, fix/*) - ownership not enforced`);
    process.exit(0);
  }
  if (stream === "D") {
    console.log(`branch ${branch} is stream D (integration) - may edit any file. ${files.length} file(s) changed.`);
    process.exit(0);
  }
  const foreign = files.map((f) => ({ f, owner: ownerOf(f) })).filter((x) => x.owner !== stream);
  for (const f of files) if (!foreign.some((x) => x.f === f)) console.log(`ok   ${f}`);
  for (const { f, owner } of foreign) {
    const who = owner === "D" ? "D (integration/shared)" : `${owner} (${map.streams[owner].name})`;
    console.log(`::error file=${f}::${f} is owned by ${who}, not ${stream}. Ask the owner to make this change, or add the cross-stream-ok label if agreed.`);
  }
  if (foreign.length) process.exit(1);
  console.log(`ownership ok: all ${files.length} file(s) belong to stream ${stream}`);
}
