import { describe, expect, test } from 'bun:test';

import {
  deriveAgentIdOnchain,
  agentRegistryString,
  formatAgentIdOnchain,
  parseAgentIdOnchain,
} from '@/lib/chain/agent-id';

const OPERATOR = '0x1234567890abcdef1234567890abcdef12345678' as const;

describe('deriveAgentIdOnchain', () => {
  test('returns a bigint', () => {
    const id = deriveAgentIdOnchain('seed-leader', OPERATOR);
    expect(typeof id).toBe('bigint');
  });

  test('is deterministic — same inputs → same output', () => {
    const a = deriveAgentIdOnchain('seed-leader', OPERATOR);
    const b = deriveAgentIdOnchain('seed-leader', OPERATOR);
    expect(a).toBe(b);
  });

  test('different agent ids → different on-chain ids', () => {
    const a = deriveAgentIdOnchain('seed-leader', OPERATOR);
    const b = deriveAgentIdOnchain('seed-2', OPERATOR);
    expect(a).not.toBe(b);
  });

  test('different operator addresses → different on-chain ids', () => {
    const other = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
    const a = deriveAgentIdOnchain('seed-leader', OPERATOR);
    const b = deriveAgentIdOnchain('seed-leader', other);
    expect(a).not.toBe(b);
  });

  test('result is a 256-bit value (fits in uint256)', () => {
    const id = deriveAgentIdOnchain('seed-leader', OPERATOR);
    expect(id).toBeGreaterThan(0n);
    expect(id).toBeLessThan(2n ** 256n);
  });
});

describe('formatAgentIdOnchain', () => {
  test('returns 0x-prefixed 64-char hex', () => {
    const id = deriveAgentIdOnchain('seed-leader', OPERATOR);
    const formatted = formatAgentIdOnchain(id);
    expect(formatted).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test('zero pads short values', () => {
    const formatted = formatAgentIdOnchain(1n);
    expect(formatted).toBe('0x' + '0'.repeat(63) + '1');
  });
});

describe('parseAgentIdOnchain', () => {
  test('round-trips with formatAgentIdOnchain', () => {
    const id = deriveAgentIdOnchain('seed-leader', OPERATOR);
    const formatted = formatAgentIdOnchain(id);
    const parsed = parseAgentIdOnchain(formatted);
    expect(parsed).toBe(id);
  });

  test('throws on non-hex input', () => {
    expect(() => parseAgentIdOnchain('not-hex')).toThrow('must start with 0x');
  });

  test('handles 0X prefix (uppercase)', () => {
    const id = parseAgentIdOnchain('0X1');
    expect(id).toBe(1n);
  });
});

describe('agentRegistryString', () => {
  test('returns eip155:{chainId}:{address} format', () => {
    const s = agentRegistryString();
    expect(s).toMatch(/^eip155:\d+:0x[0-9a-fA-F]{40}$/);
  });

  test('contains chain id 5003 (Mantle Sepolia)', () => {
    const s = agentRegistryString();
    expect(s).toContain(':5003:');
  });

  test('uses the testnet Identity Registry by default', () => {
    const s = agentRegistryString();
    expect(s).toContain('0x8004A818BFB912233c491871b3d84c89A494BD9e');
  });

  test('accepts a custom Identity Registry address', () => {
    const custom = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as const;
    const s = agentRegistryString(custom);
    expect(s).toContain(custom);
  });
});
