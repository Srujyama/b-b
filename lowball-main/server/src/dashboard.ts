import type { WebSocket } from "ws";

const clients = new Set<WebSocket>();

export function addClient(socket: WebSocket) {
  clients.add(socket);
  socket.on("close", () => clients.delete(socket));
  socket.send(JSON.stringify({ type: "hello", clients: clients.size }));
}

// Mirror call events to stdout so `npm run start` logs read as a live call.
function logEvent(e: Record<string, unknown>) {
  switch (e.type) {
    case "transcript":
      if (e.final) console.log(`[call] ${e.role === "user" ? "dealer" : "alex"}: ${e.text}`);
      break;
    case "offer":
      console.log(`[call] 💰 dealer offered $${e.price}`);
      break;
    case "deal":
      console.log(`[call] 🤝 DEAL at $${e.price}`);
      break;
    case "call-started":
      console.log(`[call] ☎️  started ${e.callId}`);
      break;
    case "call-ended":
      console.log(`[call] 📴 ended: ${e.outcome}${e.price ? ` at $${e.price}` : ""}`);
      break;
    case "status":
      console.log(`[call] status: ${e.status}`);
      break;
    case "report":
      console.log(`[call] report: ${e.endedReason} — ${e.summary ?? ""}`);
      break;
  }
}

export function broadcast(event: Record<string, unknown>) {
  logEvent(event);
  const data = JSON.stringify(event);
  for (const client of clients) {
    if (client.readyState === 1) client.send(data);
  }
}
