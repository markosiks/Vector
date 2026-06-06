import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import {
  drawdownBreakerRule,
  killSwitchRule,
  leverageCapRule,
  marketWhitelistRule,
  sizeCapRule,
  spendCapRule,
  transferBlockRule,
} from '@/lib/referee/rules';
import type { RefereeConfig } from '@/lib/referee/types';
import {
  cleanState,
  closeIntent,
  openIntent,
  transferIntent,
} from '@/tests/fixtures/referee-fixtures';

const POLICY = CONFIG.policy;
const DEAD = '0x000000000000000000000000000000000000dEaD';

/** A policy config with selected overrides (deep on fresh_wallet_criteria). */
const policyWith = (over: { whitelist?: string[]; market_whitelist?: string[] }): RefereeConfig =>
  ({
    ...POLICY,
    ...(over.market_whitelist ? { market_whitelist: over.market_whitelist } : {}),
    fresh_wallet_criteria: {
      ...POLICY.fresh_wallet_criteria,
      ...(over.whitelist ? { whitelist: over.whitelist } : {}),
    },
  }) as RefereeConfig;

describe('rule 1 — kill switch', () => {
  test('fires HALT/halt when active, regardless of intent', () => {
    const r = killSwitchRule(openIntent(), cleanState({ killSwitch: { active: true } }), POLICY);
    expect(r).toMatchObject({ decision: 'HALT', severity: 'halt', rule_fired: 'kill_switch' });
  });
  test('passes when inactive', () => {
    expect(killSwitchRule(openIntent(), cleanState(), POLICY)).toBeNull();
  });
});

describe('rule 2 — market whitelist', () => {
  test('rejects a non-whitelisted market (hard)', () => {
    const r = marketWhitelistRule(openIntent({ market: 'DOGE-PERP' }), cleanState(), POLICY);
    expect(r).toMatchObject({
      decision: 'REJECT',
      severity: 'hard',
      rule_fired: 'market_whitelist',
    });
  });
  test('matches exactly — a differently-cased market is rejected', () => {
    expect(
      marketWhitelistRule(openIntent({ market: 'btc-perp' }), cleanState(), POLICY),
    ).not.toBeNull();
  });
  test('passes a whitelisted market', () => {
    expect(
      marketWhitelistRule(openIntent({ market: 'BTC-PERP' }), cleanState(), POLICY),
    ).toBeNull();
  });
  test('does not apply to transfer (no market)', () => {
    expect(marketWhitelistRule(transferIntent(), cleanState(), POLICY)).toBeNull();
  });
  test('applies to close', () => {
    expect(
      marketWhitelistRule(closeIntent({ market: 'DOGE-PERP' }), cleanState(), POLICY),
    ).not.toBeNull();
  });
});

describe('rule 3 — fresh-wallet / transfer block (critical invariant)', () => {
  test('transfer to a non-whitelisted address is ALWAYS REJECT + hard', () => {
    const r = transferBlockRule(transferIntent({ target_address: DEAD }), cleanState(), POLICY);
    expect(r).toMatchObject({
      decision: 'REJECT',
      severity: 'hard',
      rule_fired: 'fresh_wallet_transfer_block',
    });
  });
  test('a known, non-fresh destination is still rejected when not whitelisted', () => {
    const r = transferBlockRule(
      transferIntent({ target_address: DEAD }),
      cleanState({ destination: { address: DEAD, age_seconds: 10_000_000, has_history: true } }),
      POLICY,
    );
    expect(r).toMatchObject({ decision: 'REJECT', severity: 'hard' });
    expect((r!.detail as { is_fresh: boolean }).is_fresh).toBe(false);
  });
  test('whitelisted destination is allowed even if fresh (override)', () => {
    const cfg = policyWith({ whitelist: [DEAD] });
    expect(
      transferBlockRule(transferIntent({ target_address: DEAD }), cleanState(), cfg),
    ).toBeNull();
  });
  test('whitelist match is case-insensitive', () => {
    const cfg = policyWith({ whitelist: [DEAD.toLowerCase()] });
    expect(
      transferBlockRule(transferIntent({ target_address: DEAD.toUpperCase() }), cleanState(), cfg),
    ).toBeNull();
  });
  test('transfer with no target_address is rejected (missing destination)', () => {
    const r = transferBlockRule(
      transferIntent({ target_address: undefined }),
      cleanState(),
      POLICY,
    );
    expect(r).toMatchObject({ decision: 'REJECT', severity: 'hard' });
    expect((r!.detail as { reason: string }).reason).toBe('missing_target_address');
  });
  test('does not apply to non-transfer actions', () => {
    expect(transferBlockRule(openIntent(), cleanState(), POLICY)).toBeNull();
  });
});

describe('rule 4 — per-trade size cap', () => {
  test('clips size strictly above the cap (soft) to the cap', () => {
    const r = sizeCapRule(openIntent({ size: 20_000 }), cleanState(), POLICY);
    expect(r).toMatchObject({
      decision: 'CLIP',
      severity: 'soft',
      rule_fired: 'size_cap',
      clipped: true,
    });
    expect(r!.modified_intent).toMatchObject({ size: '10000' });
  });
  test('size exactly at the cap is allowed (boundary)', () => {
    expect(sizeCapRule(openIntent({ size: 10_000 }), cleanState(), POLICY)).toBeNull();
  });
  test('size just over the cap clips', () => {
    expect(sizeCapRule(openIntent({ size: 10_001 }), cleanState(), POLICY)).not.toBeNull();
  });
  test('does not apply to close', () => {
    expect(sizeCapRule(closeIntent({ size: 999_999 }), cleanState(), POLICY)).toBeNull();
  });
});

describe('rule 5 — spend cap', () => {
  test('rejects (soft) when no budget remains', () => {
    const r = spendCapRule(
      openIntent({ size: 100 }),
      cleanState({ agent: { allocation: '0', remaining_budget: '0', drawdown: '0' } }),
      POLICY,
    );
    expect(r).toMatchObject({ decision: 'REJECT', severity: 'soft', rule_fired: 'spend_cap' });
  });
  test('clips (soft) to the remaining budget when size exceeds it', () => {
    const r = spendCapRule(
      openIntent({ size: 8000 }),
      cleanState({ agent: { allocation: '10000', remaining_budget: '500', drawdown: '0' } }),
      POLICY,
    );
    expect(r).toMatchObject({ decision: 'CLIP', severity: 'soft' });
    expect(r!.modified_intent).toMatchObject({ size: '500' });
  });
  test('size equal to remaining budget is allowed (boundary)', () => {
    expect(
      spendCapRule(
        openIntent({ size: 500 }),
        cleanState({ agent: { allocation: '10000', remaining_budget: '500', drawdown: '0' } }),
        POLICY,
      ),
    ).toBeNull();
  });
  test('does not apply to transfer', () => {
    expect(spendCapRule(transferIntent(), cleanState(), POLICY)).toBeNull();
  });
});

describe('rule 6 — leverage cap', () => {
  test('clips leverage strictly above the cap (soft)', () => {
    const r = leverageCapRule(openIntent({ leverage: 10 }), cleanState(), POLICY);
    expect(r).toMatchObject({ decision: 'CLIP', severity: 'soft', rule_fired: 'leverage_cap' });
    expect(r!.modified_intent).toMatchObject({ leverage: '5' });
  });
  test('leverage at the cap is allowed (boundary)', () => {
    expect(leverageCapRule(openIntent({ leverage: 5 }), cleanState(), POLICY)).toBeNull();
  });
  test('does not apply to close/transfer (no leverage)', () => {
    expect(leverageCapRule(closeIntent(), cleanState(), POLICY)).toBeNull();
    expect(leverageCapRule(transferIntent(), cleanState(), POLICY)).toBeNull();
  });
});

describe('rule 7 — drawdown circuit-breaker', () => {
  test('halts when drawdown reaches the breaker (boundary: == trips)', () => {
    const r = drawdownBreakerRule(
      openIntent(),
      cleanState({ agent: { allocation: '1', remaining_budget: '1', drawdown: '0.3' } }),
      POLICY,
    );
    expect(r).toMatchObject({ decision: 'HALT', severity: 'halt', rule_fired: 'drawdown_breaker' });
  });
  test('passes just below the breaker', () => {
    expect(
      drawdownBreakerRule(
        openIntent(),
        cleanState({ agent: { allocation: '1', remaining_budget: '1', drawdown: '0.29999' } }),
        POLICY,
      ),
    ).toBeNull();
  });
  test('halts well above the breaker', () => {
    expect(
      drawdownBreakerRule(
        openIntent(),
        cleanState({ agent: { allocation: '1', remaining_budget: '1', drawdown: '0.9' } }),
        POLICY,
      ),
    ).not.toBeNull();
  });
});
