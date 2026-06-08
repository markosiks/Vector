import { describe, expect, test } from 'bun:test';

import {
  feedbackAuthDigest,
  signFeedbackAuth,
  verifyFeedbackAuth,
  isAuthExpired,
} from '@/lib/chain/feedback-auth';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

/**
 * Fuzz tests for the feedback authorization module.
 *
 * ~10% happy-path / ~90% edge-case. Uses randomized inputs to shake out
 * boundary conditions in the signing/verification/expiry flow.
 */

function randomBigint(bits: number): bigint {
  const bytes = Math.ceil(bits / 8);
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return BigInt('0x' + [...arr].map((b) => b.toString(16).padStart(2, '0')).join(''));
}

function randomAddress(): `0x${string}` {
  const arr = new Uint8Array(20);
  crypto.getRandomValues(arr);
  return ('0x' + [...arr].map((b) => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
}

const FUZZ_ROUNDS = 25;

describe('feedbackAuthDigest fuzz', () => {
  test('never produces duplicate digests for random inputs', () => {
    const seen = new Set<string>();
    for (let i = 0; i < FUZZ_ROUNDS; i++) {
      const digest = feedbackAuthDigest(
        randomBigint(256),
        randomAddress(),
        randomBigint(64),
        randomBigint(64),
      );
      expect(seen.has(digest)).toBe(false);
      seen.add(digest);
    }
  });

  test('digest is always 66 chars (0x + 64 hex)', () => {
    for (let i = 0; i < FUZZ_ROUNDS; i++) {
      const digest = feedbackAuthDigest(
        randomBigint(256),
        randomAddress(),
        randomBigint(64),
        randomBigint(64),
      );
      expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });

  test('handles agentId = 0', () => {
    const d = feedbackAuthDigest(0n, randomAddress(), 1n, 999n);
    expect(d).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test('handles max uint256 agentId', () => {
    const max = 2n ** 256n - 1n;
    const d = feedbackAuthDigest(max, randomAddress(), 1n, 999n);
    expect(d).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test('handles maxFeedbackIndex = 0', () => {
    const d = feedbackAuthDigest(1n, randomAddress(), 0n, 999n);
    expect(d).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test('handles max uint64 maxFeedbackIndex', () => {
    const maxU64 = 2n ** 64n - 1n;
    const d = feedbackAuthDigest(1n, randomAddress(), maxU64, 999n);
    expect(d).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('signFeedbackAuth fuzz', () => {
  test('sign + verify round-trip with random keys', async () => {
    for (let i = 0; i < 5; i++) {
      const pk = generatePrivateKey();
      const account = privateKeyToAccount(pk);

      const auth = await signFeedbackAuth(pk, {
        agentId: randomBigint(128),
        clientAddress: randomAddress(),
        maxFeedbackIndex: randomBigint(32),
        expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
      });

      const ok = await verifyFeedbackAuth(auth, account.address);
      expect(ok).toBe(true);
    }
  });

  test('wrong key always fails verification', async () => {
    for (let i = 0; i < 5; i++) {
      const pk1 = generatePrivateKey();
      const pk2 = generatePrivateKey();
      const wrongAccount = privateKeyToAccount(pk2);

      const auth = await signFeedbackAuth(pk1, {
        agentId: randomBigint(128),
        clientAddress: randomAddress(),
        maxFeedbackIndex: randomBigint(32),
        expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
      });

      const ok = await verifyFeedbackAuth(auth, wrongAccount.address);
      expect(ok).toBe(false);
    }
  });

  test('single bit flip in any field invalidates signature', async () => {
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);

    const auth = await signFeedbackAuth(pk, {
      agentId: 42n,
      clientAddress: randomAddress(),
      maxFeedbackIndex: 10n,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    });

    // Flip agentId
    const bad1 = { ...auth, agentId: auth.agentId ^ 1n };
    expect(await verifyFeedbackAuth(bad1, account.address)).toBe(false);

    // Flip maxFeedbackIndex
    const bad2 = { ...auth, maxFeedbackIndex: auth.maxFeedbackIndex ^ 1n };
    expect(await verifyFeedbackAuth(bad2, account.address)).toBe(false);

    // Flip expiry
    const bad3 = { ...auth, expiry: auth.expiry ^ 1n };
    expect(await verifyFeedbackAuth(bad3, account.address)).toBe(false);
  });
});

describe('isAuthExpired fuzz', () => {
  test('random future expiry is not expired', () => {
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < FUZZ_ROUNDS; i++) {
      const future = BigInt(now + Math.floor(Math.random() * 100_000) + 1);
      expect(isAuthExpired(future, now)).toBe(false);
    }
  });

  test('random past expiry is expired', () => {
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < FUZZ_ROUNDS; i++) {
      const past = BigInt(now - Math.floor(Math.random() * 100_000) - 1);
      expect(isAuthExpired(past, now)).toBe(true);
    }
  });

  test('boundary: expiry = now is expired', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(isAuthExpired(BigInt(now), now)).toBe(true);
  });

  test('boundary: expiry = now + 1 is not expired', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(isAuthExpired(BigInt(now + 1), now)).toBe(false);
  });
});
