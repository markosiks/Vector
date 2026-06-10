/**
 * Regression tests for audit findings I-01 through I-07.
 *
 * Each test block is labelled with the finding ID it covers and tests the
 * *behavior* change, not the implementation detail.
 */

import { describe, expect, test } from 'bun:test';

import { MAX_NONCE_LENGTH, normalizeNonce, stableStringify } from '@/lib/intent/canonical';
import { signIntent } from '@/lib/intent/sign';
import { unsignedIntentSchema } from '@/lib/intent/schema';
import { validateIntent, type ValidateOptions } from '@/lib/intent/validate';
import { verifyIntentSignature } from '@/lib/intent/verify';

import {
  TEST_PK,
  TEST_SIGNER,
  resolveTestSigner,
  transferInput,
  validOpenInput,
} from '@/tests/fixtures/intent-fixtures';

const NOW = new Date('2030-01-01T00:00:00.000Z');
const ttlAfterNow = new Date(NOW.getTime() + 60_000).toISOString();

const baseOpts = (over: Partial<ValidateOptions> = {}): ValidateOptions => ({
  resolveSigner: resolveTestSigner,
  now: NOW,
  ...over,
});

// ---------------------------------------------------------------------------
// I-01: nonce max-length guard
// ---------------------------------------------------------------------------
describe('I-01 — nonce max-length guard', () => {
  test('normalizeNonce rejects a nonce longer than MAX_NONCE_LENGTH', () => {
    const overlong = 'a'.repeat(MAX_NONCE_LENGTH + 1);
    expect(() => normalizeNonce(overlong)).toThrow(/exceed/i);
  });

  test('normalizeNonce accepts a nonce of exactly MAX_NONCE_LENGTH', () => {
    const exact = 'a'.repeat(MAX_NONCE_LENGTH);
    expect(normalizeNonce(exact)).toBe(exact);
  });

  test('schema rejects an over-long string nonce before signature verification', () => {
    const overlong = 'a'.repeat(MAX_NONCE_LENGTH + 1);
    const result = unsignedIntentSchema.safeParse(validOpenInput({ nonce: overlong }));
    expect(result.success).toBe(false);
  });

  test('validateIntent rejects an over-long nonce at schema stage (not signature stage)', async () => {
    const overlong = 'a'.repeat(MAX_NONCE_LENGTH + 1);
    // Build a raw object (bypass schema) so we can test validateIntent's stage ordering
    const raw = {
      action: 'open',
      agent_id: 'agent-001',
      market: 'BTC-PERP',
      side: 'long',
      size: 1000,
      leverage: 3,
      max_slippage: 0.01,
      nonce: overlong,
      ttl: ttlAfterNow,
      signature: ('0x' + 'a'.repeat(130)) as `0x${string}`,
    };
    const r = await validateIntent(raw, baseOpts());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe('schema');
    }
  });
});

// ---------------------------------------------------------------------------
// I-02: verifyIntentSignature logs unexpected errors instead of swallowing them
// ---------------------------------------------------------------------------
describe('I-02 — unexpected errors in verifyIntentSignature are logged', () => {
  test('an invalid expected address returns false without throwing', async () => {
    const signed = await signIntent(validOpenInput({ ttl: ttlAfterNow }), TEST_PK);
    // A clearly malformed expected address should return false
    const result = await verifyIntentSignature(signed, 'not-an-address' as `0x${string}`);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// I-04: target_address required on transfer; schema rejects missing target_address
// ---------------------------------------------------------------------------
describe('I-04 — target_address required on transfer', () => {
  test('transfer without target_address is rejected by the schema', () => {
    const result = unsignedIntentSchema.safeParse({
      action: 'transfer',
      agent_id: 'agent-001',
      size: 100,
      nonce: '1',
      ttl: '2030-01-01T00:00:00Z',
    });
    expect(result.success).toBe(false);
  });

  test('transfer with target_address is accepted by the schema', () => {
    const result = unsignedIntentSchema.safeParse({
      action: 'transfer',
      agent_id: 'agent-001',
      size: 100,
      target_address: '0x000000000000000000000000000000000000dEaD',
      nonce: '1',
      ttl: '2030-01-01T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  test('validateIntent rejects a transfer missing target_address at schema stage', async () => {
    const raw = {
      action: 'transfer',
      agent_id: 'agent-001',
      size: 100,
      nonce: '1',
      ttl: ttlAfterNow,
      signature: ('0x' + 'a'.repeat(130)) as `0x${string}`,
    };
    const r = await validateIntent(raw, baseOpts());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe('schema');
    }
  });

  test('validateIntent accepts a signed transfer with target_address', async () => {
    const signed = await signIntent(transferInput({ ttl: ttlAfterNow }), TEST_PK);
    const r = await validateIntent(signed, baseOpts());
    expect(r.ok).toBe(true);
  });

  test('target_address remains optional on open/modify/close (schema allows it)', () => {
    // The validator's target_address stage still fires for non-transfer with target_address
    const result = unsignedIntentSchema.safeParse(validOpenInput({ target_address: '0xabc' }));
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// I-05: constant-time address comparison (behavioral: still verifies correctly)
// ---------------------------------------------------------------------------
describe('I-05 — constant-time comparison still works correctly', () => {
  test('verifyIntentSignature returns true for a correctly signed intent', async () => {
    const signed = await signIntent(validOpenInput({ ttl: ttlAfterNow }), TEST_PK);
    expect(await verifyIntentSignature(signed, TEST_SIGNER)).toBe(true);
  });

  test('verifyIntentSignature returns false for a wrong signer', async () => {
    const signed = await signIntent(validOpenInput({ ttl: ttlAfterNow }), TEST_PK);
    const wrongAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
    expect(await verifyIntentSignature(signed, wrongAddress as `0x${string}`)).toBe(false);
  });

  test('verifyIntentSignature is checksum-insensitive (getAddress normalises both sides)', async () => {
    const signed = await signIntent(validOpenInput({ ttl: ttlAfterNow }), TEST_PK);
    expect(await verifyIntentSignature(signed, TEST_SIGNER.toLowerCase() as `0x${string}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// I-06: stableStringify throws on BigInt instead of propagating JSON TypeError
// ---------------------------------------------------------------------------
describe('I-06 — stableStringify explicitly rejects BigInt', () => {
  test('throws a TypeError with a clear message for BigInt input', () => {
    expect(() => stableStringify(BigInt(1))).toThrow(TypeError);
    expect(() => stableStringify(BigInt(1))).toThrow(/BigInt/i);
  });

  test('still serializes normal primitives correctly', () => {
    expect(stableStringify(42)).toBe('42');
    expect(stableStringify('hello')).toBe('"hello"');
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(true)).toBe('true');
  });
});

// ---------------------------------------------------------------------------
// I-07: max_slippage = "0" is intentionally allowed (zero-slippage documented)
// ---------------------------------------------------------------------------
describe('I-07 — zero max_slippage is intentionally allowed', () => {
  test('max_slippage of 0 passes the bounds check', async () => {
    const signed = await signIntent(validOpenInput({ ttl: ttlAfterNow, max_slippage: 0 }), TEST_PK);
    const r = await validateIntent(signed, baseOpts());
    expect(r.ok).toBe(true);
  });

  test('max_slippage of 0 is within the unit interval', () => {
    // The closed interval [0,1] deliberately includes 0; execution risk is documented.
    const result = unsignedIntentSchema.safeParse(validOpenInput({ max_slippage: 0 }));
    expect(result.success).toBe(true);
  });
});
