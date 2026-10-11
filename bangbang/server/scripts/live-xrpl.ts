// Live end-to-end proof on XRPL DEVNET with fresh faucet wallets (no .env needed):
//   token setup -> hardship credential -> community fund (donor-only Permissioned Domain + PRIVATE closed
//   vault + broker; a non-credentialed depositor must be rejected with tecNO_AUTH) -> 0% loan ->
//   conditional escrow of the agreed amount -> Batch release (EscrowFinish + advocate fee) -> LoanPay.
// Prints an explorer link for every tx. Exits non-zero on any non-tesSUCCESS.
//   npx tsx scripts/live-xrpl.ts
import { Client, Wallet } from "xrpl";
import { assertTestNetwork, DEVNET_URL, issueHardshipCredential, createSettlementEscrow, releaseOnZeroBalance, setupToken, submitTx, usd, usdBalance, USD, type XrplCtx } from "../src/chain/xrpl.js";
import { createCommunityFund, openZeroInterestLoan, payInstallment } from "../src/chain/xrplFund.js";
import type { Receipt } from "../src/types.js";

const network = assertTestNetwork(process.env.XRPL_LIVE_NETWORK || DEVNET_URL);
const show = (rs: Receipt[]) => rs.forEach((r) => console.log(`  ✓ ${r.kind.padEnd(16)} ${r.explorerUrl}`));
const step = (s: string) => console.log(`\n▶ ${s}`);

async function main() {
  const client = new Client(network);
  await client.connect();
  try {
    step(`funding 7 fresh wallets from the faucet on ${network}`);
    const fund = async () => (await client.fundWallet(null)).wallet as Wallet;
    const [issuer, patient, hospital, clinic, advocate, donor, stranger] = await Promise.all([fund(), fund(), fund(), fund(), fund(), fund(), fund()]);
    const ctx: XrplCtx = { client, network, actors: { issuer, patient, hospital, clinic, advocate } };
    for (const [k, w] of Object.entries(ctx.actors)) console.log(`  ${k.padEnd(9)} ${w.address}`);

    step("USD token: issuer flags (DefaultRipple, AllowTrustLineLocking), trust lines, mint");
    show(await setupToken(ctx, [{ wallet: patient, amount: 1000 }]));
    for (const w of [donor, stranger]) {
      await submitTx(ctx, { TransactionType: "TrustSet", Account: w.address, LimitAmount: { currency: USD, issuer: issuer.address, value: "1000000000" } }, w);
      await submitTx(ctx, { TransactionType: "Payment", Account: issuer.address, Destination: w.address, Amount: usd(issuer.address, 20000) }, issuer);
    }
    console.log(`  donor     ${donor.address}\n  stranger  ${stranger.address}  (both hold 20000 USD)`);

    const caseId = `live-${Date.now()}`;
    step("hardship credential: clinic social worker issues FinancialHardship, patient accepts");
    show(await issueHardshipCredential(caseId, ctx));

    step("community fund: donor-only Permissioned Domain -> VerifiedDonor credential -> PRIVATE closed vault -> donation -> loan broker");
    const investAfterSec = 30;
    const f = await createCommunityFund(ctx, { owner: issuer, donor, donation: 10000, investAfterSec, termYears: 6 });
    show(f.receipts);
    console.log(`  domain ${f.domainId}\n  vault  ${f.vaultId}\n  broker ${f.loanBrokerId}`);

    step("ledger-enforced gate: a depositor WITHOUT the VerifiedDonor credential must be rejected");
    const gate = await client.submitAndWait(
      { TransactionType: "VaultDeposit", Account: stranger.address, VaultID: f.vaultId, Amount: usd(issuer.address, 100) },
      { wallet: stranger, autofill: true },
    );
    const gateResult = (gate.result.meta as { TransactionResult?: string })?.TransactionResult;
    console.log(`  stranger deposit -> ${gateResult}  ${ctx.network.includes("devnet") ? "https://devnet.xrpl.org/transactions/" : ""}${gate.result.hash}`);
    if (gateResult !== "tecNO_AUTH") throw new Error(`expected tecNO_AUTH for a non-credentialed depositor, got ${gateResult}`);
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
