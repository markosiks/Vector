import { describe, expect, test } from 'bun:test';

import example from '@/docs/examples/signed-intent.json';
import { canonicalPayload, intentHash } from '@/lib/intent/canonical';
import { signedIntentSchema, unsignedIntentSchema } from '@/lib/intent/schema';
import { signIntent } from '@/lib/intent/sign';
import { verifyIntentSignature } from '@/lib/intent/verify';
import { TEST_PK, TEST_SIGNER } from '@/tests/fixtures/intent-fixtures';

/**
 * Golden / regression vectors. These pin the wire format: a change to
 * canonicalization, hashing, or signing that would break external conformance
 * fails here loudly. The committed example doubles as the §14 onboarding sample.
 */

const PINNED_PAYLOAD =
  '{"action":"open","agent_id":"agent-001","leverage":"3","market":"BTC-PERP","max_slippage":"0.01","nonce":"42","side":"long","size":"1000","ttl":"2030-01-01T00:00:00.000Z"}';
const PINNED_HASH = '0x85ce2b999baf6548cfe141072013e077a79c2314a115750bcac77e7a8b4fee1f';
const PINNED_SIG =
  '0xbf8882aabc1712ff651c635a63719c4609be5150e1fb7b35649d7929a78ef38708bb532490ef3a651878f07ae18dc0d4c4c23520749db5c31385e2d0352c5b5f1c';

const PINNED_INPUT = {
  action: 'open',
  agent_id: 'agent-001',
  market: 'BTC-PERP',
  side: 'long',
  size: 1000,
  leverage: 3,
  max_slippage: 0.01,
  nonce: '42',
  ttl: '2030-01-01T00:00:00.000Z',
} as const;

describe('golden vectors', () => {
  test('canonical payload and hash are stable', () => {
    const unsigned = unsignedIntentSchema.parse(PINNED_INPUT);
    expect(canonicalPayload(unsigned)).toBe(PINNED_PAYLOAD);
    expect(intentHash(unsigned)).toBe(PINNED_HASH);
  });

  test('signing is deterministic and matches the pinned signature', async () => {
    const signed = await signIntent(PINNED_INPUT, TEST_PK);
    expect(signed.signature).toBe(PINNED_SIG);
    expect(await verifyIntentSignature(signed, TEST_SIGNER)).toBe(true);
  });

  test('the committed example file is internally consistent (emitter == verifier)', async () => {
    const parsed = signedIntentSchema.parse(example.intent);
    expect(canonicalPayload(parsed)).toBe(example.canonical_payload);
    expect(intentHash(parsed)).toBe(example.intent_hash as `0x${string}`);
    expect(await verifyIntentSignature(parsed, example.signer as `0x${string}`)).toBe(true);
  });
});
