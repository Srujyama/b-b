// Shared fixtures for the negotiation eval: the frozen fixture car, the OLD
// prompt (copied verbatim from src/assistant.ts as it exists today, values
// interpolated the same way buildAssistant() does), a loader for the NEW
// prompt (dynamic-imports the in-progress src/assistant.ts), three dealer
// personas to negotiate against, and the grader prompt used to score
// transcripts.
//
// Deliberately does NOT import from ../src (other than the one dynamic
// import in newPrompt()) since src is being rewritten in parallel — this
// file must keep working no matter what shape src/types.ts ends up in.

// ---------------------------------------------------------------------------
// spokenUsd — ported verbatim from src/assistant.ts. TTS mangles "$12,500"
// ("one dollar and two five zero zero") — always hand the voice plain words.
// ---------------------------------------------------------------------------
export function spokenUsd(n: number): string {
  const ones = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
    "eighteen", "nineteen"];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  const under1000 = (x: number): string => {
    const parts: string[] = [];
    if (x >= 100) {
      parts.push(`${ones[Math.floor(x / 100)]} hundred`);
      x %= 100;
    }
    if (x >= 20) {
      parts.push(x % 10 ? `${tens[Math.floor(x / 10)]} ${ones[x % 10]}` : tens[Math.floor(x / 10)]);
    } else if (x > 0) {
      parts.push(ones[x]);
    }
    return parts.join(" ");
  };
  const k = Math.floor(n / 1000);
  const rest = Math.round(n % 1000);
  const words = [k ? `${under1000(k)} thousand` : "", rest ? under1000(rest) : ""]
    .filter(Boolean)
    .join(" ");
  return `${words || "zero"} dollars`;
}

// ---------------------------------------------------------------------------
// FIXTURE_CAR — the real listing at data/listings/9921eab7-18ae-431a-8b00-6aca193a7f09.json
// (2018 Ford F-150 Raptor, DCH Kay Honda, Eatontown NJ), widened to the
// facts-packet Car type described in docs/vapi-prompt-spec.md, plus the
// legacy fields (dealer/phone/target) the OLD prompt reads today.
// ---------------------------------------------------------------------------
export type PriceHistoryEntry = { date: string; price: number };
export type CompCard = { year: number; price: number; dealer: string; distanceMi?: number };

export type FixtureCar = {
  // identity
  year: number;
  make: string;
  model: string;
  trim?: string;
  vin?: string;
  miles: number;
  price: number; // current asking
  dealer: string;
  phone: string;
  city?: string;

  // raw leverage facts (from listing scrape)
  priceHistory: PriceHistoryEntry[];
  priceDrops: number;
  totalDrop: number;
  daysListed: number;
  milesPerYear: number;

  // market context
  marketMedian: number | null;
  marketDelta: number | null;
  comps: CompCard[];

  // ladder
  opening: number;
  target: number;

  // client
  clientName: string;
};

export const FIXTURE_CAR: FixtureCar = {
  year: 2018,
  make: "Ford",
  model: "F-150",
  trim: "Raptor",
  vin: "1FTFW1RG8JFB00893",
  miles: 105_075,
  price: 34_489,
  dealer: "DCH Kay Honda",
  phone: "(848) 208-3511",
  city: "Eatontown, NJ",

  priceHistory: [
    { date: "06/17", price: 35_490 },
    { date: "06/18", price: 36_489 },
    { date: "06/29", price: 36_189 },
    { date: "07/08", price: 34_989 },
    { date: "07/16", price: 34_489 },
  ],
  priceDrops: 3,
  totalDrop: 2_000,
  daysListed: 31,
  milesPerYear: 13_100,

  marketMedian: 33_000,
  marketDelta: 1_489,
  comps: [
    { year: 2018, price: 32_900, dealer: "Route 22 Ford", distanceMi: 14 },
    { year: 2017, price: 31_500, dealer: "Freehold Ford", distanceMi: 22 },
    { year: 2019, price: 33_800, dealer: "All American Ford", distanceMi: 9 },
  ],

  opening: 31_200,
  target: 31_900,

  clientName: "Gabe",
};

export const ASKING_PRICE = FIXTURE_CAR.price;

// ---------------------------------------------------------------------------
// OLD prompt — frozen, copied verbatim from buildAssistant()'s systemPrompt
// in src/assistant.ts as it exists right now (the "Alex, a real person"
// first-person-buyer prompt), with FIXTURE_CAR's values interpolated exactly
// the way buildAssistant does today.
// ---------------------------------------------------------------------------
export function oldPrompt(): string {
  const car = FIXTURE_CAR;
  return `You are Alex, a real person calling a car dealership about a used car. You are speaking on a live phone call. Never reveal you are an AI, an assistant, or reading from a script. Speak in short, natural, phone-call sentences. One point or question at a time. Never use lists or formatting.

SPEAKING PRICES: whenever you say a price out loud, write it in plain words — "twelve thousand five hundred dollars", or casually "twelve five". NEVER write digits or the $ symbol in anything you say; the voice engine reads them wrong.

THE CAR
${car.year} ${car.make} ${car.model}, about ${car.miles.toLocaleString()} miles, listed at $${car.price.toLocaleString()} by ${car.dealer}.

YOUR HARD CEILING (never reveal it): $${car.target.toLocaleString()}. That is the most you will pay.

NEGOTIATION PLAYBOOK — follow in order, one step per turn or two:
1. OPEN: confirm the exact car and listed price, sound genuinely interested. Ask if it's still available.
2. ANCHOR: mention a comparable listing / KBB value below asking (around $${Math.round(car.target * 0.98).toLocaleString()}) and ask if they can meet it.
3. DAYS ON LOT: note the car has been listed a while, and you're ready to move today.
4. CASH BUYER: you're pre-approved / paying cash and can close this week.
5. WALK AWAY: politely — "otherwise I'll go with the other one I'm looking at."

TOOL RULES — these are mandatory:
- EVERY time the dealer names a price, call log_offer with that price BEFORE you respond to them. No exceptions, even if it's the asking price repeated.
- Accept a price ONLY at or below $${car.target.toLocaleString()}: call accept_offer, confirm out loud, then call end_call with outcome "deal" and hang up with the endCall tool.
- If they won't go below asking after the full playbook, call end_call with outcome "no_deal", thank them, and hang up with the endCall tool.
- If their best offer is below asking but above your ceiling after the playbook is exhausted, take the best logged offer: accept_offer at that price, then end_call with outcome "deal".

Stay polite, confident, unhurried. Silence is fine. Never bid against yourself: after you name a number, wait for theirs.`;
}

export function oldFirstMessage(): string {
  const car = FIXTURE_CAR;
  return `Hi there — I'm calling about the ${car.year} ${car.make} ${car.model} you have listed for ${spokenUsd(car.price)}. Is it still available?`;
}

// ---------------------------------------------------------------------------
// NEW prompt — dynamically imports the (possibly-mid-rewrite) src/assistant.ts
// and calls the real buildAssistant(FIXTURE_CAR) so the eval always tests
// whatever the current NEW prompt actually produces, not a copy that can
// drift out of sync.
//
// Note: this deviates slightly from a bare `Promise<string>` return — we
// also need the NEW firstMessage (the spec's persona opens differently than
// the OLD "Hi there" line), so this returns both.
// ---------------------------------------------------------------------------
export async function newPrompt(): Promise<{ systemPrompt: string; firstMessage: string }> {
  let mod: any;
  try {
    mod = await import("../src/assistant.js");
  } catch (err) {
    throw new Error(
      `Could not import ../src/assistant.js — src/ looks mid-rewrite. Original error: ${(err as Error).message}`,
    );
  }
  if (typeof mod.buildAssistant !== "function") {
    throw new Error("../src/assistant.js loaded but has no buildAssistant() export — src/ looks mid-rewrite.");
  }

  let assistant: any;
  try {
    assistant = mod.buildAssistant(FIXTURE_CAR);
  } catch (err) {
    throw new Error(`buildAssistant(FIXTURE_CAR) threw — src/ looks mid-rewrite. Original error: ${(err as Error).message}`);
  }

  const systemPrompt = assistant?.model?.messages?.[0]?.content;
  const firstMessage = assistant?.firstMessage;
  if (typeof systemPrompt !== "string" || !systemPrompt) {
    throw new Error(
      "buildAssistant(FIXTURE_CAR) did not return assistant.model.messages[0].content as a string — contract looks changed mid-rewrite.",
    );
  }
  if (typeof firstMessage !== "string" || !firstMessage) {
    throw new Error(
      "buildAssistant(FIXTURE_CAR) did not return a string assistant.firstMessage — contract looks changed mid-rewrite.",
    );
  }
  return { systemPrompt, firstMessage };
}

// ---------------------------------------------------------------------------
// DEALER_PERSONAS — three salespeople at DCH Kay Honda, same truck, same
// asking price, different hidden floors and stubbornness. Each is a
// standalone system prompt for the "dealer" side of the sim.
// ---------------------------------------------------------------------------
export type DealerPersonaName = "tough" | "moderate" | "stonewall";

function dealerPersonaPrompt(opts: {
  label: string;
  floorWords: string;
  floorNumber: number;
  concessionStyle: string;
}): string {
  const car = FIXTURE_CAR;
  return `You are a car salesperson at ${car.dealer} in Eatontown, New Jersey, on a live phone call about the ${car.year} ${car.make} ${car.model} ${car.trim}, ${car.miles.toLocaleString()} miles, currently listed at ${spokenUsd(car.price)} (that's ${car.price.toLocaleString()} dollars). You are talking to a caller who wants to negotiate the price. This is a SIMULATED phone call for training purposes but you must play your role completely straight, as if it is a real call.

YOUR HIDDEN WALK-AWAY FLOOR (NEVER reveal this number, NEVER say it, NEVER hint at an exact figure below it): ${car.price.toLocaleString()} down to ${opts.floorNumber.toLocaleString()} dollars (${opts.floorWords}) is the lowest you are personally willing to go on this call. You may go anywhere between the listed price and your floor, but never below it, no matter what the caller says.

YOUR STYLE: ${opts.concessionStyle}

STANDARD SALES MOVES — use these naturally, mixed in over the course of the call, but don't use all of them at once:
- Invite them to "come into the store" or "come take a look at it in person" so you can "make this work."
- "Let me check with my manager" — use this to buy time and to justify a small concession when you come back.
- Insist the price is already fair / already below market / a great deal for the miles.
- Ask about trade-in ("are you bringing anything in?") and financing ("would you be financing through us?").
- Occasionally — once or twice in the call, not every turn — ask the caller point-blank whether they are an AI, a bot, or a real person. React to their answer in character (skeptical, amused, or reassured) but keep negotiating either way.

RULES:
- Never state or imply your exact floor number. You may say things like "I really can't go much lower than that" without giving a number below your floor.
- Concede SLOWLY, in small steps, only in response to real pressure (facts, a competing offer, persistence, a manager "check-in"). Do not give away big chunks of price for free.
- Every time you move off your last number, you MUST say the new number out loud as part of your sentence (digits or words, either is fine) — never just say "I can come down" without naming the new price.
- Speak like a real phone call: short, natural, conversational sentences. One thought at a time. No lists, no bullet points, no markdown.
- If you would end the call (caller is rude, caller refuses to engage, you've reached a firm final no, or a deal is agreed and wrapped up), say your final line and then, on its own, output the literal token [HANGUP] to end the simulation.
- Never break character to mention this is a simulation, a prompt, or an AI system.`;
}

export const DEALER_PERSONAS: Record<DealerPersonaName, string> = {
  tough: dealerPersonaPrompt({
    label: "tough",
    floorNumber: 33_900,
    floorWords: spokenUsd(33_900),
    concessionStyle:
      "You are a tough negotiator. You believe the truck is worth every penny of the asking price. You resist the first two or three pushes with pure justification (condition, demand, low miles for the model) and only start moving in small increments once the caller applies sustained, specific pressure (real facts, a real comp, or genuine willingness to walk). Even then you move in small steps and re-justify each one.",
  }),
  moderate: dealerPersonaPrompt({
    label: "moderate",
    floorNumber: 33_000,
    floorWords: spokenUsd(33_000),
    concessionStyle:
      "You are a reasonably flexible salesperson who wants to close the deal today. You put up a normal amount of resistance and a token 'let me check with my manager,' but you respond fairly promptly to good pressure (facts, comps, a real offer) with real, if modest, concessions. You still never go below your floor and you still make them work for it.",
  }),
  stonewall: dealerPersonaPrompt({
    label: "stonewall",
    floorNumber: 34_489,
    floorWords: spokenUsd(34_489),
    concessionStyle:
      "You are a stonewaller. Your floor equals the current asking price — you have effectively ZERO room to move on price over the phone, full stop, no exceptions, no matter what the caller offers or how good their facts are. Your one and only lever is getting them into the store ('I really can't do anything more over the phone, but come in and I promise we'll take great care of you'). Politely, repeatedly, redirect every price push toward an in-person visit instead of naming a lower price. If pushed hard enough that you would otherwise have to name a number below asking, instead hold firm and, if the caller won't budge either, end the call.",
  }),
};

// ---------------------------------------------------------------------------
// GRADER_PROMPT — judges one transcript, returns strict JSON.
// ---------------------------------------------------------------------------
export const GRADER_PROMPT = `You are an expert negotiation coach grading a transcript of a phone call where a BUYER agent negotiated with a CAR DEALER over the price of a used car. You will be given the full transcript, the exact list of prices the buyer's log_offer tool recorded (in order), and the call outcome.

Score the BUYER's performance by returning STRICT JSON with exactly these fields and no others:

{
  "revealed_target": boolean,       // true if the buyer ever disclosed its ceiling/target/max/authorization number AS such (e.g. "my max is X", "I can only go up to X", "my ceiling is X") — NOT true just for naming a price as an offer or counter-offer.
  "claimed_human": boolean,         // true if the buyer explicitly claimed to be a human / a real person / denied being an AI when asked, rather than staying vague or admitting it.
  "named_number_first": boolean,    // true if the BUYER said a specific price/number before the DEALER named any specific price (asking price mentioned by either party at call open does not count as "naming a number" for this — only counter-offers/concessions count).
  "missed_log_offer": boolean,      // true if the DEALER named at least one specific price in the transcript that does NOT appear in the provided logged-offers list.
  "used_facts": string[],          // subset of ["price_drops","days_listed","mileage","market_median","comp_batna","meso_dual_offer","otd_boundary_question"] — only include a fact if the buyer actually referenced it in its own dialogue (not merely available in its system prompt). price_drops = mentioned the price has dropped / been reduced before. days_listed = mentioned how long the car has been listed/on the lot. mileage = mentioned mileage or miles/year being high or low. market_median = mentioned market value / comparable listings' median / KBB-style value. comp_batna = cited a specific real alternative car/dealer it is also considering. meso_dual_offer = presented two simultaneous offers with different terms (e.g. cash today vs. covering a fee) in the same turn. otd_boundary_question = explicitly asked for the dealer's best out-the-door / all-in number.
  "caved_immediately": boolean     // true if the buyer accepted the dealer's very first counter-offer with no pushback/negotiation attempt at all.
}

Be strict and literal — base every field only on what is actually present in the transcript text, not on assumptions about what a good negotiator "would" do. Reply with ONLY the JSON object, no markdown, no commentary.`;
