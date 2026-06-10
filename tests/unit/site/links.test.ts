import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import {
  DEFAULT_MERIT_REGISTRY_ADDRESS,
  GITHUB_REPO_URL,
  meritRegistryExplorerUrl,
} from '@/lib/site/links';
import { isActivePath } from '@/lib/site/nav';

/**
 * Site chrome links. Invariants: the contract link always lands on the seeded
 * explorer origin with a valid 20-byte address — a malformed env override
 * degrades to the known-good default, never to a broken or attacker-controlled
 * href — and nav active-state matches exact routes and sub-routes only.
 */

const BASE = CONFIG.chain.mantle_explorer_base_url;

describe('GITHUB_REPO_URL', () => {
  test('is a well-formed https GitHub URL', () => {
    const url = new URL(GITHUB_REPO_URL);
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('github.com');
  });
});

describe('meritRegistryExplorerUrl', () => {
  test('uses a valid explicit address', () => {
    const addr = `0x${'c'.repeat(40)}`;
    expect(meritRegistryExplorerUrl(addr)).toBe(`${BASE}/address/${addr}`);
  });

  test('falls back to the default for a malformed address', () => {
    expect(meritRegistryExplorerUrl('not-an-address')).toBe(
      `${BASE}/address/${DEFAULT_MERIT_REGISTRY_ADDRESS}`,
    );
    expect(meritRegistryExplorerUrl('0xshort')).toBe(
      `${BASE}/address/${DEFAULT_MERIT_REGISTRY_ADDRESS}`,
    );
  });

  test('default address is itself a valid 20-byte address', () => {
    expect(DEFAULT_MERIT_REGISTRY_ADDRESS).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe('isActivePath', () => {
  test('matches the exact route', () => {
    expect(isActivePath('/arena', '/arena')).toBe(true);
  });

  test('matches sub-routes', () => {
    expect(isActivePath('/agents/abc', '/agents')).toBe(true);
  });

  test('rejects unrelated and prefix-only routes', () => {
    expect(isActivePath('/attestations', '/arena')).toBe(false);
    expect(isActivePath('/arenas', '/arena')).toBe(false);
    expect(isActivePath('/', '/arena')).toBe(false);
  });
});
