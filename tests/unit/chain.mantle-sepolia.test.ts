import { describe, expect, test } from 'bun:test';

import { mantleSepolia } from '@/lib/chain/mantle-sepolia';

describe('mantleSepolia chain definition', () => {
  test('has chain id 5003', () => {
    expect(mantleSepolia.id).toBe(5003);
  });

  test('is marked as testnet', () => {
    expect(mantleSepolia.testnet).toBe(true);
  });

  test('native currency is MNT with 18 decimals', () => {
    expect(mantleSepolia.nativeCurrency.symbol).toBe('MNT');
    expect(mantleSepolia.nativeCurrency.decimals).toBe(18);
  });

  test('has a default RPC URL', () => {
    expect(mantleSepolia.rpcUrls.default.http.length).toBeGreaterThan(0);
    expect(mantleSepolia.rpcUrls.default.http[0]).toMatch(/^https?:\/\//);
  });

  test('has a block explorer', () => {
    expect(mantleSepolia.blockExplorers?.default.url).toMatch(/^https?:\/\//);
    expect(mantleSepolia.blockExplorers?.default.url).toContain('sepolia.mantle');
  });
});
