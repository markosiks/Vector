import { describe, expect, test } from 'bun:test';

import {
  TESTNET_REPUTATION_REGISTRY,
  TESTNET_IDENTITY_REGISTRY,
  TESTNET_VALIDATION_REGISTRY,
  MAINNET_REPUTATION_REGISTRY,
  MAINNET_IDENTITY_REGISTRY,
  MANTLE_SEPOLIA_REPUTATION_DEPLOY_BLOCK,
} from '@/lib/chain/addresses';

describe('ERC-8004 addresses', () => {
  test('testnet addresses are valid 0x-prefixed 42-char hex', () => {
    const re = /^0x[0-9a-fA-F]{40}$/;
    expect(TESTNET_REPUTATION_REGISTRY).toMatch(re);
    expect(TESTNET_IDENTITY_REGISTRY).toMatch(re);
    expect(TESTNET_VALIDATION_REGISTRY).toMatch(re);
  });

  test('mainnet addresses are valid 0x-prefixed 42-char hex', () => {
    const re = /^0x[0-9a-fA-F]{40}$/;
    expect(MAINNET_REPUTATION_REGISTRY).toMatch(re);
    expect(MAINNET_IDENTITY_REGISTRY).toMatch(re);
  });

  test('testnet and mainnet addresses are different', () => {
    expect(TESTNET_REPUTATION_REGISTRY).not.toBe(MAINNET_REPUTATION_REGISTRY);
    expect(TESTNET_IDENTITY_REGISTRY).not.toBe(MAINNET_IDENTITY_REGISTRY);
  });

  test('testnet addresses start with 0x8004 vanity prefix', () => {
    expect(TESTNET_REPUTATION_REGISTRY.toLowerCase()).toMatch(/^0x8004/);
    expect(TESTNET_IDENTITY_REGISTRY.toLowerCase()).toMatch(/^0x8004/);
    expect(TESTNET_VALIDATION_REGISTRY.toLowerCase()).toMatch(/^0x8004/);
  });

  test('deploy block is a positive bigint', () => {
    expect(MANTLE_SEPOLIA_REPUTATION_DEPLOY_BLOCK).toBeGreaterThan(0n);
    expect(typeof MANTLE_SEPOLIA_REPUTATION_DEPLOY_BLOCK).toBe('bigint');
  });

  test('deploy block matches known Mantle Sepolia value', () => {
    expect(MANTLE_SEPOLIA_REPUTATION_DEPLOY_BLOCK).toBe(34_586_937n);
  });
});
