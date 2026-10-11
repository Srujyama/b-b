// Live agent-vs-agent negotiation check against a RUNNING server (local or hosted).
// Creates the demo case and runs real research (unless --case is given), starts
// POST /negotiate {counterparty:"agent"}, then subscribes to /ws?case=<id> and prints every
// transcript/offer/deal/status/log/error event with a timestamp, plus per-voice audio chunk counts.
//
// Usage (from vellum/server):
//   npx tsx scripts/live-negotiation.ts [--base http://localhost:8787] [--case <id>] [--max-seconds 300]
//
// Costs real ElevenLabs credits (two conversations, up to ~4 minutes) and, without --case, a Context.dev
// + Claude research pass. Never dials a phone. Exits 0 when the call ended with a recorded outcome.
import WebSocket from "ws";

const HELP = "npx tsx scripts/live-negotiation.ts [--base http://localhost:8787] [--case <id>] [--max-seconds 300]";

function args() {
  const a = process.argv.slice(2);
  const get = (k: string) => {
    const i = a.indexOf(`--${k}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  if (a.includes("--help") || a.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }
  return {
    base: (get("base") ?? "http://localhost:8787").replace(/\/$/, ""),
    caseId: get("case"),
    maxSeconds: Number(get("max-seconds") ?? 300),
  };
}

async function post(base: string, path: string, body: unknown = {}) {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json()) as any;
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

async function main() {
  const { base, caseId: given, maxSeconds } = args();
  const t0 = Date.now();
  const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
  let caseId = given;
  if (!caseId) {
    const c = await post(base, "/api/cases/demo");
    caseId = c.id as string;
    console.log(ts(), `demo case ${caseId}`);
    const p = await post(base, `/api/cases/${caseId}/research`);
    console.log(ts(), `research: status=${p.status} target=${p.target} walkaway=${p.walkaway} facts=${p.facts?.length}`);
  }

  const audio: Record<string, { chunks: number; bytes: number; rate: number }> = {};
  let lastWho = "";
  let outcome: string | undefined;
  let callStart = 0;
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws?case=${caseId}`);
  const finish = (code: number) => {
    const secs = callStart ? ((Date.now() - callStart) / 1000).toFixed(1) : "-";
    for (const [who, a] of Object.entries(audio))
      console.log(`audio ${who}: ${a.chunks} chunks, ${a.bytes} bytes (~${(a.bytes / 2 / a.rate).toFixed(1)}s @${a.rate} Hz)`);
    console.log(`call duration ${secs}s; outcome: ${outcome ?? "none recorded"}`);
    ws.close();
    process.exit(code);
  };
  ws.on("open", async () => {
    callStart = Date.now();
    const r = await post(base, `/api/cases/${caseId}/negotiate`, { counterparty: "agent" });
    console.log(ts(), `negotiate -> ${JSON.stringify(r)}`);
  });
  ws.on("message", (d) => {
    let m: any;
    try {
      m = JSON.parse(d.toString());
    } catch {
      return;
    }
    switch (m.type) {
      case "audio": {
        const a = (audio[m.who] ??= { chunks: 0, bytes: 0, rate: m.sampleRate });
        a.chunks++;
        a.bytes += Buffer.from(m.chunk, "base64").length;
        if (lastWho !== m.who) console.log(ts(), `  [${m.who} speaking]`);
        lastWho = m.who;
        return;
      }
      case "transcript":
        return console.log(ts(), `${String(m.line.role).toUpperCase()}: ${m.line.text}`);
      case "offer":
        return console.log(ts(), `OFFER by ${m.offer.by}: $${m.offer.amount}${m.offer.note ? ` (${m.offer.note})` : ""}`);
      case "deal":
        outcome = `deal at $${m.amount}`;
        return console.log(ts(), `DEAL $${m.amount}`);
      case "status":
        return console.log(ts(), `STATUS ${m.status}`);
      case "error":
        return console.log(ts(), `ERROR ${m.message}`);
      case "log":
        console.log(ts(), `LOG ${m.message}`);
        if (/Call ended with no deal/.test(m.message)) outcome ??= "no_deal";
        if (/Negotiation call ended \((\w+)\)/.test(m.message)) setTimeout(() => finish(outcome ? 0 : 1), 1000);
        return;
      default:
        return; // case snapshots etc.
    }
  });
  setTimeout(() => {
    console.log(ts(), "watcher timed out");
    finish(1);
  }, maxSeconds * 1000);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
