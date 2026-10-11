import type { FastifyInstance } from "fastify";
import type { CasePacket, FairPrice } from "../types.js";
import { emit, requireCase, updateCase } from "../store.js";
import { contextDevKey } from "../research/contextdev.js";
import { lookupFairPrice } from "../research/fairprice.js";
import { findCharityPolicy } from "../research/charity.js";
import { buildNegotiation } from "../research/facts.js";

const MAX_CODES = 6; // research the highest-charge codes; keeps Context.dev credits + latency bounded
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** Run research for a case: fair prices per code, the hospital's 501(r) policy, then the negotiation ladder. */
export async function researchCase(id: string): Promise<CasePacket> {
  const c = requireCase(id);
  if (!c.bill) throw Object.assign(new Error("case has no parsed bill — POST /api/cases first"), { statusCode: 409 });
  if (!c.patient) throw Object.assign(new Error("case has no patient mandate (patient.maxPay)"), { statusCode: 409 });
  contextDevKey(); // 503 if Context.dev not configured
  if (!process.env.OPENAI_API_KEY) throw Object.assign(new Error("OpenAI is not configured — set OPENAI_API_KEY in bangbang/server/.env"), { statusCode: 503 });
  const bill = c.bill;
  const hospital = bill.provider.name;
  const log = (message: string, messageZh: string) => emit(id, { type: "log", message, messageZh });

  // unique coded lines, biggest charges first
  const byCode = new Map<string, { code: string; description: string; charge: number }>();
  for (const li of bill.lineItems) {
    if (!li.code) continue;
    const prev = byCode.get(li.code);
    byCode.set(li.code, { code: li.code, description: li.description, charge: (prev?.charge ?? 0) + li.charge });
  }
  const codes = [...byCode.values()].sort((a, b) => b.charge - a.charge).slice(0, MAX_CODES);
  log(`Researching fair prices for ${codes.length} billed codes via Context.dev`, `正在通过 Context.dev 查询 ${codes.length} 个收费项目的合理价格`);

  const fairPrices: FairPrice[] = [];
  const failures: string[] = [];
  await Promise.all(
    codes.map(async ({ code, description, charge }) => {
      try {
        const fp = await lookupFairPrice(code, description, hospital);
        fp.billed = charge;
        fairPrices.push(fp);
        const bits = [
          fp.medicareRate !== undefined ? `Medicare ${usd(fp.medicareRate)}` : "",
          fp.hospitalCashPrice !== undefined ? `cash price ${usd(fp.hospitalCashPrice)}` : "",
        ].filter(Boolean);
        const bitsZh = [
          fp.medicareRate !== undefined ? `联邦医保（Medicare）支付 ${usd(fp.medicareRate)}` : "",
          fp.hospitalCashPrice !== undefined ? `医院自己公布的现金价 ${usd(fp.hospitalCashPrice)}` : "",
        ].filter(Boolean);
        if (bits.length) log(`${code}: billed ${usd(charge)}, ${bits.join(", ")} (${fp.sources.map((s) => s.url).join(", ")})`, `${code}：账单收费 ${usd(charge)}，${bitsZh.join("，")}`);
        else log(`${code}: no verifiable published price found`, `${code}：未找到可核实的公开价格`);
      } catch (e) {
        failures.push(`${code}: ${(e as Error).message}`);
        emit(id, { type: "error", message: `fair price ${code}: ${(e as Error).message}` });
      }
    }),
  );
  if (codes.length && failures.length === codes.length) {
    throw Object.assign(new Error(`fair-price research failed for every code: ${failures.join("; ")}`), { statusCode: 502 });
  }
  fairPrices.sort((a, b) => (b.billed ?? 0) - (a.billed ?? 0));

  log(`Looking up ${hospital}'s financial assistance policy (IRS 501(r))`, `正在查找 ${hospital} 的经济援助（慈善医疗）政策`);
  let charity = c.charity;
  try {
    charity = await findCharityPolicy(hospital, bill.provider.website, log);
    if (charity.hasFap) {
      const t = [
        charity.freeCareBelowPctFpl ? `free below ${charity.freeCareBelowPctFpl}% FPL` : "",
        charity.discountBelowPctFpl ? `discount below ${charity.discountBelowPctFpl}% FPL` : "",
      ].filter(Boolean);
      const tZh = [
        charity.freeCareBelowPctFpl ? `收入低于贫困线 ${charity.freeCareBelowPctFpl}% 可免费` : "",
        charity.discountBelowPctFpl ? `低于 ${charity.discountBelowPctFpl}% 可打折` : "",
      ].filter(Boolean);
      log(`Found financial assistance policy: ${t.join(", ") || charity.summary}`, `找到医院的经济援助政策：${tZh.join("，") || "详见来源"}`);
    } else log(`No financial assistance policy found for ${hospital}`, `未找到该医院的经济援助政策`);
  } catch (e) {
    emit(id, { type: "error", message: `charity policy: ${(e as Error).message}` });
  }

  const neg = buildNegotiation({ ...c, fairPrices, charity });
  log(
    `Negotiation plan: open at ${usd(neg.opening)}, target ${usd(neg.target)}, walk away above ${usd(neg.walkaway)} (${neg.facts.length} facts)`,
    `谈判计划：先报价 ${usd(neg.opening)}，目标 ${usd(neg.target)}，超过 ${usd(neg.walkaway)} 不接受`,
  );
  return updateCase(id, { fairPrices, charity, facts: neg.facts, target: neg.target, opening: neg.opening, walkaway: neg.walkaway, status: "researched" });
}

export default async function researchRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>("/api/cases/:id/research", async (req, reply) => {
    try {
      return await researchCase(req.params.id);
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });
}
