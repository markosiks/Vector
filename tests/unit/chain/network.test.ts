import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import { mantleSepolia } from '@/lib/chain/network';

/**
 * The chain definition must be derived from the seeded config single source, not
 * a second hardcoded literal, and must carry no secret.
 */
describe('mantleSepolia chain definition', () => {
  test('chain id comes from CONFIG', () => {
    expect(mantleSepolia.id).toBe(CONFIG.chain.mantle_testnet_chain_id);
    expect(mantleSepolia.id).toBe(5003);
  });

  test('explorer url comes from CONFIG', () => {
    expect(mantleSepolia.blockExplorers?.default.url).toBe(CONFIG.chain.mantle_explorer_base_url);
  });

  test('is flagged as a testnet with MNT as native currency', () => {
    expect(mantleSepolia.testnet).toBe(true);
    expect(mantleSepolia.nativeCurrency.symbol).toBe('MNT');
    expect(mantleSepolia.nativeCurrency.decimals).toBe(18);
  });
});
