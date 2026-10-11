// Generate EVM keys for any BLANK wallet vars in server/.env, append/fill them, print addresses + faucet links.
//   npx tsx scripts/gen-wallets.ts
// Never overwrites an existing key. Testnet use only.
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

if (process.argv.includes("--help")) {
  console.log("usage: npx tsx scripts/gen-wallets.ts\n  fills blank BSC_PRIVATE_KEY, AGENT_EVM_PRIVATE_KEY, PAYEE_EVM_PRIVATE_KEY, PATIENT_EVM_PRIVATE_KEY in server/.env");
  process.exit(0);
}

const ENV = fileURLToPath(new URL("../.env", import.meta.url));
const WALLETS: { name: string; role: string; fund: string }[] = [
  { name: "BSC_PRIVATE_KEY", role: "BSC testnet server/agent key (deploys + writes AdvocateLedger)", fund: "tBNB: https://www.bnbchain.org/en/testnet-faucet" },
  { name: "AGENT_EVM_PRIVATE_KEY", role: "Base Sepolia agent wallet that PAYS x402 calls in AUSD", fund: "AUSD on Base Sepolia (Agora testnet faucet); no gas needed" },
  { name: "PAYEE_EVM_PRIVATE_KEY", role: "Base Sepolia server wallet that RECEIVES x402 + submits transferWithAuthorization", fund: "Base Sepolia ETH: https://docs.base.org/base-chain/tools/network-faucets" },
  { name: "PATIENT_EVM_PRIVATE_KEY", role: "patient's key: signs the EIP-712 mandate off-chain (needs no gas)", fund: "none needed" },
];

let env = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";
const addrOf = (k: string) => privateKeyToAccount((k.startsWith("0x") ? k : `0x${k}`) as Hex).address;
for (const w of WALLETS) {
  const re = new RegExp(`^${w.name}=(.*)$`, "m");
  const cur = env.match(re)?.[1]?.trim();
  if (cur) {
    console.log(`${w.name} already set -> ${addrOf(cur)}  (${w.role})`);
    continue;
  }
  const key = generatePrivateKey();
  env = re.test(env) ? env.replace(re, `${w.name}=${key}`) : `${env}${env && !env.endsWith("\n") ? "\n" : ""}${w.name}=${key}\n`;
  console.log(`${w.name} generated -> ${addrOf(key)}  (${w.role})\n    fund with: ${w.fund}`);
}
writeFileSync(ENV, env);
console.log(`\nwrote ${ENV} (gitignored — never commit it)`);
