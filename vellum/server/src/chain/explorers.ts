export const explorer = {
  xrplDevnet: (tx: string) => `https://devnet.xrpl.org/transactions/${tx}`,
  xrplTestnet: (tx: string) => `https://testnet.xrpl.org/transactions/${tx}`,
  bscTestnet: (tx: string) => `https://testnet.bscscan.com/tx/${tx}`,
  baseSepolia: (tx: string) => `https://sepolia.basescan.org/tx/${tx}`,
};
