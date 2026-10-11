import { randomBytes, timingSafeEqual } from "node:crypto";
import { emit, requireCase } from "../store.js";
import type { TranscriptLine } from "../types.js";
import { translateLine } from "./translate.js";

/** Short-lived capability for one browser rehearsal. Never contains a provider credential. */
export class BrowserTranscripts {
  private sessions = new Map<string, { token: string; until: number; count: number; translating: Promise<void> }>();

  start(caseId: string): string {
    for (const [id, session] of this.sessions) if (session.until <= Date.now()) this.sessions.delete(id);
    const token = randomBytes(32).toString("hex");
    this.sessions.set(caseId, { token, until: Date.now() + 5 * 60_000, count: 0, translating: Promise.resolve() });
    return token;
  }

  clear() { this.sessions.clear(); }

  append(caseId: string, token: unknown, line: TranscriptLine): void {
    const session = this.sessions.get(caseId);
    if (!session || session.until <= Date.now() || typeof token !== "string" ||
        !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(session.token)))
      throw Object.assign(new Error("browser transcript session is missing or expired"), { statusCode: 401 });
    const packet = requireCase(caseId);
    if (packet.mode === "patient" && packet.patient?.consent !== true)
      throw Object.assign(new Error("the patient has withdrawn consent"), { statusCode: 409 });
    const counterparty = packet.mode === "clinic" ? "insurer" : "hospital";
    if (!["advocate", counterparty].includes(line.role) || !line.text.trim() || !Number.isFinite(Date.parse(line.at)))
      throw Object.assign(new Error("invalid browser transcript line"), { statusCode: 400 });
    if (packet.transcript.some((l) => l.at === line.at && l.role === line.role && l.text === line.text)) return;
    if (session.count >= 240) throw Object.assign(new Error("browser transcript session is full"), { statusCode: 429 });
    session.count++;
    packet.transcript.push(line);
    // Save and broadcast English immediately; translations must not delay the conversation or lose the record.
    emit(caseId, { type: "transcript", line });
    session.translating = session.translating.then(async () => {
      try {
        line.textZh = await translateLine(line.text, "zh");
        // Refresh the UI without recording the same English turn twice in the on-chain event sink.
        emit(caseId, { type: "case", packet: requireCase(caseId) });
      } catch {
        emit(caseId, { type: "error", message: "Live translation failed; the original transcript was saved." });
      }
    });
  }
}
