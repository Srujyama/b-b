# Vellum

**Vellum** is an AI advocate that negotiates medical bills and appeals insurance denials for people the billing
system talks past, starting with a Mandarin-speaking mom and a $14,296 ER bill. Built at B@B Hacks 2.0.

- **Start here (judges):** [`vellum/README.md`](vellum/README.md): what it does, how each sponsor track is used,
  and what is live vs. mocked.
- **Team:** [`vellum/TEAM.md`](vellum/TEAM.md) (run it, who owns what), [`vellum/WORKPLAN.md`](vellum/WORKPLAN.md).
- **Submission text:** [`vellum/docs/SUBMISSION.md`](vellum/docs/SUBMISSION.md).
- **Negotiation engine:** the engine from our earlier car-price negotiator (Lowball) now lives in Vellum:
  leverage ranking (`vellum/server/src/engine/leverage.ts`, served at `GET /api/cases/:id/leverage`) and an
  LLM-vs-LLM eval of the advocate against tough / moderate / stonewall billing reps and insurer reviewers
  (`cd vellum/server && npm run eval:negotiation -- --help`; needs `ANTHROPIC_API_KEY`, prints a cost estimate first).
