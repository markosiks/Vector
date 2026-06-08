import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import { configSchema, erc8004Schema } from '@/lib/config/constants.schema';
import {
  explorerAddressUrl,
  reputationRegistryAddress,
  identityRegistryAddress,
  reputationDeployBlock,
} from '@/lib/config/derive';

describe('CONFIG.erc8004', () => {
  test('exists in the validated config', () => {
    expect(CONFIG.erc8004).toBeDefined();
  });

  test('reputation_registry is a valid Ethereum address', () => {
    expect(CONFIG.erc8004.reputation_registry).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  test('identity_registry is a valid Ethereum address', () => {
    expect(CONFIG.erc8004.identity_registry).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  test('reputation_deploy_block is a positive integer', () => {
    expect(CONFIG.erc8004.reputation_deploy_block).toBeGreaterThan(0);
    expect(Number.isInteger(CONFIG.erc8004.reputation_deploy_block)).toBe(true);
  });

  test('addresses match canonical testnet values', () => {
    expect(CONFIG.erc8004.reputation_registry).toBe(
      '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    );
    expect(CONFIG.erc8004.identity_registry).toBe(
      '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    );
  });
});

describe('erc8004Schema validation', () => {
  test('accepts valid config', () => {
    const valid = {
      reputation_registry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
      identity_registry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      reputation_deploy_block: 34_586_937,
    };
    expect(() => erc8004Schema.parse(valid)).not.toThrow();
  });

  test('rejects non-0x address', () => {
    expect(() =>
      erc8004Schema.parse({
        reputation_registry: 'not-an-address',
        identity_registry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        reputation_deploy_block: 1,
      }),
    ).toThrow();
  });

  test('rejects address with wrong length', () => {
    expect(() =>
      erc8004Schema.parse({
        reputation_registry: '0x1234', // too short
        identity_registry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        reputation_deploy_block: 1,
      }),
    ).toThrow();
  });

  test('rejects zero deploy block', () => {
    expect(() =>
      erc8004Schema.parse({
        reputation_registry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
        identity_registry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        reputation_deploy_block: 0,
      }),
    ).toThrow();
  });

  test('rejects negative deploy block', () => {
    expect(() =>
      erc8004Schema.parse({
        reputation_registry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
        identity_registry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        reputation_deploy_block: -1,
      }),
    ).toThrow();
  });

  test('rejects missing fields', () => {
    expect(() => erc8004Schema.parse({})).toThrow();
    expect(() =>
      erc8004Schema.parse({
        reputation_registry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
      }),
    ).toThrow();
  });
});

describe('configSchema includes erc8004', () => {
  test('full config validates with erc8004 section', () => {
    // If CONFIG parsed OK at import time, this is redundant but explicit.
    expect(() => configSchema.parse(CONFIG)).not.toThrow();
  });
});

describe('derive helpers for erc8004', () => {
  test('reputationRegistryAddress matches CONFIG', () => {
    expect(reputationRegistryAddress()).toBe(CONFIG.erc8004.reputation_registry);
  });

  test('identityRegistryAddress matches CONFIG', () => {
    expect(identityRegistryAddress()).toBe(CONFIG.erc8004.identity_registry);
  });

  test('reputationDeployBlock matches CONFIG', () => {
    expect(reputationDeployBlock()).toBe(CONFIG.erc8004.reputation_deploy_block);
  });

  test('explorerAddressUrl builds correct URL', () => {
    const url = explorerAddressUrl('0xdeadbeef');
    expect(url).toBe('https://explorer.sepolia.mantle.xyz/address/0xdeadbeef');
  });
});
