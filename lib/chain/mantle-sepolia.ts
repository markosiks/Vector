import { defineChain } from 'viem';

/**
 * Mantle Sepolia testnet chain definition for viem.
 *
 * If viem's built-in `chains` package exports `mantleSepoliaTestnet` in the
 * installed version, prefer that import. This file is the fallback that keeps
 * the project working even when the viem release predates the chain definition.
 *
 * Source: https://chainlist.org/chain/5003 + Mantle docs.
 */
export const mantleSepolia = defineChain({
  id: 5003,
  name: 'Mantle Sepolia Testnet',
  nativeCurrency: {
    name: 'MNT',
    symbol: 'MNT',
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ['https://rpc.sepolia.mantle.xyz'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Mantle Sepolia Explorer',
      url: 'https://explorer.sepolia.mantle.xyz',
    },
  },
  testnet: true,
});
