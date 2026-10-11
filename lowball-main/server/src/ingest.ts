import { ApifyClient } from "apify-client";
import OpenAI from "openai";
import { defaultTarget, type Car } from "./types.js";

// Pre-scraped fallback (README risk item: Apify actor slow/blocked).
// Phone intentionally a non-dialable placeholder — demo calls go to a teammate.
export const FALLBACK_CAR: Car = {
  year: 2019,
  make: "Toyota",
  model: "Camry SE",
  miles: 61000,
  price: 12500,
  dealer: "Sunrise Auto Group",
  phone: "",
  target: 11300,
  clientName: "Gabe",
};

export async function ingestListing(url: string): Promise<Car> {
  const token = process.env.APIFY_TOKEN;
  const actorId = process.env.APIFY_ACTOR_ID;
  if (!token || !actorId) return { ...FALLBACK_CAR };

  const apify = new ApifyClient({ token });
  const run = await apify.actor(actorId).call({ startUrls: [{ url }] });
  const { items } = await apify.dataset(run.defaultDatasetId).listItems();
  if (!items.length) return { ...FALLBACK_CAR };

  const car = await enrich(items[0]);
  if (!car.target) car.target = defaultTarget(car.price);
  return car;
}

// OpenAI turns whatever shape the actor returns into our Car contract.
async function enrich(raw: unknown): Promise<Car> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ...FALLBACK_CAR };

  const openai = new OpenAI({ apiKey });
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          'Extract used-car listing fields from the JSON. Reply with only JSON: {"year":number,"make":string,"model":string,"miles":number,"price":number,"dealer":string,"phone":string}. price is the asking price in USD. phone in E.164 (+1...) if present, else "".',
      },
      { role: "user", content: JSON.stringify(raw).slice(0, 12000) },
    ],
  });
  const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}");
  return {
    year: Number(parsed.year) || FALLBACK_CAR.year,
    make: parsed.make || FALLBACK_CAR.make,
    model: parsed.model || FALLBACK_CAR.model,
    miles: Number(parsed.miles) || FALLBACK_CAR.miles,
    price: Number(parsed.price) || FALLBACK_CAR.price,
    dealer: parsed.dealer || FALLBACK_CAR.dealer,
    phone: parsed.phone || "",
    target: defaultTarget(Number(parsed.price) || FALLBACK_CAR.price),
  };
}
