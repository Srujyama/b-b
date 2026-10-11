import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { persistedMap } from "./persist.js";
import type { CaseEvent, CasePacket, Receipt } from "./types.js";

// Case store + per-case event bus. Cases live in memory and are persisted (debounced, atomic) to
// DATA_DIR/cases.json, reloaded on startup. Demo-scale; swap for a DB later.
const caseStore = persistedMap<CasePacket>("cases");
const cases = caseStore.map;
/** Mark the case store dirty — call after mutating a packet in place without updateCase/emit. */
export const persistCases = () => caseStore.save();
/** Test/ops hook: re-read cases from DATA_DIR (restart simulation). */
export const reloadCases = () => caseStore.load();
/** Test/ops hook: write pending case changes now. */
export const flushCases = () => caseStore.flush();
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
  caseStore.save();
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
  // Every event follows some change to the case (many routes mutate the packet in place, then emit),
  // so any emit marks the store dirty. Debounced: a burst of events costs one write.
  if (cases.has(id)) caseStore.save();
  const data = JSON.stringify(event);
  for (const s of subscribers.get(id) ?? []) if (s.readyState === 1) s.send(data);
}
