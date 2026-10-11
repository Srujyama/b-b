// Smoke test: connect to /dashboard WS, fire fake Vapi webhook events,
// assert they fan out to the WS client. Run from server/: node scripts/smoke-ws.mjs
import WebSocket from "ws";

const BASE = "http://localhost:8081";
const got = [];
const ws = new WebSocket("ws://localhost:8081/dashboard");

const post = (body) =>
  fetch(`${BASE}/vapi-webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

ws.on("message", (d) => got.push(JSON.parse(d.toString())));

ws.on("open", async () => {
  await post({ message: { type: "status-update", status: "in-progress" } });
  await post({
    message: {
      type: "transcript",
      role: "user",
      transcriptType: "final",
      transcript: "Best I can do is eleven nine.",
    },
  });
  const toolRes = await post({
    message: {
      type: "tool-calls",
      toolCallList: [
        { id: "tc1", name: "log_offer", arguments: { price: 11900 } },
      ],
    },
  });
  console.log("tool-calls response:", JSON.stringify(toolRes));
  await post({
    message: {
      type: "tool-calls",
      toolCallList: [
        { id: "tc2", function: { name: "end_call", arguments: '{"outcome":"deal","price":11300}' } },
      ],
    },
  });

  setTimeout(() => {
    console.log("WS received:", JSON.stringify(got, null, 1));
    const types = got.map((e) => e.type);
    const want = ["hello", "status", "transcript", "offer", "call-ended"];
    const ok = want.every((t) => types.includes(t));
    console.log(ok ? "SMOKE-OK" : `SMOKE-FAIL missing: ${want.filter((t) => !types.includes(t))}`);
    process.exit(ok ? 0 : 1);
  }, 500);
});

setTimeout(() => {
  console.log("SMOKE-FAIL timeout, got:", JSON.stringify(got));
  process.exit(1);
}, 5000);
