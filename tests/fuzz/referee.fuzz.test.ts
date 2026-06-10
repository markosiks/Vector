import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import { compareDecimal } from '@/lib/intent/canonical';
import { signedIntentSchema } from '@/lib/intent/schema';
import type { Intent } from '@/lib/intent/types';
import { evaluate } from '@/lib/referee/evaluate';
import type { RefereeState } from '@/lib/referee/types';

/**
 * Property/fuzz tests for the referee. A seeded PRNG drives random intents and
 * states so any failure reproduces exactly. Invariants (P1.1 §10):
 *  - the decision is always one of the four domain values; severity is in domain;
 *  - `hard` only ever attaches to the whitelist/transfer rules;
 *  - `HALT` only ever comes from the kill switch or the drawdown breaker;
 *  - no `transfer` to a non-whitelisted destination is ever ALLOW/CLIP;
 *  - CLIP is monotone (post-clip size/leverage ≤ the cap);
 *  - evaluate is idempotent (pure).
 */

const POLICY = CONFIG.policy;
const DUMMY_SIG = ('0x' + 'a'.repeat(130)) as `0x${string}`;
const DECISIONS = new Set(['ALLOW', 'CLIP', 'REJECT', 'HALT']);
const SEVERITIES = new Set(['none', 'soft', 'hard', 'halt']);

/** mulberry32 — small deterministic PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const amount = (r: () => number): number => Math.floor(r() * 200_000);

const MARKETS = ['BTC-PERP', 'ETH-PERP', 'DOGE-PERP', 'btc-perp', ''];
const ADDRS = [
  '0x000000000000000000000000000000000000dEaD',
  '0xabc0000000000000000000000000000000000001',
  '0x1111111111111111111111111111111111111111',
];

function randomIntent(r: () => number): Intent {
  const action = pick(r, ['open', 'modify', 'close', 'transfer'] as const);
  const base = {
    agent_id: 'agent-001',
    nonce: String(Math.floor(r() * 1e9)),
    ttl: '2999-01-01T00:00:00Z',
    signature: DUMMY_SIG,
  };
  if (action === 'transfer') {
    const withTarget = r() < 0.8;
    return signedIntentSchema.parse({
      action,
      ...base,
      size: amount(r),
      ...(withTarget ? { target_address: pick(r, ADDRS) } : {}),
    });
  }
  if (action === 'close') {
    return signedIntentSchema.parse({
      action,
      ...base,
      market: pick(r, MARKETS) || 'BTC-PERP',
      size: amount(r),
      max_slippage: 0.01,
    });
  }
  return signedIntentSchema.parse({
    action,
    ...base,
    market: pick(r, MARKETS) || 'BTC-PERP',
    side: pick(r, ['long', 'short'] as const),
    size: amount(r),
    leverage: Math.floor(r() * 20) + 1,
    max_slippage: 0.01,
  });
}

function randomState(r: () => number): RefereeState {
  const alloc = amount(r);
  return {
    killSwitch: { active: r() < 0.1 },
    agent: {
      allocation: String(alloc),
      remaining_budget: String(Math.floor(r() * (alloc + 1))),
      drawdown: (r() * 0.6).toFixed(4),
      ...(r() < 0.1 ? { halted: true } : {}),
    },
    ...(r() < 0.5
      ? {
          destination: {
            address: pick(r, ADDRS),
            age_seconds: Math.floor(r() * 2_000_000),
            has_history: r() < 0.5,
          },
        }
      : {}),
  };
}

describe('referee fuzz — domain & severity invariants', () => {
  test('1000 random evaluations preserve every invariant', () => {
    const r = rng(0xc0ffee);
    for (let i = 0; i < 1000; i++) {
      const intent = randomIntent(r);
      const state = randomState(r);
      const res = evaluate(intent, state, POLICY);

      // domain closure
      expect(DECISIONS.has(res.decision)).toBe(true);
      expect(SEVERITIES.has(res.severity)).toBe(true);

      // hard only for whitelist / transfer block
      if (res.severity === 'hard') {
        expect(['market_whitelist', 'fresh_wallet_transfer_block']).toContain(res.rule_fired);
      }
      // HALT only from kill switch, agent halt, or drawdown
      if (res.decision === 'HALT') {
        expect(['kill_switch', 'agent_halt', 'drawdown_breaker']).toContain(res.rule_fired);
      }
      // CLIP carries a modified intent; non-CLIP never does
      if (res.decision === 'CLIP') {
        expect(res.modified_intent).toBeDefined();
        expect(res.clipped).toBe(true);
      } else {
        expect(res.modified_intent).toBeUndefined();
      }

      // the load-bearing invariant: a non-whitelisted transfer is never allowed
      if (intent.action === 'transfer') {
        const whitelisted =
          intent.target_address !== undefined &&
          POLICY.fresh_wallet_criteria.whitelist.some(
            (w) => w.toLowerCase() === intent.target_address!.toLowerCase(),
          );
        if (!whitelisted) {
          expect(res.decision === 'ALLOW' || res.decision === 'CLIP').toBe(false);
        }
      }

      // Clip integrity: a CLIP result must satisfy *every* cap, not just the one
      // that happened to fire. This is the regression guard for the clip-ordering
      // bypass — clipping one field must never leave another cap breached.
      if (res.decision === 'CLIP' && res.modified_intent) {
        const m = res.modified_intent;
        // size is bounded by both the per-trade cap and the remaining budget
        expect(compareDecimal(m.size, POLICY.max_trade_size) <= 0).toBe(true);
        expect(compareDecimal(m.size, state.agent.remaining_budget) <= 0).toBe(true);
        // leverage is bounded by the leverage cap
        if ('leverage' in m) {
          expect(compareDecimal(m.leverage, POLICY.max_leverage) <= 0).toBe(true);
        }
      }

      // A CLIP can only happen when no blocking rule fired: so a CLIP implies
      // the agent is not drawdown-breached and has budget left.
      if (res.decision === 'CLIP') {
        expect(compareDecimal(state.agent.drawdown, POLICY.dd_breaker) < 0).toBe(true);
        expect(compareDecimal(state.agent.remaining_budget, 0) > 0).toBe(true);
      }

      // idempotency / determinism
      expect(evaluate(intent, state, POLICY)).toEqual(res);
    }
  });
});

describe('referee fuzz — extreme numbers never panic', () => {
  test('huge and near-zero magnitudes stay in-domain', () => {
    const sizes = ['0.0000000001', '1', '999999999999999999999999999999', '10000', '10000.0000001'];
    for (const size of sizes) {
      const intent = signedIntentSchema.parse({
        action: 'open',
        agent_id: 'a',
        market: 'BTC-PERP',
        side: 'long',
        size,
        leverage: 3,
        max_slippage: 0.01,
        nonce: '1',
        ttl: '2999-01-01T00:00:00Z',
        signature: DUMMY_SIG,
      });
      const res = evaluate(
        intent,
        {
          killSwitch: { active: false },
          agent: {
            allocation: '1e30',
            remaining_budget: '1000000000000000000000000000000',
            drawdown: '0',
          },
        },
        POLICY,
      );
      expect(DECISIONS.has(res.decision)).toBe(true);
    }
  });
});
