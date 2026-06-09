import { describe, expect, test } from 'bun:test';

import { AgentIdError, parseOnchainAgentId, tryOnchainAgentId } from '@/lib/chain/agent-id';

const UINT256_MAX = (1n << 256n) - 1n;

describe('parseOnchainAgentId', () => {
  test('accepts the canonical first-minted id (0) and a typical tokenId', () => {
    expect(parseOnchainAgentId('0')).toBe(0n);
    expect(parseOnchainAgentId('42')).toBe(42n);
  });

  test('accepts the uint256 boundary', () => {
    expect(parseOnchainAgentId(UINT256_MAX.toString())).toBe(UINT256_MAX);
  });

  test('trims surrounding whitespace', () => {
    expect(parseOnchainAgentId('  7\n')).toBe(7n);
  });

  // The whole point of the fix: an unregistered agent has no on-chain id, so the
  // write path must fail closed instead of inventing/reusing one.
  for (const [label, value] of [
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
  ] as const) {
    test(`rejects ${label} (not registered) with AgentIdError`, () => {
      expect(() => parseOnchainAgentId(value)).toThrow(AgentIdError);
    });
  }

  for (const [label, value] of [
    ['negative', '-1'],
    ['decimal', '1.5'],
    ['hex', '0x1'],
    ['non-numeric', 'abc'],
    ['over uint256', (UINT256_MAX + 1n).toString()],
  ] as const) {
    test(`rejects ${label} with AgentIdError`, () => {
      expect(() => parseOnchainAgentId(value)).toThrow(AgentIdError);
    });
  }
});

describe('tryOnchainAgentId', () => {
  test('returns the parsed id for a valid value', () => {
    expect(tryOnchainAgentId('9')).toBe(9n);
  });

  test('returns null for a not-yet-registered / malformed value', () => {
    expect(tryOnchainAgentId(null)).toBeNull();
    expect(tryOnchainAgentId('nope')).toBeNull();
  });
});
