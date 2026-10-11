// Negotiation engine routes. GET /api/cases/:id/leverage: the case's leverage, strongest first (see engine/leverage.ts).
import type { FastifyInstance } from "fastify";
import { getCase } from "../store.js";
import { rankLeverage } from "../engine/leverage.js";

export default async function engineRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/cases/:id/leverage", async (req, reply) => {
    const c = getCase(req.params.id);
    if (!c) return reply.code(404).send({ error: "unknown case" });
    if (!c.bill) return reply.code(409).send({ error: "case has no parsed bill: leverage is ranked from the bill (POST /api/cases first)" });
    return { caseId: c.id, items: rankLeverage(c) };
  });
}
