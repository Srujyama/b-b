// Live proof for the community-fund DASHBOARD read path (GET /api/fund, /api/fund/donors) on XRPL DEVNET,
// with fresh faucet wallets so the shared .env fund is never touched:
//   broker creates a private closed vault -> vetted donor deposits -> borrower draws a 0% loan -> repays one
//   installment -> fundState()/fundDonors() must report exactly that, read back from the validated ledger.
// Exits non-zero if the dashboard view disagrees with what just happened on-ledger.
//   npx tsx scripts/live-fund.ts
import { Client, Wallet } from "xrpl";
import { assertTestNetwork, DEVNET_URL, issueHardshipCredential, setupToken, submitTx, usd, USD, type XrplCtx } from "../src/chain/xrpl.js";
import { createCommunityFund, fundDonors, fundState, openZeroInterestLoan, payInstallment } from "../src/chain/xrplFund.js";

const network = assertTestNetwork(process.env.XRPL_LIVE_NETWORK || DEVNET_URL);
const step = (s: string) => console.log(`\n▶ ${s}`);
function check(cond: unknown, msg: string) {
  if (!cond) throw new Error(`dashboard view mismatch: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main() {
  const client = new Client(network);
  await client.connect();
  try {
    step(`funding 6 fresh faucet wallets on ${network}`);
    const fund = async () => (await client.fundWallet(null)).wallet as Wallet;
    const [issuer, patient, hospital, clinic, advocate, donor] = await Promise.all([fund(), fund(), fund(), fund(), fund(), fund()]);
    const ctx: XrplCtx = { client, network, actors: { issuer, patient, hospital, clinic, advocate } };
    await setupToken(ctx, [{ wallet: patient, amount: 500 }]);
    await submitTx(ctx, { TransactionType: "TrustSet", Account: donor.address, LimitAmount: { currency: USD, issuer: issuer.address, value: "1000000000" } }, donor);
    await submitTx(ctx, { TransactionType: "Payment", Account: issuer.address, Destination: donor.address, Amount: usd(issuer.address, 5000) }, issuer);
    const caseId = `livefund-${Date.now()}`;
    await issueHardshipCredential(caseId, ctx);

    step("broker creates the fund; vetted donor deposits 5000 USD");
    const investAfterSec = 30;
    const f = await createCommunityFund(ctx, { owner: issuer, donor, donation: 5000, investAfterSec, termYears: 6 });
    for (const r of f.receipts) console.log(`  ${r.kind.padEnd(22)} ${r.explorerUrl}`);
    console.log(`  XRPL_VAULT_ID=${f.vaultId}\n  XRPL_LOAN_BROKER_ID=${f.loanBrokerId}\n  XRPL_DONOR_DOMAIN_ID=${f.domainId}`);
    await new Promise((r) => setTimeout(r, (investAfterSec + 15) * 1000));

    step("borrower draws a 0% loan of 1200 USD over 12 months, then repays one installment");
    const loan = await openZeroInterestLoan(caseId, 1200, 12, ctx, f);
    console.log(`  LoanSet  ${loan.receipts[0].explorerUrl}`);
    const pay = await payInstallment(ctx, loan.loanId);
    console.log(`  LoanPay  ${pay.explorerUrl}  (${pay.detail?.amount} USD)`);

    step("read it back the way the dashboard does");
    const s = await fundState(ctx, f);
    const d = await fundDonors(ctx, f);
    const l = s.loans[0];
    console.log(JSON.stringify({ vault: { total: s.vault.assetsTotal, available: s.vault.assetsAvailable, lent: s.vault.assetsLent, phase: s.vault.phase, private: s.vault.private, domainId: s.vault.domainId }, loan: l, donors: d.donors.map((x) => ({ address: x.address, shares: x.shares, claimUsd: x.claimUsd, deposits: x.deposits.length })) }, null, 2));
    check(s.vault.private && s.vault.domainId === f.domainId, "vault is private and bound to the donor domain");
    check(s.vault.phase === "investment" && !s.vault.depositsOpen, "subscription window closed, deposits closed");
    check(s.loans.length === 1 && l.id === loan.loanId, "one loan, id matches LoanSet");
    check(l.borrower === patient.address && l.caseId === caseId, "borrower + case id decoded from the LoanSet memo");
    check(l.principalRequested === 1200 && l.paymentTotal === 12, "principal 1200 over 12 payments (from LoanSet)");
    check(l.paymentsMade === 1 && l.paymentRemaining === 11 && l.payments.length === 1, "1 payment made, 11 remaining");
    check(Boolean(l.nextPaymentDue), "next due date present");
    check(d.donors.length === 1 && d.donors[0].address === donor.address && d.donors[0].deposits.length === 1, "the one vetted donor and their deposit");
    console.log("\nDASHBOARD READ PATH MATCHES THE LEDGER");
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  console.error("\n✗ live-fund FAILED:", e?.data ?? e?.message ?? e);
  process.exit(1);
});
