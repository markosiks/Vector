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
  test('size cap fires before spend cap and before leverage cap', () => {
    // size over cap, budget tiny, leverage over cap — size cap is first.
    const r = evaluate(
      openIntent({ size: 50_000, leverage: 99 }),
      cleanState({ agent: { allocation: '10', remaining_budget: '10', drawdown: '0' } }),
      POLICY,
    );
    expect(r.rule_fired).toBe('size_cap');
    expect(r.decision).toBe('CLIP');
  });
  test('spend cap fires before leverage cap when size is within the per-trade cap', () => {
    const r = evaluate(
      openIntent({ size: 9000, leverage: 99 }),
      cleanState({ agent: { allocation: '100', remaining_budget: '100', drawdown: '0' } }),
      POLICY,
    );
    expect(r.rule_fired).toBe('spend_cap');
  });
  test('drawdown breaker fires last, only when nothing earlier did', () => {
    const r = evaluate(
      openIntent({ size: 1000, leverage: 3 }),
      cleanState({ agent: { allocation: '100000', remaining_budget: '100000', drawdown: '0.5' } }),
      POLICY,
    );
    expect(r.rule_fired).toBe('drawdown_breaker');
    expect(r.decision).toBe('HALT');
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
