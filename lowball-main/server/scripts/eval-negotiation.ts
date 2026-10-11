// LLM-vs-LLM negotiation eval.
//
// Simulates the buyer-side negotiation prompt (OLD, frozen verbatim from
// src/assistant.ts, or NEW, live-loaded from the in-progress rewrite) against
// three dealer personas, both played by gpt-4o, then grades each transcript
// with a gpt-4o judge and prints a summary.
//
// Usage (from server/):
//   npx tsx scripts/eval-negotiation.ts --prompt old|new [--n 3] [--personas tough,moderate,stonewall] [--out results.json]
//
// Requires OPENAI_API_KEY in server/.env (loaded via dotenv). Makes REAL
// OpenAI API calls — costs real (small) money. See the printed cost estimate.
import "dotenv/config";
import { writeFileSync } from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import {
  ASKING_PRICE,
  DEALER_PERSONAS,
  FIXTURE_CAR,
  GRADER_PROMPT,
  newPrompt,
  oldFirstMessage,
  oldPrompt,
  type DealerPersonaName,
} from "./eval-fixtures.js";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
type PromptKind = "old" | "new";

type CliArgs = {
  prompt: PromptKind;
  n: number;
  personas: DealerPersonaName[];
  out: string;
};

const ALL_PERSONAS: DealerPersonaName[] = ["tough", "moderate", "stonewall"];

function parseArgs(argv: string[]): CliArgs {
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      raw[key] = next;
      i++;
    } else {
      raw[key] = "true";
    }
  }

  if (raw.prompt !== "old" && raw.prompt !== "new") {
    throw new Error(`--prompt must be "old" or "new" (got ${JSON.stringify(raw.prompt)})`);
  }
  const prompt: PromptKind = raw.prompt;

  const n = raw.n ? Number(raw.n) : 3;
  if (!Number.isFinite(n) || n < 1) throw new Error(`--n must be a positive integer (got ${raw.n})`);

  const personas: DealerPersonaName[] = raw.personas
    ? (raw.personas.split(",").map((s) => s.trim()) as DealerPersonaName[])
    : ALL_PERSONAS;
  for (const p of personas) {
    if (!ALL_PERSONAS.includes(p)) {
      throw new Error(`Unknown persona "${p}". Choices: ${ALL_PERSONAS.join(", ")}`);
    }
  }

  const out = raw.out ?? `eval-results-${prompt}.json`;
  return { prompt, n, personas, out };
}

// ---------------------------------------------------------------------------
// OpenAI client + buyer tools (mirrors the three Vapi function tools the
// production buyer prompt uses; endCall is treated as ending the sim, so we
// don't need to expose it here).
// ---------------------------------------------------------------------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 10 }); // 30k TPM org cap — long backoff beats dying

const BUYER_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "log_offer",
      description: "Log a price the dealer just named. Call this the moment any price is said, before responding.",
      parameters: {
        type: "object",
        properties: { price: { type: "number", description: "Price in USD the dealer quoted" } },
        required: ["price"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "accept_offer",
      description: "Accept the deal at this price.",
      parameters: {
        type: "object",
        properties: { price: { type: "number", description: "Agreed price in USD" } },
        required: ["price"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "end_call",
      description: "Signal the final outcome right before hanging up.",
      parameters: {
        type: "object",
        properties: {
          outcome: { type: "string", enum: ["deal", "no_deal"] },
          price: { type: "number", description: "Final price if a deal was made" },
        },
        required: ["outcome"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Sim types
// ---------------------------------------------------------------------------
type TranscriptTurn = { speaker: "buyer" | "dealer"; text: string };

type GradeResult = {
  revealed_target: boolean;
  claimed_human: boolean;
  named_number_first: boolean;
  missed_log_offer: boolean;
  used_facts: string[];
  caved_immediately: boolean;
};

type SimOutcome = "deal" | "no_deal" | "hangup" | "timeout";

type SimResult = {
  persona: DealerPersonaName;
  runIndex: number;
  transcript: TranscriptTurn[];
  loggedOffers: number[];
  outcome: SimOutcome;
  finalPrice: number | null;
  savings: number | null;
  turns: number;
  tokensApprox: { input: number; output: number };
  grade?: GradeResult;
  gradeError?: string;
};

const approxTokens = (s: string) => Math.ceil(s.length / 4);

// ---------------------------------------------------------------------------
// One buyer<->dealer simulation.
// ---------------------------------------------------------------------------
async function runSim(
  buyerPrompt: { systemPrompt: string; firstMessage: string },
  persona: DealerPersonaName,
  runIndex: number,
): Promise<SimResult> {
  const buyerMessages: ChatCompletionMessageParam[] = [{ role: "system", content: buyerPrompt.systemPrompt }];
  const dealerMessages: ChatCompletionMessageParam[] = [{ role: "system", content: DEALER_PERSONAS[persona] }];

  const transcript: TranscriptTurn[] = [];
  const loggedOffers: number[] = [];
  let acceptedPrice: number | null = null;
  let outcome: SimOutcome = "timeout";
  let finalPrice: number | null = null;
  let tokensIn = 0;
  let tokensOut = 0;
  let turns = 0;

  // Buyer speaks first.
  buyerMessages.push({ role: "assistant", content: buyerPrompt.firstMessage });
  dealerMessages.push({ role: "user", content: buyerPrompt.firstMessage });
  transcript.push({ speaker: "buyer", text: buyerPrompt.firstMessage });

  const MAX_TURNS = 30;
  let ended = false;

  for (turns = 0; turns < MAX_TURNS && !ended; turns++) {
    // --- dealer turn ---
    tokensIn += approxTokens(JSON.stringify(dealerMessages));
    const dealerRes = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.9,
      messages: dealerMessages,
    });
    const dealerRaw = dealerRes.choices[0]?.message?.content ?? "";
    tokensOut += approxTokens(dealerRaw);
    const hangup = dealerRaw.includes("[HANGUP]");
    const dealerText = dealerRaw.replace("[HANGUP]", "").trim();

    dealerMessages.push({ role: "assistant", content: dealerRaw });
    if (dealerText) {
      transcript.push({ speaker: "dealer", text: dealerText });
      buyerMessages.push({ role: "user", content: dealerText });
    }

    if (hangup) {
      outcome = "hangup";
      ended = true;
      break;
    }

    // --- buyer turn (tool-call loop: keep round-tripping while the model is
    // still issuing tool calls; stop once it produces a plain reply) ---
    let buyerText = "";
    let sawEndCall: { outcome: "deal" | "no_deal"; price?: number } | null = null;

    for (let inner = 0; inner < 6; inner++) {
      tokensIn += approxTokens(JSON.stringify(buyerMessages));
      const buyerRes = await openai.chat.completions.create({
        model: "gpt-4o",
        temperature: 0.6,
        messages: buyerMessages,
        tools: BUYER_TOOLS,
      });
      const msg = buyerRes.choices[0]?.message;
      tokensOut += approxTokens(msg?.content ?? "") + approxTokens(JSON.stringify(msg?.tool_calls ?? ""));

      const toolCalls = msg?.tool_calls ?? [];
      const assistantMsg: Record<string, unknown> = { role: "assistant", content: msg?.content ?? null };
      if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
      buyerMessages.push(assistantMsg as ChatCompletionMessageParam);

      for (const tc of toolCalls) {
        if (tc.type !== "function") continue;
        const name = tc.function.name;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          // leave args empty — malformed tool call, treated as a no-op besides logging.
        }
        if (name === "log_offer" && typeof args.price === "number") {
          loggedOffers.push(args.price);
        } else if (name === "accept_offer" && typeof args.price === "number") {
          acceptedPrice = args.price;
        } else if (name === "end_call") {
          sawEndCall = {
            outcome: args.outcome === "no_deal" ? "no_deal" : "deal",
            price: typeof args.price === "number" ? args.price : undefined,
          };
        }
        buyerMessages.push({ role: "tool", tool_call_id: tc.id, content: "ok" });
      }

      if (msg?.content) buyerText = msg.content;
      if (sawEndCall) break; // sim ends regardless of further turns
      if (toolCalls.length === 0) break; // model gave its spoken reply for this turn
    }

    if (buyerText) {
      transcript.push({ speaker: "buyer", text: buyerText });
    }
    dealerMessages.push({ role: "user", content: buyerText || "(buyer said nothing this turn)" });

    if (sawEndCall) {
      outcome = sawEndCall.outcome;
      finalPrice = sawEndCall.price ?? acceptedPrice ?? loggedOffers[loggedOffers.length - 1] ?? null;
      ended = true;
      break;
    }
  }

  if (!ended) {
    outcome = "timeout";
    finalPrice = acceptedPrice;
  }

  const savings = outcome === "deal" && finalPrice != null ? ASKING_PRICE - finalPrice : null;

  let grade: GradeResult | undefined;
  let gradeError: string | undefined;
  try {
    grade = await gradeTranscript(transcript, loggedOffers, outcome, finalPrice);
  } catch (err) {
    gradeError = (err as Error).message;
  }

  return {
    persona,
    runIndex,
    transcript,
    loggedOffers,
    outcome,
    finalPrice,
    savings,
    turns,
    tokensApprox: { input: tokensIn, output: tokensOut },
    grade,
    gradeError,
  };
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------
async function gradeTranscript(
  transcript: TranscriptTurn[],
  loggedOffers: number[],
  outcome: SimOutcome,
  finalPrice: number | null,
): Promise<GradeResult> {
  const transcriptText = transcript.map((t) => `${t.speaker.toUpperCase()}: ${t.text}`).join("\n");
  const userContent = [
    `TRANSCRIPT:`,
    transcriptText,
    ``,
    `LOGGED OFFERS (buyer's log_offer tool calls, in order): ${JSON.stringify(loggedOffers)}`,
    `OUTCOME: ${outcome}${finalPrice != null ? `, final price ${finalPrice}` : ""}`,
  ].join("\n");

  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: GRADER_PROMPT },
      { role: "user", content: userContent },
    ],
  });
  const raw = res.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw);
  return {
    revealed_target: Boolean(parsed.revealed_target),
    claimed_human: Boolean(parsed.claimed_human),
    named_number_first: Boolean(parsed.named_number_first),
    missed_log_offer: Boolean(parsed.missed_log_offer),
    used_facts: Array.isArray(parsed.used_facts)
      ? parsed.used_facts.filter((f: unknown): f is string => typeof f === "string")
      : [],
    caved_immediately: Boolean(parsed.caved_immediately),
  };
}

// ---------------------------------------------------------------------------
// Concurrency-limited map
// ---------------------------------------------------------------------------
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
function summarize(results: SimResult[]) {
  const deals = results.filter((r) => r.outcome === "deal" && r.finalPrice != null);
  const dealRate = results.length ? deals.length / results.length : 0;
  const prices = deals.map((r) => r.finalPrice as number);
  const meanPrice = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
  const bestPrice = prices.length ? Math.min(...prices) : null;
  const savingsList = deals.map((r) => r.savings).filter((s): s is number => s != null);
  const meanSavings = savingsList.length ? savingsList.reduce((a, b) => a + b, 0) / savingsList.length : null;
  const meanTurns = results.length ? results.reduce((s, r) => s + r.turns, 0) / results.length : 0;

  const violations = {
    revealed_target: 0,
    claimed_human: 0,
    named_number_first: 0,
    missed_log_offer: 0,
    caved_immediately: 0,
  };
  const gradeErrors = results.filter((r) => r.gradeError).length;
  const factsTally: Record<string, number> = {};
  for (const r of results) {
    if (!r.grade) continue;
    if (r.grade.revealed_target) violations.revealed_target++;
    if (r.grade.claimed_human) violations.claimed_human++;
    if (r.grade.named_number_first) violations.named_number_first++;
    if (r.grade.missed_log_offer) violations.missed_log_offer++;
    if (r.grade.caved_immediately) violations.caved_immediately++;
    for (const f of r.grade.used_facts) factsTally[f] = (factsTally[f] ?? 0) + 1;
  }

  return { n: results.length, dealRate, meanPrice, bestPrice, meanSavings, meanTurns, violations, gradeErrors, factsTally };
}

function fmtUsd(n: number | null): string {
  return n == null ? "-" : `$${Math.round(n).toLocaleString()}`;
}

function printSummary(promptKind: PromptKind, results: SimResult[]) {
  console.log(`\n=== Summary: ${promptKind.toUpperCase()} prompt vs ${FIXTURE_CAR.year} ${FIXTURE_CAR.make} ${FIXTURE_CAR.model} (asking ${fmtUsd(ASKING_PRICE)}) ===\n`);

  const personasPresent = Array.from(new Set(results.map((r) => r.persona)));
  const rows: Record<string, unknown>[] = [];

  for (const persona of personasPresent) {
    const s = summarize(results.filter((r) => r.persona === persona));
    rows.push({
      persona,
      n: s.n,
      dealRate: `${Math.round(s.dealRate * 100)}%`,
      meanPrice: fmtUsd(s.meanPrice),
      bestPrice: fmtUsd(s.bestPrice),
      meanSavings: s.meanSavings == null ? "-" : `$${Math.round(s.meanSavings).toLocaleString()}`,
      meanTurns: s.meanTurns.toFixed(1),
    });
  }
  const overall = summarize(results);
  rows.push({
    persona: "OVERALL",
    n: overall.n,
    dealRate: `${Math.round(overall.dealRate * 100)}%`,
    meanPrice: fmtUsd(overall.meanPrice),
    bestPrice: fmtUsd(overall.bestPrice),
    meanSavings: overall.meanSavings == null ? "-" : `$${Math.round(overall.meanSavings).toLocaleString()}`,
    meanTurns: overall.meanTurns.toFixed(1),
  });

  console.table(rows);

  console.log(
    `Violations (overall, out of ${overall.n} sims): revealed_target=${overall.violations.revealed_target}, ` +
      `claimed_human=${overall.violations.claimed_human}, named_number_first=${overall.violations.named_number_first}, ` +
      `missed_log_offer=${overall.violations.missed_log_offer}, caved_immediately=${overall.violations.caved_immediately}` +
      (overall.gradeErrors ? ` (grader failed on ${overall.gradeErrors} sim(s) — see gradeError in JSON)` : ""),
  );
  console.log(`Facts usage tally (overall): ${JSON.stringify(overall.factsTally)}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set — check server/.env");
  }

  const { prompt: promptKind, n, personas, out } = parseArgs(process.argv.slice(2));

  console.log(`Loading ${promptKind.toUpperCase()} prompt...`);
  const buyerPrompt =
    promptKind === "old" ? { systemPrompt: oldPrompt(), firstMessage: oldFirstMessage() } : await newPrompt();

  const jobs: { persona: DealerPersonaName; runIndex: number }[] = [];
  for (const persona of personas) {
    for (let i = 0; i < n; i++) jobs.push({ persona, runIndex: i });
  }

  console.log(`Running ${jobs.length} sim(s) — personas=[${personas.join(", ")}], n=${n}, concurrency=1...\n`);

  const results = await mapWithConcurrency(jobs, 1, async (job) => { // serial: 3-way parallel blows the TPM cap
    console.log(`  -> starting ${job.persona} #${job.runIndex + 1}`);
    const res = await runSim(buyerPrompt, job.persona, job.runIndex);
    console.log(
      `  <- done    ${job.persona} #${job.runIndex + 1}: outcome=${res.outcome} price=${res.finalPrice ?? "-"} turns=${res.turns}`,
    );
    return res;
  });

  printSummary(promptKind, results);

  const outPath = path.resolve(process.cwd(), out);
  writeFileSync(
    outPath,
    JSON.stringify({ prompt: promptKind, fixtureCar: FIXTURE_CAR, personas, n, results }, null, 2),
  );
  console.log(`\nWrote full results to ${outPath}`);

  const totalIn = results.reduce((s, r) => s + r.tokensApprox.input, 0);
  const totalOut = results.reduce((s, r) => s + r.tokensApprox.output, 0);
  const roughCost = (totalIn / 1_000_000) * 5 + (totalOut / 1_000_000) * 15; // rough gpt-4o list pricing
  console.log(
    `\nRough cost estimate: ~${totalIn.toLocaleString()} input tok / ~${totalOut.toLocaleString()} output tok ` +
      `(char/4 approximation, includes judge calls) => ~$${roughCost.toFixed(2)} at rough gpt-4o list pricing.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
