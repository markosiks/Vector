import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import { signedIntentSchema } from '@/lib/intent/schema';
import { signIntent } from '@/lib/intent/sign';
import { validateIntent } from '@/lib/intent/validate';
import { evaluate } from '@/lib/referee';
import { FRESH_WALLET_TRANSFER_BLOCK_RULE } from '@/lib/referee/rules/transfer-block';
import type { RefereeState } from '@/lib/referee/types';
import {
  resolveTestSigner,
  TEST_PK,
  transferInput,
  validOpenInput,
} from '@/tests/fixtures/intent-fixtures';

/**
 * Conformance pipeline (P3.3 §9). Proves the documented onboarding contract for
 * an *external-shaped* Intent end-to-end across the two boundaries an onboarded
 * agent crosses — P0.3 `validateIntent` then the P1.1 referee — without any IO:
 * `evaluate` is pure, so the conformance claim needs no DB.
 *
 * It asserts exactly what the doc promises and nothing it disclaims: a
 * well-formed whitelisted `open` validates and is ALLOWed; a `transfer` validates
 * (structurally authentic) yet is hard-REJECTed by the referee. Actual landing on
 * the live leaderboard is [ROADMAP] and is deliberately not asserted.
 */

const POLICY = CONFIG.policy;

const cleanState = (over: Partial<RefereeState> = {}): RefereeState => ({
  killSwitch: { active: false },
  agent: { allocation: '100000', remaining_budget: '100000', drawdown: '0' },
  ...over,
});

describe('onboarding conformance — P0.3 validate then referee evaluate', () => {
  test('a whitelisted open Intent validates (P0.3) and is ALLOWed by the referee', async () => {
    const signed = await signIntent(validOpenInput({ market: 'BTC-PERP' }), TEST_PK);

    const validation = await validateIntent(signed, { resolveSigner: resolveTestSigner });
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;

    const decision = evaluate(validation.intent, cleanState(), POLICY);
    expect(decision.decision).toBe('ALLOW');
  });

  test('a transfer validates (P0.3) but is hard-REJECTed by the referee (the boundary)', async () => {
    const signed = await signIntent(transferInput(), TEST_PK);

    const validation = await validateIntent(signed, { resolveSigner: resolveTestSigner });
    // Structurally valid + authentic: P0.3 does not judge transfers.
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;

    const decision = evaluate(validation.intent, cleanState(), POLICY);
    expect(decision.decision).toBe('REJECT');
    expect(decision.severity).toBe('hard');
    expect(decision.rule_fired).toBe(FRESH_WALLET_TRANSFER_BLOCK_RULE);
  });

  test('an off-whitelist market is rejected by the referee', async () => {
    const signed = await signIntent(validOpenInput({ market: 'DOGE-PERP' }), TEST_PK);

    const validation = await validateIntent(signed, { resolveSigner: resolveTestSigner });
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;

    const parsed = signedIntentSchema.parse(signed);
    const decision = evaluate(parsed, cleanState(), POLICY);
    expect(decision.decision).toBe('REJECT');
    expect(decision.rule_fired).toBe('market_whitelist');
  });
});
