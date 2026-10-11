// One-time XRPL DEVNET setup for the server:
//   faucet-fund issuer/patient/hospital/clinic/advocate, USD token (issuer flags + trust lines),
//   mint the patient's demo USD, create the community fund (closed vault + donation + loan broker),
//   then write XRPL_* seeds/ids into bangbang/server/.env (only XRPL_* lines are touched).
//
//   npx tsx scripts/setup-xrpl.ts            # no-op if already configured
//   npx tsx scripts/setup-xrpl.ts --fresh    # new wallets + new fund
//   npx tsx scripts/setup-xrpl.ts --help
import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client, Wallet } from "xrpl";
import { networkUrl, setupToken, submitTx, usd, USD, type XrplCtx } from "../src/chain/xrpl.js";
import { createCommunityFund } from "../src/chain/xrplFund.js";

const ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("usage: npx tsx scripts/setup-xrpl.ts [--fresh]\n  Faucet-funds devnet wallets, issues USD, creates the community fund vault, writes XRPL_* to .env");
  process.exit(0);
}
const fresh = args.includes("--fresh");
const PATIENT_USD = Number(process.env.XRPL_SETUP_PATIENT_USD || 5000);
const FUND_DONATION = Number(process.env.XRPL_SETUP_FUND_USD || 50000);

/** Set KEY=value lines in .env: replace an existing KEY= line, else append. Other keys untouched. */
export function upsertEnv(text: string, kv: Record<string, string>): string {
  let out = text;
  for (const [k, v] of Object.entries(kv)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    if (re.test(out)) out = out.replace(re, `${k}=${v}`);
    else out += `${out.endsWith("\n") || out === "" ? "" : "\n"}${k}=${v}\n`;
  }
  return out;
}

async function main() {
  if (!fresh && process.env.XRPL_FUND_ISSUER_SEED && process.env.XRPL_VAULT_ID && process.env.XRPL_LOAN_BROKER_ID) {
    console.log("XRPL already configured in .env (pass --fresh to recreate).");
    return;
  }
  const network = networkUrl();
  const client = new Client(network);
  await client.connect();
  try {
    console.log(`funding wallets on ${network} ...`);
    const fund = async () => (await client.fundWallet(null)).wallet as Wallet;
    const [issuer, patient, hospital, clinic, advocate, donor] = await Promise.all([fund(), fund(), fund(), fund(), fund(), fund()]);
    const ctx: XrplCtx = { client, network, actors: { issuer, patient, hospital, clinic, advocate } };
    for (const [k, w] of Object.entries(ctx.actors)) console.log(`  ${k.padEnd(9)} ${w.address}`);

    const receipts = await setupToken(ctx, [{ wallet: patient, amount: PATIENT_USD }]);
    // a separate, vetted donor: the fund vault is private to holders of the fund's VerifiedDonor credential
    await submitTx(ctx, { TransactionType: "TrustSet", Account: donor.address, LimitAmount: { currency: USD, issuer: issuer.address, value: "1000000000" } }, donor);
    await submitTx(ctx, { TransactionType: "Payment", Account: issuer.address, Destination: donor.address, Amount: usd(issuer.address, FUND_DONATION) }, issuer);
    console.log(`  donor     ${donor.address}`);
    const f = await createCommunityFund(ctx, { owner: issuer, donor, donation: FUND_DONATION, investAfterSec: 20, termYears: 6 });
    receipts.push(...f.receipts);
    for (const r of receipts) console.log(`  ✓ ${r.kind.padEnd(14)} ${r.explorerUrl}`);

    const text = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
    writeFileSync(
      ENV_PATH,
      upsertEnv(text, {
        XRPL_NETWORK: network,
        XRPL_FUND_ISSUER_SEED: issuer.seed!,
        XRPL_PATIENT_SEED: patient.seed!,
        XRPL_HOSPITAL_SEED: hospital.seed!,
        XRPL_CLINIC_SEED: clinic.seed!,
        XRPL_ADVOCATE_SEED: advocate.seed!,
        XRPL_VAULT_ID: f.vaultId,
        XRPL_LOAN_BROKER_ID: f.loanBrokerId,
        XRPL_DONOR_DOMAIN_ID: f.domainId ?? "",
      }),
    );
    console.log(`\nwrote XRPL_* to ${ENV_PATH}\ndomain ${f.domainId}\nvault ${f.vaultId} (private: VerifiedDonor only)\nbroker ${f.loanBrokerId}`);
    console.log("note: loans can originate ~20 s after setup (closed-ended vault subscription window).");
  } finally {
    await client.disconnect();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error("setup-xrpl FAILED:", e?.data ?? e?.message ?? e);
    process.exit(1);
  });
}
