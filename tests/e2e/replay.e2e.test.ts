import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import { SEED_AGENTS, getSeedAgent } from '@/lib/agents/seed';
import { composeIntent } from '@/lib/replay/compose';
import { planTicks } from '@/lib/replay/scheduler';
import { evaluate } from '@/lib/referee/evaluate';
import { FRESH_WALLET_TRANSFER_BLOCK_RULE } from '@/lib/referee/rules/transfer-block';
import type { RefereeState } from '@/lib/referee/types';
import { intentHash } from '@/lib/intent/canonical';
import { signIntent } from '@/lib/intent/sign';
import { unsignedIntentSchema } from '@/lib/intent/schema';
import { validateIntent } from '@/lib/intent/validate';
import type { Context, Intent } from '@/lib/intent/types';
import { buildDemoArc, DEMO_ARC } from '@/seed';
import { resolveSeedSigner } from '@/lib/agents/seed';

/**
 * End-to-end determinism contract for the demo spine (§6.5, §10).
 *
 * Without a database, this exercises the *deterministic surface* of the arc: the
 * full sequence of composed → signed → hashed Intents must be byte-identical
 * across runs (same seed ⇒ same arc), and the canned drain must be blocked by
 * the real referee rule #3 — the load-bearing security property of the demo.
 */

const RATE = CONFIG.timing.tick_rate_ms;

/** Build the deterministic projection of the whole arc: every signed Intent's identity. */
async function signArc(
  arc = DEMO_ARC,
): Promise<Array<{ nonce: string; hash: string; sig: string }>> {
  const plan = planTicks(arc.totalTicks, CONFIG.timing);
  const out: Array<{ nonce: string; hash: string; sig: string }> = [];
  for (const tick of plan) {
    for (const agent of SEED_AGENTS) {
      const isAttack = tick.index === arc.attack.atTick && agent.id === arc.attack.targetAgentId;
      const context: Context = {
        agent_id: agent.id,
        round_id: `round-${tick.roundIndex}`,
        markets: arc.ticks[tick.index]!.markets,
        allocation: '500000',
        remaining_budget: '500000',
        score: 50,
        signals: {},
      };
      const unsigned = await composeIntent({
        arc,
        agent,
        context,
        tickIndex: tick.index,
        tickRateMs: RATE,
        isAttack,
      });
      const signed = await signIntent(unsigned, agent.privateKey);
      out.push({
        nonce: signed.nonce,
        hash: intentHash(unsignedIntentSchema.parse(unsigned)),
        sig: signed.signature,
      });
    }
  }
  return out;
}

describe('demo arc — determinism', () => {
  test('the same seed produces a byte-identical signed arc', async () => {
    const a = await signArc();
    const b = await signArc();
    expect(a).toEqual(b);
    // Sanity: every Intent across the arc is uniquely identified.
    expect(new Set(a.map((x) => x.nonce)).size).toBe(a.length);
  });
});

describe('demo arc — the referee blocks the injected drain (rule #3)', () => {
  const state: RefereeState = {
    killSwitch: { active: false },
    agent: { allocation: '500000', remaining_budget: '500000', drawdown: '0' },
  };

  test('the drain Intent validates but is REJECTed hard as a fresh-wallet transfer', async () => {
    const arc = buildDemoArc({ rounds: 2 });
    const agent = getSeedAgent(arc.attack.targetAgentId)!;
    const context: Context = {
      agent_id: agent.id,
      round_id: 'round-0',
      markets: arc.ticks[arc.attack.atTick]!.markets,
      allocation: '500000',
      remaining_budget: '500000',
      score: 90,
      signals: {},
    };
    const unsigned = await composeIntent({
      arc,
      agent,
      context,
      tickIndex: arc.attack.atTick,
      tickRateMs: RATE,
      isAttack: true,
    });
    const signed = await signIntent(unsigned, agent.privateKey);

    // It is a *valid* signed Intent (the attack is real, not malformed)…
    const now = new Date(arc.baseTimeMs + arc.attack.atTick * RATE);
    const validated = await validateIntent(signed, { resolveSigner: resolveSeedSigner, now });
    expect(validated.ok).toBe(true);

    // …and the referee blocks it: REJECT / hard / rule #3.
    const decision = evaluate(
      validated.ok ? validated.intent : (signed as Intent),
      state,
      CONFIG.policy,
    );
    expect(decision.decision).toBe('REJECT');
    expect(decision.severity).toBe('hard');
    expect(decision.rule_fired).toBe(FRESH_WALLET_TRANSFER_BLOCK_RULE);
  });

  test('a normal seed open is ALLOWed', async () => {
    const arc = buildDemoArc({ rounds: 2 });
    const agent = getSeedAgent(arc.attack.targetAgentId)!;
    const context: Context = {
      agent_id: agent.id,
      round_id: 'round-0',
      markets: arc.ticks[0]!.markets,
      allocation: '500000',
      remaining_budget: '500000',
      score: 50,
      signals: {},
    };
    const unsigned = await composeIntent({
      arc,
      agent,
      context,
      tickIndex: 0,
      tickRateMs: RATE,
      isAttack: false,
    });
    const signed = await signIntent(unsigned, agent.privateKey);
    const decision = evaluate(signed, state, CONFIG.policy);
    expect(decision.decision).toBe('ALLOW');
  });
});
