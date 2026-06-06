import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import { evaluate } from '@/lib/referee/evaluate';
import type { RefereeConfig } from '@/lib/referee/types';
import {
  cleanState,
  closeIntent,
  openIntent,
  transferIntent,
} from '@/tests/fixtures/referee-fixtures';

const POLICY = CONFIG.policy;
const DEAD = '0x000000000000000000000000000000000000dEaD';

describe('evaluate — happy path', () => {
  test('a clean, in-bounds open is ALLOWED unchanged', () => {
    const r = evaluate(openIntent(), cleanState(), POLICY);
    expect(r).toMatchObject({ decision: 'ALLOW', severity: 'none', rule_fired: 'allow' });
    expect(r.modified_intent).toBeUndefined();
  });
  test('a close on a whitelisted market with no drawdown is ALLOWED', () => {
    expect(evaluate(closeIntent(), cleanState(), POLICY).decision).toBe('ALLOW');
  });
});

describe('evaluate — first failing rule decides (ordering)', () => {
  test('kill switch beats every other violation', () => {
    const r = evaluate(
      openIntent({ market: 'DOGE-PERP', size: 999_999, leverage: 99 }),
      cleanState({
        killSwitch: { active: true },
        agent: { allocation: '1', remaining_budget: '0', drawdown: '0.99' },
      }),
      POLICY,
    );
    expect(r.rule_fired).toBe('kill_switch');
  });
  test('market whitelist beats size/leverage/budget violations', () => {
    const r = evaluate(
      openIntent({ market: 'DOGE-PERP', size: 999_999, leverage: 99 }),
      cleanState({ agent: { allocation: '1', remaining_budget: '0', drawdown: '0' } }),
      POLICY,
    );
    expect(r.rule_fired).toBe('market_whitelist');
  });
  test('transfer block beats budget rules for a transfer', () => {
    const r = evaluate(
      transferIntent({ target_address: DEAD, size: 999_999 }),
      cleanState({ agent: { allocation: '0', remaining_budget: '0', drawdown: '0' } }),
      POLICY,
    );
    expect(r.rule_fired).toBe('fresh_wallet_transfer_block');
  });
  test('a HALT/REJECT blocking rule beats an earlier-tripped CLIP (drawdown vs size)', () => {
    // Regression: an over-size trade by a drawdown-breached agent must HALT, not
    // be clipped through. Soft clips never pre-empt a terminal decision.
    const r = evaluate(
      openIntent({ size: 50_000, leverage: 99 }),
      cleanState({ agent: { allocation: '100000', remaining_budget: '100000', drawdown: '0.5' } }),
      POLICY,
    );
    expect(r).toMatchObject({ decision: 'HALT', rule_fired: 'drawdown_breaker' });
  });
  test('zero remaining budget REJECTs an over-size trade instead of clipping it', () => {
    // Regression: size_cap must not pre-empt the spend-cap REJECT on a
    // budget-exhausted agent.
    const r = evaluate(
      openIntent({ size: 50_000, leverage: 99 }),
      cleanState({ agent: { allocation: '0', remaining_budget: '0', drawdown: '0' } }),
      POLICY,
    );
    expect(r).toMatchObject({ decision: 'REJECT', rule_fired: 'spend_cap' });
  });
  test('drawdown breaker still decides when no earlier blocking rule fired', () => {
    const r = evaluate(
      openIntent({ size: 1000, leverage: 3 }),
      cleanState({ agent: { allocation: '100000', remaining_budget: '100000', drawdown: '0.5' } }),
      POLICY,
    );
    expect(r).toMatchObject({ decision: 'HALT', rule_fired: 'drawdown_breaker' });
  });
});

describe('evaluate — clips accumulate (no cap can be skipped by an earlier clip)', () => {
  test('size + leverage both over cap → both are clamped in one CLIP', () => {
    // Regression for the leverage-bypass: clipping size must not let an
    // over-cap leverage through.
    const r = evaluate(openIntent({ size: 50_000, leverage: 99 }), cleanState(), POLICY);
    expect(r.decision).toBe('CLIP');
    expect(r.clipped).toBe(true);
    const m = r.modified_intent!;
    expect(m.size).toBe('10000');
    expect('leverage' in m && m.leverage).toBe('5');
    expect(r.rule_fired).toContain('size_cap');
    expect(r.rule_fired).toContain('leverage_cap');
  });
  test('size over per-trade cap AND over remaining budget → clamped to the smaller (budget)', () => {
    const r = evaluate(
      openIntent({ size: 50_000, leverage: 99 }),
      cleanState({ agent: { allocation: '10', remaining_budget: '10', drawdown: '0' } }),
      POLICY,
    );
    expect(r.decision).toBe('CLIP');
    const m = r.modified_intent!;
    expect(m.size).toBe('10'); // min(max_trade_size=10000, remaining=10)
    expect('leverage' in m && m.leverage).toBe('5');
  });
  test('a single breached cap returns that rule verbatim (no synthetic composite)', () => {
    const r = evaluate(openIntent({ size: 50_000 }), cleanState(), POLICY);
    expect(r.rule_fired).toBe('size_cap');
    expect(r.modified_intent!.size).toBe('10000');
  });
});

describe('evaluate — severity mapping per decision', () => {
  const cases: {
    name: string;
    run: () => ReturnType<typeof evaluate>;
    decision: string;
    severity: string;
  }[] = [
    {
      name: 'ALLOW→none',
      run: () => evaluate(openIntent(), cleanState(), POLICY),
      decision: 'ALLOW',
      severity: 'none',
    },
    {
      name: 'whitelist REJECT→hard',
      run: () => evaluate(openIntent({ market: 'X' }), cleanState(), POLICY),
      decision: 'REJECT',
      severity: 'hard',
    },
    {
      name: 'transfer REJECT→hard',
      run: () => evaluate(transferIntent({ target_address: DEAD }), cleanState(), POLICY),
      decision: 'REJECT',
      severity: 'hard',
    },
    {
      name: 'size CLIP→soft',
      run: () => evaluate(openIntent({ size: 99_999 }), cleanState(), POLICY),
      decision: 'CLIP',
      severity: 'soft',
    },
    {
      name: 'spend REJECT→soft',
      run: () =>
        evaluate(
          openIntent({ size: 100 }),
          cleanState({ agent: { allocation: '0', remaining_budget: '0', drawdown: '0' } }),
          POLICY,
        ),
      decision: 'REJECT',
      severity: 'soft',
    },
    {
      name: 'leverage CLIP→soft',
      run: () => evaluate(openIntent({ leverage: 99 }), cleanState(), POLICY),
      decision: 'CLIP',
      severity: 'soft',
    },
    {
      name: 'kill HALT→halt',
      run: () => evaluate(openIntent(), cleanState({ killSwitch: { active: true } }), POLICY),
      decision: 'HALT',
      severity: 'halt',
    },
    {
      name: 'drawdown HALT→halt',
      run: () =>
        evaluate(
          openIntent(),
          cleanState({
            agent: { allocation: '100000', remaining_budget: '100000', drawdown: '0.4' },
          }),
          POLICY,
        ),
      decision: 'HALT',
      severity: 'halt',
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const r = c.run();
      expect(r.decision).toBe(c.decision as never);
      expect(r.severity).toBe(c.severity as never);
    });
  }
});

describe('evaluate — determinism / idempotency', () => {
  test('same inputs yield a structurally identical result', () => {
    const intent = openIntent({ size: 50_000 });
    const state = cleanState();
    const cfg: RefereeConfig = POLICY;
    expect(evaluate(intent, state, cfg)).toEqual(evaluate(intent, state, cfg));
  });
});
