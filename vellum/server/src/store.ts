import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { persistedMap } from "./persist.js";
import type { ActivityStage, CaseActivity, CaseEvent, CasePacket, Receipt } from "./types.js";

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
  const packet = cases.get(id);
  // Keep user-visible activity with the case so reconnecting never loses fast tool updates.
  // These are execution summaries and tool results, not private model reasoning.
  if (packet && ["log", "error", "offer", "deal"].includes(event.type)) {
    let message = "";
    let kind: CaseActivity["kind"] = "update";
    if (event.type === "log" || event.type === "error") {
      message = event.message;
      if (event.type === "error") kind = "error";
    } else if (event.type === "offer") {
      message = `${event.offer.by === "advocate" ? "Vellum proposed" : "Billing offered"} $${event.offer.amount.toLocaleString("en-US")}${event.offer.note ? ` — ${event.offer.note}` : ""}`;
      kind = "offer";
    } else if (event.type === "deal") {
      message = `${packet.voiceSimulation ? "Simulated agreement" : "Agreement"} reached at $${event.amount.toLocaleString("en-US")}`;
      kind = "result";
    }
    let stage: ActivityStage = packet.status === "negotiating" ? "call" : ["agreed", "settled"].includes(packet.status) ? "outcome" : packet.bill ? "research" : "review";
    if (/negotiation plan|mandate|consent|payment limit/i.test(message)) stage = "plan";
    else if (/call|voice|elevenlabs|negotiat|bridge/i.test(message) || event.type === "offer") stage = "call";
    else if (/context.dev|fair.price|research|policy|medicare/i.test(message)) stage = "research";
    else if (/bill received|reading|read \d+|audit:|statement reader|loaded|reviewing your|upload|intake complete/i.test(message)) stage = "review";
    if (event.type === "deal") stage = "outcome";
    const entry: CaseActivity = { id: randomUUID(), at: new Date().toISOString(), stage, kind, message };
    packet.activity = [...(packet.activity ?? []), entry].slice(-200);
    const activity = JSON.stringify({ type: "activity", entry } satisfies CaseEvent);
    for (const s of subscribers.get(id) ?? []) if (s.readyState === 1) s.send(activity);
  }
  if (packet) caseStore.save();
  const data = JSON.stringify(event);
  for (const s of subscribers.get(id) ?? []) if (s.readyState === 1) s.send(data);
}
