import { describe, expect, test } from 'bun:test';

import { OperatorKeyError, operatorAddress, parseOperatorKey } from '@/lib/chain/operator.schema';

/** A well-formed throwaway test key (anvil account #0). Never custodies value. */
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

describe('parseOperatorKey', () => {
  test('accepts and lowercases a valid 32-byte hex key', () => {
    expect(parseOperatorKey(TEST_KEY.toUpperCase().replace('0X', '0x'))).toBe(TEST_KEY);
  });

  test('trims surrounding whitespace', () => {
    expect(parseOperatorKey(`  ${TEST_KEY}\n`)).toBe(TEST_KEY);
  });

  for (const [label, bad] of [
    ['undefined', undefined],
    ['empty', ''],
    ['no 0x prefix', TEST_KEY.slice(2)],
    ['too short', '0x1234'],
    ['too long', `${TEST_KEY}ab`],
    ['non-hex', `0x${'z'.repeat(64)}`],
  ] as const) {
    test(`rejects ${label} with a typed, value-free error`, () => {
      try {
        parseOperatorKey(bad);
        throw new Error('expected parseOperatorKey to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(OperatorKeyError);
        // The offending value must never appear in the message.
        if (typeof bad === 'string' && bad.length > 4) {
          expect((err as Error).message).not.toContain(bad);
        }
      }
    });
  }
});

describe('operatorAddress', () => {
  test('derives the expected address deterministically', () => {
    expect(operatorAddress(parseOperatorKey(TEST_KEY))).toBe(TEST_ADDR);
  });
});
