import { defineChain, type Chain } from 'viem';

import { CONFIG } from '../config/constants';

/**
 * The viem {@link Chain} definition for Mantle Sepolia testnet.
 *
 * Built from the seeded {@link CONFIG} single source (chain id + explorer base),
 * so the network identity used by every client is derived from the same place
 * as the registry addresses — never a second hardcoded literal. This module is
 * pure and secret-free (no RPC URL, no key): the RPC endpoint is supplied per
 * client from the server-only env, so this can be imported anywhere and unit
 * tested directly.
 *
 * The embedded `rpcUrls.default` is the public Mantle endpoint and exists only
 * as a viem-API formality (a `Chain` requires one); production clients always
 * pass an explicit transport built from `MANTLE_TESTNET_RPC_URL`.
 */
export const mantleSepolia: Chain = defineChain({
  id: CONFIG.chain.mantle_testnet_chain_id,
  name: 'Mantle Sepolia Testnet',
  nativeCurrency: { name: 'Mantle', symbol: 'MNT', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.sepolia.mantle.xyz'] },
  },
  blockExplorers: {
    default: { name: 'Mantle Sepolia Explorer', url: CONFIG.chain.mantle_explorer_base_url },
  },
  testnet: true,
});
