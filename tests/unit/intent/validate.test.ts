import { describe, expect, test } from 'bun:test';

import { intentHash } from '@/lib/intent/canonical';
import { signedIntentSchema } from '@/lib/intent/schema';
import { signIntent } from '@/lib/intent/sign';
import {
  createNonceGuard,
  validateIntent,
  type ValidateOptions,
  type ValidationResult,
} from '@/lib/intent/validate';
import {
  OTHER_PK,
  TEST_PK,
  TEST_SIGNER,
  resolveTestSigner,
  transferInput,
  validCloseInput,
  validOpenInput,
} from '@/tests/fixtures/intent-fixtures';

const NOW = new Date('2030-01-01T00:00:00.000Z');
const ttlAfterNow = new Date(NOW.getTime() + 60_000).toISOString();

const baseOpts = (over: Partial<ValidateOptions> = {}): ValidateOptions => ({
  resolveSigner: resolveTestSigner,
  now: NOW,
  ...over,
});

const expectFail = (r: ValidationResult, stage: string, code: string) => {
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.stage).toBe(stage as never);
    expect(r.code).toBe(code);
  }
};

describe('validateIntent — happy path', () => {
  test('a valid signed open intent passes and returns its hash', async () => {
    const signed = await signIntent(validOpenInput({ ttl: ttlAfterNow }), TEST_PK);
    const r = await validateIntent(signed, baseOpts());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.intent.action).toBe('open');
      expect(r.intent_hash).toBe(intentHash(signedIntentSchema.parse(signed)));
    }
  });

  test('a signed transfer with target_address passes P0.3 (referee handles drains)', async () => {
    const signed = await signIntent(transferInput({ ttl: ttlAfterNow }), TEST_PK);
    expect((await validateIntent(signed, baseOpts())).ok).toBe(true);
  });
});

describe('validateIntent — ordered failures (first failing check decides)', () => {
  test('(a) schema: malformed input fails before anything else', async () => {
    expectFail(await validateIntent({ action: 'open' }, baseOpts()), 'schema', 'invalid_schema');
    expectFail(await validateIntent('not-json', baseOpts()), 'schema', 'invalid_schema');
  });

  test('(b) signature: unknown signer', async () => {
    const signed = await signIntent(validOpenInput({ ttl: ttlAfterNow }), TEST_PK);
    expectFail(
      await validateIntent(signed, baseOpts({ resolveSigner: () => null })),
      'signature',
      'unknown_signer',
    );
  });

  test('(b) signature: wrong key', async () => {
    const signed = await signIntent(validOpenInput({ ttl: ttlAfterNow }), OTHER_PK);
    expectFail(await validateIntent(signed, baseOpts()), 'signature', 'bad_signature');
  });

  test('(b) before (d): a bad signature on an expired intent reports signature', async () => {
    const signed = await signIntent(validOpenInput({ ttl: '2020-01-01T00:00:00Z' }), OTHER_PK);
    expectFail(await validateIntent(signed, baseOpts()), 'signature', 'bad_signature');
  });

  test('(c) nonce: replay is rejected', async () => {
    const signed = await signIntent(validOpenInput({ nonce: 'n1', ttl: ttlAfterNow }), TEST_PK);
    const guard = createNonceGuard();
    guard.reserve('agent-001', 'n1');
    expectFail(
      await validateIntent(signed, baseOpts({ isNonceUsed: (a, n) => guard.has(a, n) })),
      'nonce',
      'replayed_nonce',
    );
  });

  test('(d) ttl: expired', async () => {
    const signed = await signIntent(validOpenInput({ ttl: '2029-12-31T23:59:00Z' }), TEST_PK);
    expectFail(await validateIntent(signed, baseOpts()), 'ttl', 'expired');
  });

  test('(d) ttl: boundary now === ttl is still valid', async () => {
    const signed = await signIntent(validOpenInput({ ttl: NOW.toISOString() }), TEST_PK);
    expect((await validateIntent(signed, baseOpts())).ok).toBe(true);
  });

  test('(d) ttl: clock-skew tolerance accepts a slightly-expired intent', async () => {
    const signed = await signIntent(
      validOpenInput({ ttl: new Date(NOW.getTime() - 5_000).toISOString() }),
      TEST_PK,
    );
    expectFail(await validateIntent(signed, baseOpts()), 'ttl', 'expired');
    expect((await validateIntent(signed, baseOpts({ clockSkewMs: 10_000 }))).ok).toBe(true);
  });

  test('(d) ttl: far-future is rejected only when a horizon is set', async () => {
    const signed = await signIntent(validOpenInput({ ttl: '2099-01-01T00:00:00Z' }), TEST_PK);
    expect((await validateIntent(signed, baseOpts())).ok).toBe(true);
    expectFail(
      await validateIntent(signed, baseOpts({ maxTtlHorizonMs: 24 * 3600 * 1000 })),
      'ttl',
      'ttl_too_far',
    );
  });

  test('(e) bounds: nonpositive size / leverage / out-of-range slippage', async () => {
    const mk = async (over: Record<string, unknown>) => {
      const signed = await signIntent(validOpenInput({ ttl: ttlAfterNow, ...over }), TEST_PK);
      return validateIntent(signed, baseOpts());
    };
    expectFail(await mk({ size: 0 }), 'bounds', 'nonpositive_size');
    expectFail(await mk({ size: -1 }), 'bounds', 'nonpositive_size');
    expectFail(await mk({ leverage: 0 }), 'bounds', 'nonpositive_leverage');
    expectFail(await mk({ max_slippage: 1.5 }), 'bounds', 'slippage_out_of_range');
    expectFail(await mk({ max_slippage: -0.1 }), 'bounds', 'slippage_out_of_range');
    // A value strictly above 1 that a float comparison would round down to 1
    // must still be rejected — the gate compares the canonical string, not a double.
    expectFail(await mk({ max_slippage: '1.0000000000000001' }), 'bounds', 'slippage_out_of_range');
    expectFail(await mk({ tp: 0 }), 'bounds', 'nonpositive_tp');
    expectFail(await mk({ sl: -1 }), 'bounds', 'nonpositive_sl');
  });

  test('(e) bounds: max_slippage boundary values 0 and 1 are accepted', async () => {
    const mk = async (over: Record<string, unknown>) => {
      const signed = await signIntent(validOpenInput({ ttl: ttlAfterNow, ...over }), TEST_PK);
      return validateIntent(signed, baseOpts());
    };
    expect((await mk({ max_slippage: 0 })).ok).toBe(true);
    expect((await mk({ max_slippage: 1 })).ok).toBe(true);
    expect((await mk({ max_slippage: '0.5' })).ok).toBe(true);
  });

  test('(e) bounds: a finer fractional scale than the column can store is rejected (silent-rounding guard)', async () => {
    const mk = async (over: Record<string, unknown>) => {
      const signed = await signIntent(validOpenInput({ ttl: ttlAfterNow, ...over }), TEST_PK);
      return validateIntent(signed, baseOpts());
    };
    // size/tp/sl are numeric(38, 18): a 19th fraction digit would be silently
    // rounded on INSERT, diverging the stored row from the signed bytes.
    expectFail(await mk({ size: '1.' + '0'.repeat(18) + '1' }), 'bounds', 'size_scale'); // 19 frac
    expectFail(await mk({ tp: '1.' + '0'.repeat(18) + '1' }), 'bounds', 'tp_scale');
    expectFail(await mk({ sl: '1.' + '0'.repeat(18) + '1' }), 'bounds', 'sl_scale');
    // leverage/max_slippage are numeric(12, 6): a 7th fraction digit is rejected.
    expectFail(await mk({ leverage: '1.0000001' }), 'bounds', 'leverage_scale'); // 7 frac
    expectFail(await mk({ max_slippage: '0.0000001' }), 'bounds', 'slippage_scale'); // 7 frac, in [0,1]
  });

  test('(e) bounds: storable-but-large magnitudes pass the gate — the firewall clips them', async () => {
    const mk = async (over: Record<string, unknown>) => {
      const signed = await signIntent(validOpenInput({ ttl: ttlAfterNow, ...over }), TEST_PK);
      return validateIntent(signed, baseOpts());
    };
    // A large-but-storable size/leverage is the firewall's job to CLIP (§6.5),
    // not the gate's to hard-reject. Values exactly at the column's integer +
    // fractional budget are accepted: size numeric(38, 18) ⇒ 20 integer digits,
    // leverage numeric(12, 6) ⇒ 6 integer digits.
    expect((await mk({ size: '9'.repeat(20) })).ok).toBe(true); // 20 integer digits
    expect((await mk({ size: '9'.repeat(20) + '.' + '9'.repeat(18) })).ok).toBe(true);
    expect((await mk({ leverage: '999999' })).ok).toBe(true); // 6 integer digits
    expect((await mk({ leverage: '999999.999999' })).ok).toBe(true); // numeric(12, 6)
    expect((await mk({ max_slippage: '0.999999' })).ok).toBe(true);
  });

  test('(e) bounds: a magnitude too large to store is rejected at the gate, not crashed on INSERT', async () => {
    const mk = async (over: Record<string, unknown>) => {
      const signed = await signIntent(validOpenInput({ ttl: ttlAfterNow, ...over }), TEST_PK);
      return validateIntent(signed, baseOpts());
    };
    // The raw Intent is persisted BEFORE the firewall clips, so an integer part
    // wider than the column (size/tp/sl numeric(38, 18) ⇒ 20; leverage
    // numeric(12, 6) ⇒ 6) would abort the INSERT with Postgres 22003. The gate
    // turns that uncaught crash into a clean, deterministic rejection.
    expectFail(await mk({ size: '9'.repeat(21) }), 'bounds', 'size_magnitude'); // 21 integer digits
    expectFail(await mk({ tp: '9'.repeat(21) }), 'bounds', 'tp_magnitude');
    expectFail(await mk({ sl: '9'.repeat(21) }), 'bounds', 'sl_magnitude');
    expectFail(await mk({ leverage: '1000000' }), 'bounds', 'leverage_magnitude'); // 7 integer digits
    // Magnitude is checked before scale: an over-wide integer part with extra
    // fraction digits reports the magnitude failure first.
    expectFail(
      await mk({ size: '9'.repeat(21) + '.123456789012345678901' }),
      'bounds',
      'size_magnitude',
    );
  });

  test('(e) before (f): a bad size beats a target_address violation', async () => {
    const signed = await signIntent(
      validOpenInput({ ttl: ttlAfterNow, size: -1, target_address: '0xabc' }),
      TEST_PK,
    );
    expectFail(await validateIntent(signed, baseOpts()), 'bounds', 'nonpositive_size');
  });

  test('(f) target_address on a non-transfer is rejected last', async () => {
    const signed = await signIntent(
      validOpenInput({ ttl: ttlAfterNow, target_address: '0xabc' }),
      TEST_PK,
    );
    expectFail(
      await validateIntent(signed, baseOpts()),
      'target_address',
      'target_only_on_transfer',
    );
  });

  test('close intent validates (no side/leverage required)', async () => {
    const signed = await signIntent(validCloseInput({ ttl: ttlAfterNow }), TEST_PK);
    expect((await validateIntent(signed, baseOpts())).ok).toBe(true);
  });
});

describe('createNonceGuard', () => {
  test('reserve wins exactly once; has reflects reservation', () => {
    const g = createNonceGuard();
    expect(g.has('a', '1')).toBe(false);
    expect(g.reserve('a', '1')).toBe(true);
    expect(g.reserve('a', '1')).toBe(false);
    expect(g.has('a', '1')).toBe(true);
    // No cross-talk between (agent, nonce) pairs that would otherwise collide.
    expect(g.reserve('a', '11')).toBe(true);
    expect(g.reserve('a1', '1')).toBe(true);
  });

  test('uses the default clock when now is omitted (expired far-past ttl)', async () => {
    const signed = await signIntent(validOpenInput({ ttl: '2000-01-01T00:00:00Z' }), TEST_PK);
    expectFail(
      await validateIntent(signed, { resolveSigner: () => TEST_SIGNER }),
      'ttl',
      'expired',
    );
  });
});
