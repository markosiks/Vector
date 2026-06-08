import { describe, expect, test } from 'bun:test';

import {
  feedbackAuthDigest,
  signFeedbackAuth,
  verifyFeedbackAuth,
  isAuthExpired,
  type FeedbackAuthorization,
} from '@/lib/chain/feedback-auth';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * Deterministic test key — NEVER use in production.
 * This is the well-known Hardhat account #0 private key.
 */
const TEST_PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_ACCOUNT = privateKeyToAccount(TEST_PK);
const TEST_ADDRESS = TEST_ACCOUNT.address;

const CLIENT_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const; // Hardhat #1

describe('feedbackAuthDigest', () => {
  test('returns a 0x-prefixed 66-char hex string (bytes32)', () => {
    const digest = feedbackAuthDigest(1n, CLIENT_ADDRESS, 10n, 9_999_999_999n);
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test('is deterministic — same inputs → same digest', () => {
    const a = feedbackAuthDigest(1n, CLIENT_ADDRESS, 10n, 9_999_999_999n);
    const b = feedbackAuthDigest(1n, CLIENT_ADDRESS, 10n, 9_999_999_999n);
    expect(a).toBe(b);
  });

  test('different agentId → different digest', () => {
    const a = feedbackAuthDigest(1n, CLIENT_ADDRESS, 10n, 9_999_999_999n);
    const b = feedbackAuthDigest(2n, CLIENT_ADDRESS, 10n, 9_999_999_999n);
    expect(a).not.toBe(b);
  });

  test('different clientAddress → different digest', () => {
    const other = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as const;
    const a = feedbackAuthDigest(1n, CLIENT_ADDRESS, 10n, 9_999_999_999n);
    const b = feedbackAuthDigest(1n, other, 10n, 9_999_999_999n);
    expect(a).not.toBe(b);
  });

  test('different maxFeedbackIndex → different digest', () => {
    const a = feedbackAuthDigest(1n, CLIENT_ADDRESS, 10n, 9_999_999_999n);
    const b = feedbackAuthDigest(1n, CLIENT_ADDRESS, 20n, 9_999_999_999n);
    expect(a).not.toBe(b);
  });

  test('different expiry → different digest', () => {
    const a = feedbackAuthDigest(1n, CLIENT_ADDRESS, 10n, 9_999_999_999n);
    const b = feedbackAuthDigest(1n, CLIENT_ADDRESS, 10n, 8_888_888_888n);
    expect(a).not.toBe(b);
  });
});

describe('signFeedbackAuth', () => {
  test('returns a valid FeedbackAuthorization object', async () => {
    const auth = await signFeedbackAuth(TEST_PK, {
      agentId: 42n,
      clientAddress: CLIENT_ADDRESS,
      maxFeedbackIndex: 100n,
      expiry: 9_999_999_999n,
    });

    expect(auth.agentId).toBe(42n);
    expect(auth.clientAddress).toBe(CLIENT_ADDRESS);
    expect(auth.maxFeedbackIndex).toBe(100n);
    expect(auth.expiry).toBe(9_999_999_999n);
    expect(auth.signer.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
    expect(auth.signature).toMatch(/^0x[0-9a-f]+$/);
  });

  test('signature is 65 bytes (130 hex chars + 0x)', async () => {
    const auth = await signFeedbackAuth(TEST_PK, {
      agentId: 1n,
      clientAddress: CLIENT_ADDRESS,
      maxFeedbackIndex: 1n,
      expiry: 9_999_999_999n,
    });
    // EIP-191 personal_sign produces 65-byte signatures (r + s + v)
    expect(auth.signature.length).toBe(132); // 0x + 130 hex chars
  });

  test('signing is deterministic', async () => {
    const params = {
      agentId: 1n,
      clientAddress: CLIENT_ADDRESS,
      maxFeedbackIndex: 1n,
      expiry: 9_999_999_999n,
    };
    const a = await signFeedbackAuth(TEST_PK, params);
    const b = await signFeedbackAuth(TEST_PK, params);
    expect(a.signature).toBe(b.signature);
  });
});

describe('verifyFeedbackAuth', () => {
  test('verifies a valid authorization', async () => {
    const auth = await signFeedbackAuth(TEST_PK, {
      agentId: 42n,
      clientAddress: CLIENT_ADDRESS,
      maxFeedbackIndex: 100n,
      expiry: 9_999_999_999n,
    });

    const ok = await verifyFeedbackAuth(auth, TEST_ADDRESS);
    expect(ok).toBe(true);
  });

  test('rejects when expectedSigner does not match', async () => {
    const auth = await signFeedbackAuth(TEST_PK, {
      agentId: 42n,
      clientAddress: CLIENT_ADDRESS,
      maxFeedbackIndex: 100n,
      expiry: 9_999_999_999n,
    });

    const ok = await verifyFeedbackAuth(auth, CLIENT_ADDRESS);
    expect(ok).toBe(false);
  });

  test('rejects a tampered signature', async () => {
    const auth = await signFeedbackAuth(TEST_PK, {
      agentId: 42n,
      clientAddress: CLIENT_ADDRESS,
      maxFeedbackIndex: 100n,
      expiry: 9_999_999_999n,
    });

    // Flip a byte in the signature
    const tampered = {
      ...auth,
      signature: (auth.signature.slice(0, -2) + 'ff') as `0x${string}`,
    };

    const ok = await verifyFeedbackAuth(tampered, TEST_ADDRESS);
    expect(ok).toBe(false);
  });

  test('rejects when agentId is modified', async () => {
    const auth = await signFeedbackAuth(TEST_PK, {
      agentId: 42n,
      clientAddress: CLIENT_ADDRESS,
      maxFeedbackIndex: 100n,
      expiry: 9_999_999_999n,
    });

    const modified = { ...auth, agentId: 43n };
    const ok = await verifyFeedbackAuth(modified, TEST_ADDRESS);
    expect(ok).toBe(false);
  });

  test('rejects when maxFeedbackIndex is inflated', async () => {
    const auth = await signFeedbackAuth(TEST_PK, {
      agentId: 42n,
      clientAddress: CLIENT_ADDRESS,
      maxFeedbackIndex: 100n,
      expiry: 9_999_999_999n,
    });

    const modified = { ...auth, maxFeedbackIndex: 999n };
    const ok = await verifyFeedbackAuth(modified, TEST_ADDRESS);
    expect(ok).toBe(false);
  });

  test('rejects when expiry is extended', async () => {
    const auth = await signFeedbackAuth(TEST_PK, {
      agentId: 42n,
      clientAddress: CLIENT_ADDRESS,
      maxFeedbackIndex: 100n,
      expiry: 9_999_999_999n,
    });

    const modified = { ...auth, expiry: 99_999_999_999n };
    const ok = await verifyFeedbackAuth(modified, TEST_ADDRESS);
    expect(ok).toBe(false);
  });
});

describe('isAuthExpired', () => {
  test('returns false when expiry is in the future', () => {
    const futureExpiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
    expect(isAuthExpired(futureExpiry)).toBe(false);
  });

  test('returns true when expiry is in the past', () => {
    const pastExpiry = BigInt(Math.floor(Date.now() / 1000) - 3600);
    expect(isAuthExpired(pastExpiry)).toBe(true);
  });

  test('returns true when expiry equals current time', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(isAuthExpired(BigInt(now), now)).toBe(true);
  });

  test('respects custom nowSeconds parameter', () => {
    expect(isAuthExpired(100n, 50)).toBe(false);  // 100 > 50 → not expired
    expect(isAuthExpired(100n, 100)).toBe(true);   // 100 <= 100 → expired
    expect(isAuthExpired(100n, 200)).toBe(true);   // 100 <= 200 → expired
  });
});
