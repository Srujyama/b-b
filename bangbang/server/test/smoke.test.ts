import { describe, it, expect } from "vitest";
import { buildApp } from "../src/index.js";

describe("server", () => {
  it("boots and reports health", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    await app.close();
  });
});
