// Compile contracts/AdvocateLedger.sol with the installed solc and deploy it to BSC testnet (chainId 97).
//   npx tsx scripts/deploy-ledger.ts [--dry]     (--dry: compile only, print sizes)
// Needs BSC_PRIVATE_KEY (funded with tBNB: https://www.bnbchain.org/en/testnet-faucet). Writes ADVOCATE_LEDGER_ADDRESS to .env.
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { config } from "dotenv";
import { createPublicClient, createWalletClient, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

const ENV = fileURLToPath(new URL("../.env", import.meta.url));
config({ path: ENV });
const { compileLedger, bscKey, DEFAULT_BSC_RPC, BSC_CHAIN_ID } = await import("../src/chain/bnb.js");
const { explorer } = await import("../src/chain/explorers.js");

if (process.argv.includes("--help")) {
  console.log("usage: npx tsx scripts/deploy-ledger.ts [--dry]\n  compiles AdvocateLedger.sol (solc npm) and deploys to BSC testnet; writes ADVOCATE_LEDGER_ADDRESS to server/.env");
  process.exit(0);
}

const c = compileLedger();
console.log(`compiled with solc ${c.solcVersion}: initcode ${(c.bytecode.length - 2) / 2} B, runtime ${(c.deployedBytecode.length - 2) / 2} B`);
if (process.argv.includes("--dry")) process.exit(0);

const account = privateKeyToAccount(bscKey());
const transport = http(process.env.BSC_RPC_URL || DEFAULT_BSC_RPC);
const pub = createPublicClient({ chain: bscTestnet, transport });
const wallet = createWalletClient({ chain: bscTestnet, transport, account });
const chainId = await pub.getChainId();
if (chainId !== BSC_CHAIN_ID) throw new Error(`RPC is chainId ${chainId}, expected BSC testnet ${BSC_CHAIN_ID} — refusing (testnet only)`);
const bal = await pub.getBalance({ address: account.address });
console.log(`deployer ${account.address} balance ${formatEther(bal)} tBNB`);
if (bal === 0n) throw new Error(`deployer has no tBNB — fund ${account.address} at https://www.bnbchain.org/en/testnet-faucet`);

const hash = await wallet.deployContract({ abi: c.abi, bytecode: c.bytecode });
console.log(`deploy tx ${explorer.bscTestnet(hash)}`);
const rcpt = await pub.waitForTransactionReceipt({ hash });
if (rcpt.status !== "success" || !rcpt.contractAddress) throw new Error(`deploy failed: ${hash}`);
const addr = rcpt.contractAddress;
console.log(`AdvocateLedger deployed at ${addr}  https://testnet.bscscan.com/address/${addr}`);

let env = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";
env = /^ADVOCATE_LEDGER_ADDRESS=.*$/m.test(env)
  ? env.replace(/^ADVOCATE_LEDGER_ADDRESS=.*$/m, `ADVOCATE_LEDGER_ADDRESS=${addr}`)
  : `${env}${env.endsWith("\n") || !env ? "" : "\n"}ADVOCATE_LEDGER_ADDRESS=${addr}\n`;
writeFileSync(ENV, env);
console.log(`wrote ADVOCATE_LEDGER_ADDRESS to ${ENV}`);
