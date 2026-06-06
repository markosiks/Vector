import { describe, expect, test } from 'bun:test';

import {
  intentJsonSchema,
  signedIntentSchema,
  unsignedIntentJsonSchema,
  unsignedIntentSchema,
} from '@/lib/intent/schema';
import { validCloseInput, validOpenInput } from '@/tests/fixtures/intent-fixtures';

const VALID_SIG = `0x${'ab'.repeat(65)}`;

describe('unsignedIntentSchema — happy path', () => {
  test('accepts a valid open intent and normalizes numerics/timestamps', () => {
    const r = unsignedIntentSchema.parse(
      validOpenInput({
        size: 1000,
        leverage: 3,
        max_slippage: 0.01,
        nonce: 7,
        ttl: '2030-01-01T00:00:00Z',
      }),
    );
    expect(r).toMatchObject({
      size: '1000',
      leverage: '3',
      nonce: '7',
      ttl: '2030-01-01T00:00:00.000Z',
    });
  });
});

describe('unsignedIntentSchema — required & typed fields', () => {
  test('rejects missing required fields per action', () => {
    for (const field of ['market', 'side', 'size', 'agent_id', 'nonce', 'ttl']) {
      const obj = validOpenInput() as Record<string, unknown>;
      delete obj[field];
      expect(unsignedIntentSchema.safeParse(obj).success).toBe(false);
    }
  });

  test('rejects unknown / extra fields (strict)', () => {
    expect(unsignedIntentSchema.safeParse({ ...validOpenInput(), extra: 1 }).success).toBe(false);
  });

  test('rejects an unknown action', () => {
    expect(
      unsignedIntentSchema.safeParse({ ...validOpenInput(), action: 'withdraw' }).success,
    ).toBe(false);
  });

  test('rejects non-string market and bad side enum', () => {
    expect(unsignedIntentSchema.safeParse({ ...validOpenInput(), market: 123 }).success).toBe(
      false,
    );
    expect(unsignedIntentSchema.safeParse({ ...validOpenInput(), side: 'sideways' }).success).toBe(
      false,
    );
  });

  test('rejects NaN / Infinity / non-decimal numerics at the schema layer', () => {
    for (const size of [NaN, Infinity, 'abc', '1,000']) {
      expect(unsignedIntentSchema.safeParse({ ...validOpenInput(), size }).success).toBe(false);
    }
  });

  test('accepts a negative size at the schema layer (range is a later bounds step)', () => {
    expect(unsignedIntentSchema.safeParse(validOpenInput({ size: -5 })).success).toBe(true);
  });
});

describe('unsignedIntentSchema — conditional obligation', () => {
  test('close forbids side and leverage (not in its shape)', () => {
    expect(unsignedIntentSchema.safeParse({ ...validCloseInput(), side: 'long' }).success).toBe(
      false,
    );
    expect(unsignedIntentSchema.safeParse({ ...validCloseInput(), leverage: 3 }).success).toBe(
      false,
    );
  });

  test('open requires side and leverage', () => {
    const close = validCloseInput();
    // A "close-shaped" payload mislabeled as open is missing side/leverage.
    expect(unsignedIntentSchema.safeParse({ ...close, action: 'open' }).success).toBe(false);
  });

  test('transfer requires only base + size; market/side/leverage are not allowed', () => {
    expect(
      unsignedIntentSchema.safeParse({
        action: 'transfer',
        agent_id: 'a',
        size: 10,
        target_address: '0xabc',
        nonce: '1',
        ttl: '2030-01-01T00:00:00Z',
      }).success,
    ).toBe(true);
    expect(
      unsignedIntentSchema.safeParse({
        action: 'transfer',
        agent_id: 'a',
        size: 10,
        market: 'BTC-PERP',
        nonce: '1',
        ttl: '2030-01-01T00:00:00Z',
      }).success,
    ).toBe(false);
  });

  test('target_address is structurally allowed on non-transfer (the policy step owns it)', () => {
    // Schema does not reject it; validateIntent does. This keeps the ordered
    // checks observable.
    expect(
      unsignedIntentSchema.safeParse(validOpenInput({ target_address: '0xabc' })).success,
    ).toBe(true);
  });
});

describe('signedIntentSchema', () => {
  test('requires a well-formed 65-byte hex signature', () => {
    expect(
      signedIntentSchema.safeParse({ ...validOpenInput(), signature: VALID_SIG }).success,
    ).toBe(true);
    expect(signedIntentSchema.safeParse({ ...validOpenInput(), signature: '0x1234' }).success).toBe(
      false,
    );
    expect(signedIntentSchema.safeParse({ ...validOpenInput(), signature: 'nope' }).success).toBe(
      false,
    );
    expect(signedIntentSchema.safeParse(validOpenInput()).success).toBe(false); // missing signature
  });
});

describe('JSON Schema export', () => {
  test('produces named JSON Schemas for external conformance', () => {
    expect(intentJsonSchema).toBeTruthy();
    expect(unsignedIntentJsonSchema).toBeTruthy();
    expect(JSON.stringify(intentJsonSchema)).toContain('Intent');
  });
});
