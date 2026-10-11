// Real Base Sepolia x402 round trip with AUSD (testnet only).
//   npx tsx scripts/live-ausd.ts            # paywalled echo route: proves 402 -> sign -> settle on-chain
//   npx tsx scripts/live-ausd.ts --fair-price 99285   # also pays the real /x402/fair-price (needs research keys)
// Needs in .env: AGENT_EVM_PRIVATE_KEY (holds AUSD, no gas) + PAYEE_EVM_PRIVATE_KEY (holds Base Sepolia ETH).
import "dotenv/config";
import Fastify from "fastify";
import type { Hex } from "viem";
import { need } from "../src/env.js";
import { agentAccount, balanceOf, fromAtomic, payeeAccount, publicClient, BASE_SEPOLIA_CHAIN_ID } from "../src/chain/ausd.js";
import { paidFetch, requirePayment, settlePayment } from "../src/chain/x402.js";
import x402Routes from "../src/routes/x402.js";

need("AGENT_EVM_PRIVATE_KEY");
need("PAYEE_EVM_PRIVATE_KEY");
const chainId = await publicClient().getChainId();
if (chainId !== BASE_SEPOLIA_CHAIN_ID) throw new Error(`refusing to run: RPC chainId ${chainId} is not Base Sepolia (84532)`);

const agent = agentAccount().address;
const payee = payeeAccount().address;
const gas = await publicClient().getBalance({ address: payee });
console.log(`agent ${agent}  AUSD ${fromAtomic(await balanceOf(agent))}`);
console.log(`payee ${payee}  AUSD ${fromAtomic(await balanceOf(payee))}  ETH(wei) ${gas}`);
if (gas === 0n) throw new Error("payee has no Base Sepolia ETH for gas — fund PAYEE_EVM_PRIVATE_KEY's address from a faucet");

const app = Fastify();
await app.register(x402Routes);
app.get("/x402/ping", { preHandler: requirePayment("0.01", "live AUSD x402 proof") }, async (req, reply) => {
  const receipt = await settlePayment(req, reply);
  return { ok: true, receipt };
});
const base = await app.listen({ port: 0, host: "127.0.0.1" });

try {
  const { response, paid } = await paidFetch(`${base}/x402/ping`);
  console.log("status", response.status, JSON.stringify(paid));
  if (!paid?.success) throw new Error(`payment failed: ${await response.text()}`);
  console.log(`settled: https://sepolia.basescan.org/tx/${paid.transaction as Hex}`);

  const i = process.argv.indexOf("--fair-price");
  if (i > 0) {
    const code = process.argv[i + 1] ?? "99285";
    const r = await paidFetch(`${base}/x402/fair-price?code=${encodeURIComponent(code)}&description=ER%20visit`);
    console.log("fair-price", r.response.status, await r.response.text());
    if (r.paid?.success) console.log(`settled: https://sepolia.basescan.org/tx/${r.paid.transaction}`);
  }
  console.log(`agent AUSD now ${fromAtomic(await balanceOf(agent))}, payee AUSD now ${fromAtomic(await balanceOf(payee))}`);
} finally {
  await app.close();
}
