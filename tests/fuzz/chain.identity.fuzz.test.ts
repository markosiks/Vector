import { describe, expect, test } from 'bun:test';
import type { Address, Hex } from 'viem';

import { AgentIdError, parseOnchainAgentId } from '@/lib/chain/agent-id';
import {
  IdentityError,
  registerAgent,
  type IdentityWriteClient,
  type RegisterReceipt,
} from '@/lib/chain/identity';

const IDENTITY = '0x8004A818BFB912233c491871b3d84c89A494BD9e' as Address;
const UINT256_MAX = (1n << 256n) - 1n;

/** Deterministic small PRNG so failures reproduce. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (1664525 * s + 1013904223) >>> 0) / 0x100000000);
}

function randomHex(rng: () => number, bytes: number): Hex {
  let out = '0x';
  for (let i = 0; i < bytes; i++) {
    out += Math.floor(rng() * 256)
      .toString(16)
      .padStart(2, '0');
  }
  return out as Hex;
}

describe('registerAgent fuzz — garbage receipts never yield a bogus id', () => {
  test('random logs/topics resolve to an IdentityError or a valid bigint, never a panic', async () => {
    const rng = lcg(20240608);
    for (let i = 0; i < 300; i++) {
      const logs = Array.from({ length: Math.floor(rng() * 4) }, () => ({
        address: rng() < 0.5 ? (IDENTITY as string) : (randomHex(rng, 20) as string),
        topics: Array.from({ length: Math.floor(rng() * 4) }, () => randomHex(rng, 32)) as Hex[],
        data: randomHex(rng, Math.floor(rng() * 64)),
      }));
      const receipt: RegisterReceipt = { status: rng() < 0.9 ? 'success' : 'reverted', logs };
      const writer: IdentityWriteClient = {
        writeRegister: async () => randomHex(rng, 32),
        waitForReceipt: async () => receipt,
      };
      try {
        const id = await registerAgent(writer, IDENTITY, 'ipfs://card');
        // Only reachable if a well-formed Registered log was randomly produced
        // (astronomically unlikely) — assert the invariant rather than forbid it.
        expect(typeof id).toBe('bigint');
        expect(id >= 0n).toBe(true);
      } catch (err) {
        expect(err).toBeInstanceOf(IdentityError);
      }
    }
  });
});

describe('parseOnchainAgentId fuzz — arbitrary strings never panic', () => {
  test('garbage input is always a bounded bigint or an AgentIdError', () => {
    const rng = lcg(7);
    const alphabet = '0123456789abcdefABCDEFxX.- \n';
    for (let i = 0; i < 1000; i++) {
      const len = Math.floor(rng() * 12);
      let s = '';
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(rng() * alphabet.length)];
      try {
        const value = parseOnchainAgentId(s);
        expect(value >= 0n).toBe(true);
        expect(value <= UINT256_MAX).toBe(true);
      } catch (err) {
        expect(err).toBeInstanceOf(AgentIdError);
      }
    }
  });
});
