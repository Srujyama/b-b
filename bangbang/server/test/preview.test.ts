import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import { seedPreview } from "../src/dev/preview.js";

describe("dev preview harness", () => {
  afterEach(() => {
    delete process.env.DEV_PREVIEW;
  });

  it("is NOT mounted in a normal run", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/dev/preview?stage=room" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("seeds a case at each stage when DEV_PREVIEW=1, using the real parser + audit", async () => {
    process.env.DEV_PREVIEW = "1";
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/dev/preview?stage=bill" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/#case=/);
    expect((await app.inject({ method: "GET", url: "/dev/preview?stage=nope" })).statusCode).toBe(400);
    await app.close();

    const bill = await seedPreview("bill", 0);
    expect(bill.bill?.patientBalance).toBe(14296);
    expect(bill.flags.reduce((s, f) => s + f.amountAtStake, 0)).toBeCloseTo(2230.6, 1);

    const done = await seedPreview("receipts", 0);
    expect(done.status).toBe("settled");
    expect(done.agreedAmount).toBe(600);
    expect(done.agreedAmount!).toBeLessThanOrEqual(done.walkaway!);
    // every preview receipt is visibly labeled so it can never pass as a real transaction
    expect(done.receipts.every((r) => r.txHash.startsWith("PREVIEW"))).toBe(true);
  });

  it("labels seeded cases at EVERY stage, and dashboard.js isPreview() detects them (incl. stage=bill)", async () => {
    // pull isPreview out of the browser module (it touches the DOM at import time) and evaluate it alone
    const src = await readFile(new URL("../../web/dashboard.js", import.meta.url), "utf8");
    const m = src.match(/const isPreview = \(p\) =>([\s\S]*?);\n/);
    expect(m, "isPreview in dashboard.js").toBeTruthy();
    const isPreview = new Function("p", `return (${m![1]});`) as (p: unknown) => boolean;

    for (const stage of ["bill", "research", "room", "receipts"] as const) {
      const c = await seedPreview(stage, 0);
      expect(c.facts.some((f) => f.startsWith("PREVIEW")), stage).toBe(true);
      expect(isPreview(c), stage).toBe(true);
    }
    // stage=bill has no receipts, research or charity: the fact is the only marker, and it must suffice
    const bill = await seedPreview("bill", 0);
    expect(bill.receipts).toHaveLength(0);
    expect(bill.charity).toBeUndefined();
    // a real case (no markers) is not flagged
    expect(isPreview({ facts: [], receipts: [], fairPrices: [] })).toBe(false);
  });
});
