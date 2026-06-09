import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import {
  explorerAddressUrl,
  explorerBlockUrl,
  explorerTxUrl,
  isValidAddress,
  isValidBlockNumber,
  isValidTxHash,
} from '@/lib/credibility/explorer';

/**
 * Explorer links are built from the seeded `CONFIG.chain` base and from
 * untrusted DTO fields. The invariant: a well-formed hash/block/address yields a
 * correct URL on the configured network; anything malformed yields `null` so the
 * UI renders plain text instead of a broken or attacker-controlled link.
 */

const TX = `0x${'a'.repeat(64)}`;
const ADDR = `0x${'b'.repeat(40)}`;
const BASE = CONFIG.chain.mantle_explorer_base_url;

describe('validators', () => {
  test('accept well-formed values', () => {
    expect(isValidTxHash(TX)).toBe(true);
    expect(isValidAddress(ADDR)).toBe(true);
    expect(isValidBlockNumber('0')).toBe(true);
    expect(isValidBlockNumber('12345678')).toBe(true);
  });

  test('reject malformed / wrong-length / wrong-type values', () => {
    expect(isValidTxHash(null)).toBe(false);
    expect(isValidTxHash(undefined)).toBe(false);
    expect(isValidTxHash('0x123')).toBe(false); // too short
    expect(isValidTxHash(`0x${'a'.repeat(63)}g`)).toBe(false); // non-hex
    expect(isValidTxHash(TX.slice(2))).toBe(false); // missing 0x
    expect(isValidAddress(TX)).toBe(false); // 32 bytes, not 20
    expect(isValidBlockNumber('-1')).toBe(false);
    expect(isValidBlockNumber('1.0')).toBe(false);
    expect(isValidBlockNumber('0x10')).toBe(false);
    expect(isValidBlockNumber(null)).toBe(false);
  });
});

describe('url builders', () => {
  test('build the right path on the configured explorer', () => {
    expect(explorerTxUrl(TX)).toBe(`${BASE}/tx/${TX}`);
    expect(explorerBlockUrl('42')).toBe(`${BASE}/block/42`);
    expect(explorerAddressUrl(ADDR)).toBe(`${BASE}/address/${ADDR}`);
  });

  test('return null for invalid inputs (link never breaks the UI)', () => {
    expect(explorerTxUrl(null)).toBeNull();
    expect(explorerTxUrl('not-a-hash')).toBeNull();
    expect(explorerBlockUrl(null)).toBeNull();
    expect(explorerBlockUrl('abc')).toBeNull();
    expect(explorerAddressUrl('0xshort')).toBeNull();
  });

  test('normalize a base that carries a trailing slash (no double slash)', () => {
    expect(explorerTxUrl(TX, 'https://x.test/')).toBe(`https://x.test/tx/${TX}`);
    expect(explorerTxUrl(TX, 'https://x.test///')).toBe(`https://x.test/tx/${TX}`);
  });
});
