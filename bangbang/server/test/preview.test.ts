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
});
