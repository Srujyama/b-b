// Live proof for the hospital portal on XRPL DEVNET with the .env wallets (npm run setup:xrpl first).
//
//   1. seeds one patient case from the demo statement (deterministic reader + audit; no LLM, no call)
//      and sets agreedAmount directly: the negotiation is NOT run here, it is stated as such in the case facts
//   2. POST /api/cases/:id/credential   real CredentialCreate + CredentialAccept on devnet
//   3. POST /api/cases/:id/settle       real EscrowCreate (PREIMAGE-SHA-256 condition) on devnet
//   4. serves the app on PORT so the portal can be opened at /hospital.html#case=<id>
//   5. with --release: POST /api/hospital/cases/:id/confirm-zero-balance (the portal's route) -> real Batch
//
//   PORT=8931 npx tsx scripts/live-hospital.ts [--amount 600] [--release]
// Without --release the server stays up: release from the portal page (or curl) and Ctrl-C when done.
import "dotenv/config";
import { buildApp } from "../src/index.js";
import { createCase } from "../src/store.js";
import { loadDemoFixture } from "../src/routes/bill.js";
import { parseStatementText } from "../src/bill/parse.js";
import { auditBill } from "../src/bill/audit.js";
import type { Receipt } from "../src/types.js";

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const amount = Number(arg("--amount") ?? 600);
const release = process.argv.includes("--release");
const port = Number(process.env.PORT) || 8931;

const app = await buildApp();
await app.listen({ port, host: "127.0.0.1" });
const post = async <T>(url: string, body: unknown = {}) => {
  const res = await app.inject({ method: "POST", url, payload: body as object });
  if (res.statusCode >= 400) throw new Error(`${url} -> ${res.statusCode}: ${res.body}`);
  return res.json() as T;
};
const show = (rs: Receipt[]) => rs.forEach((r) => console.log(`  ✓ ${r.kind.padEnd(16)} ${r.txHash}\n    ${r.explorerUrl}`));

const { patient, text } = await loadDemoFixture();
const bill = parseStatementText(text);
const c = createCase({
  mode: "patient",
  status: "agreed",
  patient,
  bill,
  flags: auditBill(bill),
  agreedAmount: amount,
  facts: [`LIVE PROOF script (scripts/live-hospital.ts): agreedAmount ${amount} set directly; no negotiation call was made for this case.`],
});
console.log(`case ${c.id}  ${patient.name}  ${bill.provider.name}  billed ${bill.patientBalance}  agreed ${amount}`);

console.log("\n▶ hardship credential (devnet)");
show(await post<Receipt[]>(`/api/cases/${c.id}/credential`));
console.log("\n▶ settlement escrow (devnet)");
show(await post<Receipt[]>(`/api/cases/${c.id}/settle`));

console.log(`\nportal: http://127.0.0.1:${port}/hospital.html#case=${c.id}`);
if (release) {
  console.log("\n▶ hospital portal confirms $0 -> Batch release (devnet)");
  const r = await post<{ receipts: Receipt[] }>(`/api/hospital/cases/${c.id}/confirm-zero-balance`, { attest: true, staffName: "live-proof script" });
  show(r.receipts);
  await app.close();
  process.exit(0);
}
console.log("server stays up; release from the portal, then Ctrl-C");
