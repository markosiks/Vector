import { describe, expect, test } from 'bun:test';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';

import { verifyEip191Authorization } from '@/lib/chain/auth';
import { OperatorKeyError, parseOperatorKey } from '@/lib/chain/operator.schema';
import {
  RegistryError,
  getAgentSummary,
  getLastIndex,
  readFeedback,
  smokeRead,
  type ReputationReader,
} from '@/lib/chain/registry';

/**
 * Property: every untrusted input/response is either handled or rejected with a
 * *typed* error — never an untyped throw, a panic, or a hang. Generators are
 * seeded for determinism.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEX = '0123456789abcdefABCDEF';
const JUNK = ' \t\n0xZzgG:/?@.%-_<>"\'{}[]\u00e9\u4e2d\uFFFD';

function randString(rand: () => number, alphabet: string, maxLen: number): string {
  const len = Math.floor(rand() * maxLen);
  let out = '';
  for (let i = 0; i < len; i += 1) out += alphabet[Math.floor(rand() * alphabet.length)] ?? '';
  return out;
}

/** A reader whose reads return arbitrary junk, to fuzz the response path. */
function junkReader(value: unknown): ReputationReader {
  return {
    getCode: async () => (Math.random() > 0.5 ? '0x12' : '0x'),
    readContract: async () => value,
  };
}

describe('parseOperatorKey fuzz', () => {
  test('1000 arbitrary inputs are accepted or typed-rejected, never crash', () => {
    const rand = mulberry32(0xa11ce);
    for (let i = 0; i < 1000; i += 1) {
      const candidate = randString(rand, HEX + JUNK, 80);
      try {
        const key = parseOperatorKey(candidate);
        expect(key).toMatch(/^0x[0-9a-f]{64}$/);
      } catch (err) {
        expect(err).toBeInstanceOf(OperatorKeyError);
      }
    }
  });
});

describe('registry input fuzz', () => {
  test('arbitrary agentId/address/index inputs never throw untyped', async () => {
    const rand = mulberry32(0xbeef);
    const reader = junkReader(0n);
    for (let i = 0; i < 400; i += 1) {
      const agentId = randString(rand, HEX + JUNK, 40);
      const addr = randString(rand, HEX + JUNK, 44);
      const idx = randString(rand, HEX + JUNK, 30);
      for (const op of [
        () => getLastIndex(reader, agentId, addr),
        () => readFeedback(reader, agentId, addr, idx),
        () => getAgentSummary(reader, agentId, [addr]),
      ]) {
        try {
          await op();
        } catch (err) {
          expect(err).toBeInstanceOf(RegistryError);
        }
      }
    }
  });
});

describe('registry response fuzz', () => {
  test('arbitrary RPC payloads are decoded or typed-rejected', async () => {
    const rand = mulberry32(0xc0de);
    const REG = '0x8004B663056A597Dffe9eCcC1965A193B7388713' as Address;
    const payloads: unknown[] = [
      undefined,
      null,
      0,
      '',
      'not-an-address',
      [],
      [1n],
      [1n, 2n],
      {},
      [randString(rand, JUNK, 10)],
      Number.NaN,
    ];
    for (const p of payloads) {
      for (const op of [
        () => smokeRead(junkReader(p), REG),
        () => getAgentSummary(junkReader(p), 1, [REG]),
        () => readFeedback(junkReader(p), 1, REG, 0),
      ]) {
        try {
          await op();
        } catch (err) {
          expect(err).toBeInstanceOf(RegistryError);
        }
      }
    }
  });
});

describe('EIP-191 authorization fuzz', () => {
  test('arbitrary signatures are rejected cleanly, valid ones accepted', async () => {
    const rand = mulberry32(0xf00d);
    const account = privateKeyToAccount(
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    );
    for (let i = 0; i < 300; i += 1) {
      const sig = `0x${randString(rand, HEX, 140)}` as Hex;
      const verdict = await verifyEip191Authorization('msg', sig, account.address);
      expect(typeof verdict).toBe('boolean');
    }
    const good = await account.signMessage({ message: 'msg' });
    expect(await verifyEip191Authorization('msg', good, account.address)).toBe(true);
  });
});
