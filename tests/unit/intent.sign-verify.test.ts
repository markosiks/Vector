import { describe, expect, test } from 'bun:test';

import { signedIntentSchema } from '@/lib/intent/schema';
import { signerAddress, signIntent } from '@/lib/intent/sign';
import { recoverIntentSigner, verifyIntentSignature } from '@/lib/intent/verify';
import {
  OTHER_PK,
  OTHER_SIGNER,
  TEST_PK,
  TEST_SIGNER,
  validOpenInput,
  transferInput,
} from '@/tests/fixtures/intent-fixtures';

describe('signIntent / verifyIntentSignature', () => {
  test('a freshly signed intent recovers to and verifies against its signer', async () => {
    const signed = await signIntent(validOpenInput(), TEST_PK);
    expect(await recoverIntentSigner(signed)).toBe(TEST_SIGNER);
    expect(await verifyIntentSignature(signed, TEST_SIGNER)).toBe(true);
  });

  test('verification is checksum-insensitive on the expected address', async () => {
    const signed = await signIntent(validOpenInput(), TEST_PK);
    expect(
      await verifyIntentSignature(signed, TEST_SIGNER.toLowerCase() as typeof TEST_SIGNER),
    ).toBe(true);
  });

  test('refuses to sign a structurally invalid intent', async () => {
    await expect(signIntent({ action: 'open', agent_id: 'a' } as never, TEST_PK)).rejects.toThrow();
  });

  test('signed transfer (with target) verifies — the referee, not P0.3, rejects drains', async () => {
    const signed = await signIntent(transferInput(), TEST_PK);
    expect(await verifyIntentSignature(signed, TEST_SIGNER)).toBe(true);
  });
});

describe('signature is bound to the exact payload', () => {
  test('fails for a different (impostor) signer', async () => {
    const signed = await signIntent(validOpenInput(), TEST_PK);
    expect(await verifyIntentSignature(signed, OTHER_SIGNER)).toBe(false);
    const bySomeoneElse = await signIntent(validOpenInput(), OTHER_PK);
    expect(await verifyIntentSignature(bySomeoneElse, TEST_SIGNER)).toBe(false);
  });

  test('any mutation of a signed field invalidates the signature', async () => {
    const signed = await signIntent(validOpenInput({ size: 1000 }), TEST_PK);
    for (const mutation of [
      { size: '1001' },
      { market: 'ETH-PERP' },
      { side: 'short' as const },
      { nonce: 'other' },
      { ttl: '2031-01-01T00:00:00.000Z' },
      { agent_id: 'agent-002' },
    ]) {
      const tampered = signedIntentSchema.parse({ ...signed, ...mutation });
      expect(await verifyIntentSignature(tampered, TEST_SIGNER)).toBe(false);
    }
  });

  test('a corrupted signature is rejected, not thrown', async () => {
    const signed = await signIntent(validOpenInput(), TEST_PK);
    const flipped =
      `0x${signed.signature.slice(2).split('').reverse().join('')}` as typeof signed.signature;
    expect(await verifyIntentSignature({ ...signed, signature: flipped }, TEST_SIGNER)).toBe(false);
  });

  test('verifyIntentSignature returns false for a malformed expected address', async () => {
    const signed = await signIntent(validOpenInput(), TEST_PK);
    expect(await verifyIntentSignature(signed, 'not-an-address' as never)).toBe(false);
  });
});

describe('signerAddress', () => {
  test('derives the well-known account addresses', () => {
    expect(signerAddress(TEST_PK)).toBe(TEST_SIGNER);
    expect(signerAddress(OTHER_PK)).toBe(OTHER_SIGNER);
    expect(TEST_SIGNER).not.toBe(OTHER_SIGNER);
  });
});
