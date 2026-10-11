import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { CaseEvent, CasePacket, Receipt } from "./types.js";

// In-memory case store + per-case event bus. Demo-scale; swap for a DB later.
const cases = new Map<string, CasePacket>();
const subscribers = new Map<string, Set<WebSocket>>();

export function createCase(init: Partial<CasePacket> & Pick<CasePacket, "mode">): CasePacket {
  const packet: CasePacket = {
    id: randomUUID(),
    status: "intake",
    flags: [],
    fairPrices: [],
    facts: [],
    offers: [],
    transcript: [],
    receipts: [],
    createdAt: new Date().toISOString(),
    ...init,
  };
  cases.set(packet.id, packet);
  return packet;
}

export function getCase(id: string): CasePacket | undefined {
  return cases.get(id);
}

export function requireCase(id: string): CasePacket {
  const c = cases.get(id);
  if (!c) throw Object.assign(new Error(`unknown case ${id}`), { statusCode: 404 });
  return c;
}

export function listCases(): CasePacket[] {
  return [...cases.values()];
}

export function updateCase(id: string, patch: Partial<CasePacket>): CasePacket {
  const c = requireCase(id);
  Object.assign(c, patch);
  emit(id, { type: "case", packet: c });
  if (patch.status) emit(id, { type: "status", status: patch.status });
  return c;
}

export function addReceipt(id: string, receipt: Receipt) {
  requireCase(id).receipts.push(receipt);
  emit(id, { type: "receipt", receipt });
}

export function subscribe(id: string, socket: WebSocket) {
  let set = subscribers.get(id);
  if (!set) subscribers.set(id, (set = new Set()));
  set.add(socket);
  socket.on("close", () => set!.delete(socket));
  const c = cases.get(id);
  if (c) socket.send(JSON.stringify({ type: "case", packet: c } satisfies CaseEvent));
}

export function emit(id: string, event: CaseEvent) {
  const data = JSON.stringify(event);
  for (const s of subscribers.get(id) ?? []) if (s.readyState === 1) s.send(data);
}
