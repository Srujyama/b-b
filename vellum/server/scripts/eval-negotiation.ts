// LLM-vs-LLM negotiation eval: our production advocate prompt vs counterparty personas, graded by a strict
// JSON judge. Engine in src/engine/eval.ts (ported from Lowball's eval-negotiation.ts, adapted to medical bills).
//
// Usage (from vellum/server):
//   npm run eval:negotiation -- [--mode patient|clinic] [--n 3] [--personas tough,moderate,stonewall] [--out eval-results.json] [--max-turns 24] [--yes]
//
// Needs ANTHROPIC_API_KEY (vellum/server/.env). Makes REAL Claude calls, which cost real money: the estimate is
// printed first, and the run waits 5 seconds (skip with --yes) so you can Ctrl-C. The demo case is built
// from fixtures with SAMPLE research (labelled); nothing touches the case store or any chain.
import "dotenv/config";
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  PERSONAS,
  PRICE_PER_MTOK,
  buildDemoPacket,
  costUsd,
  estimateCost,
  factsTally,
  gradeSimulation,
  runSimulation,
  summarize,
  violationCounts,
  type GradedRun,
  type Mode,
  type Persona,
} from "../src/engine/eval.js";

type Args = { mode: Mode; n: number; personas: Persona[]; out: string; maxTurns: number; yes: boolean };

const HELP = `npm run eval:negotiation -- [--mode patient|clinic] [--n 3] [--personas tough,moderate,stonewall] [--out <file.json>] [--max-turns 24] [--yes]`;

function parseArgs(argv: string[]): Args {
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      console.log(HELP);
      process.exit(0);
    }
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}\n${HELP}`);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      raw[a.slice(2)] = next;
      i++;
    } else raw[a.slice(2)] = "true";
  }
  const mode = (raw.mode ?? "patient") as Mode;
  if (mode !== "patient" && mode !== "clinic") throw new Error(`--mode must be patient or clinic (got ${raw.mode})`);
  const n = raw.n ? Number(raw.n) : 3;
  if (!Number.isInteger(n) || n < 1) throw new Error(`--n must be a positive integer (got ${raw.n})`);
  const maxTurns = raw["max-turns"] ? Number(raw["max-turns"]) : 24;
  if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error(`--max-turns must be a positive integer (got ${raw["max-turns"]})`);
  const personas = (raw.personas ? raw.personas.split(",").map((s) => s.trim()) : PERSONAS) as Persona[];
  for (const p of personas) if (!PERSONAS.includes(p)) throw new Error(`unknown persona "${p}"; choices: ${PERSONAS.join(", ")}`);
  return { mode, n, personas, maxTurns, out: raw.out ?? `eval-results-${mode}.json`, yes: raw.yes === "true" };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set (vellum/server/.env): this eval makes real Claude calls and cannot run without it");

  const packet = await buildDemoPacket(args.mode);
  const est = estimateCost(packet, args.personas, args.n, args.maxTurns);
  const model = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
  console.log(`Mode ${args.mode}: ${est.sims} simulated call(s), personas=[${args.personas.join(", ")}], n=${args.n}, model=${model}`);
  if (args.mode === "patient") console.log(`Case: balance $${packet.bill?.patientBalance.toLocaleString("en-US")}, walkaway $${packet.walkaway}, target $${packet.target} (research is SAMPLE data)`);
  else console.log(`Case: ${packet.claim?.payer} denial of ${packet.claim?.procedure.code} (policy + criteria mapping are SAMPLE data)`);
  console.log(
    `Cost estimate (worst case, every call runs ${args.maxTurns} exchanges): ~${est.usage.inputTokens.toLocaleString()} input + ~${est.usage.outputTokens.toLocaleString()} output tokens ` +
      `=> ~$${est.usd.toFixed(2)} at $${PRICE_PER_MTOK.input}/$${PRICE_PER_MTOK.output} per MTok (Claude Opus 5.5 list price${model !== "claude-opus-5-5" ? `; ${model} is priced differently` : ""}).`,
  );
  if (!args.yes) {
    console.log("Starting in 5 seconds (Ctrl-C to abort, --yes to skip the wait)...");
    await new Promise((r) => setTimeout(r, 5000));
  }

  const runs: GradedRun[] = [];
  for (const persona of args.personas) {
    for (let i = 0; i < args.n; i++) {
      console.log(`  -> ${persona} #${i + 1}`);
      const sim = await runSimulation(packet, persona, { runIndex: i, maxTurns: args.maxTurns });
      const run: GradedRun = { ...sim };
      try {
        const g = await gradeSimulation(packet, sim);
        run.grade = g.grade;
        run.usage = { inputTokens: run.usage.inputTokens + g.usage.inputTokens, outputTokens: run.usage.outputTokens + g.usage.outputTokens };
      } catch (e) {
        run.gradeError = (e as Error).message;
      }
      runs.push(run);
      console.log(
        `  <- ${persona} #${i + 1}: ${sim.outcome}${sim.finalAmount != null ? ` at $${sim.finalAmount.toLocaleString("en-US")}` : ""}` +
          `${sim.pctSaved != null ? ` (${sim.pctSaved}% saved)` : ""}, ${sim.turns} turns${sim.walkawayViolation ? ", WALKAWAY VIOLATION ATTEMPTED" : ""}${run.gradeError ? `, grader failed: ${run.gradeError}` : ""}`,
      );
    }
  }

  console.log(`\n=== ${args.mode} mode: Vellum advocate vs ${args.mode === "clinic" ? "insurer reviewers" : "hospital billing reps"} ===\n`);
  console.table(summarize(runs));
  const v = violationCounts(runs);
  console.log(`Violations (out of ${runs.length}): ${Object.entries(v).map(([k, c]) => `${k}=${c}`).join(", ")}`);
  const gradeErrors = runs.filter((r) => r.gradeError).length;
  if (gradeErrors) console.log(`Grader failed on ${gradeErrors} run(s); see gradeError in the JSON.`);
  console.log(`Facts used: ${JSON.stringify(factsTally(runs))}`);

  const usage = runs.reduce((s, r) => ({ inputTokens: s.inputTokens + r.usage.inputTokens, outputTokens: s.outputTokens + r.usage.outputTokens }), { inputTokens: 0, outputTokens: 0 });
  console.log(`Actual usage: ${usage.inputTokens.toLocaleString()} input + ${usage.outputTokens.toLocaleString()} output tokens => ~$${costUsd(usage).toFixed(2)} at Opus 5.5 list price.`);

  const outPath = path.resolve(process.cwd(), args.out);
  writeFileSync(outPath, JSON.stringify({ mode: args.mode, model, personas: args.personas, n: args.n, sampleData: true, runs }, null, 2));
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
