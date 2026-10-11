// Live end-to-end proof on XRPL DEVNET with fresh faucet wallets (no .env needed):
//   token setup -> hardship credential -> community fund (closed vault + broker) -> 0% loan ->
//   conditional escrow of the agreed amount -> Batch release (EscrowFinish + advocate fee) -> LoanPay.
// Prints an explorer link for every tx. Exits non-zero on any non-tesSUCCESS.
//   npx tsx scripts/live-xrpl.ts
import { Client, Wallet } from "xrpl";
import { assertTestNetwork, DEVNET_URL, issueHardshipCredential, createSettlementEscrow, releaseOnZeroBalance, setupToken, usdBalance, type XrplCtx } from "../src/chain/xrpl.js";
import { createCommunityFund, openZeroInterestLoan, payInstallment } from "../src/chain/xrplFund.js";
import type { Receipt } from "../src/types.js";

const network = assertTestNetwork(process.env.XRPL_LIVE_NETWORK || DEVNET_URL);
const show = (rs: Receipt[]) => rs.forEach((r) => console.log(`  ✓ ${r.kind.padEnd(16)} ${r.explorerUrl}`));
const step = (s: string) => console.log(`\n▶ ${s}`);

async function main() {
  const client = new Client(network);
  await client.connect();
  try {
    step(`funding 5 fresh wallets from the faucet on ${network}`);
    const fund = async () => (await client.fundWallet(null)).wallet as Wallet;
    const [issuer, patient, hospital, clinic, advocate] = await Promise.all([fund(), fund(), fund(), fund(), fund()]);
    const ctx: XrplCtx = { client, network, actors: { issuer, patient, hospital, clinic, advocate } };
    for (const [k, w] of Object.entries(ctx.actors)) console.log(`  ${k.padEnd(9)} ${w.address}`);

    step("USD token: issuer flags (DefaultRipple, AllowTrustLineLocking), trust lines, mint");
    show(await setupToken(ctx, [{ wallet: patient, amount: 1000 }]));

    const caseId = `live-${Date.now()}`;
    step("hardship credential: clinic social worker issues FinancialHardship, patient accepts");
    show(await issueHardshipCredential(caseId, ctx));

    step("community fund: closed-ended vault (USD) + donation + loan broker");
    const investAfterSec = 20;
    const f = await createCommunityFund(ctx, { owner: issuer, donor: issuer, donation: 10000, investAfterSec, termYears: 6 });
    show(f.receipts);
    console.log(`  vault ${f.vaultId}\n  broker ${f.loanBrokerId}`);
    // loans may only originate once the subscription window closes; ledger close time lags wall clock a bit
    await new Promise((r) => setTimeout(r, (investAfterSec + 15) * 1000));

    const agreed = 2140.5;
    step(`0% payment plan: LoanSet ${agreed} USD over 12 months (fund + patient co-sign)`);
    const loan = await openZeroInterestLoan(caseId, agreed, 12, ctx, f);
    show(loan.receipts);

    step(`settlement escrow: ${agreed} USD patient -> hospital, PREIMAGE-SHA-256 condition`);
    const esc = await createSettlementEscrow(caseId, agreed, ctx);
    show([esc.receipt]);

    step("hospital confirms $0 balance -> atomic Batch [EscrowFinish + advocate fee]");
    const before = await usdBalance(ctx, hospital.address);
    show(await releaseOnZeroBalance(caseId, ctx));
    const after = await usdBalance(ctx, hospital.address);
    const adv = await usdBalance(ctx, advocate.address);
    console.log(`  hospital USD ${before} -> ${after}; advocate fee balance ${adv}`);
    if (Math.abs(after - before - agreed) > 0.001) throw new Error(`hospital received ${after - before}, expected ${agreed}`);
    if (adv <= 0) throw new Error("advocate fee not received");

    step("patient pays first installment (LoanPay)");
    show([await payInstallment(ctx, loan.loanId)]);

    console.log("\nALL XRPL DEVNET STEPS tesSUCCESS");
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  console.error("\n✗ live-xrpl FAILED:", e?.data ?? e?.message ?? e);
  process.exit(1);
});
