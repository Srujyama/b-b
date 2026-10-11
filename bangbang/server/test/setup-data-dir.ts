// Every test file gets its own throwaway DATA_DIR so persisted stores (cases, escrows, BNB log bodies)
// never touch bangbang/server/.data and nothing is left behind.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { flushAll } from "../src/persist.js";

const dir = mkdtempSync(join(tmpdir(), "bb-data-"));
process.env.DATA_DIR = dir;

afterAll(() => {
  flushAll(); // settle pending debounced writes before the directory goes
  rmSync(dir, { recursive: true, force: true });
});
