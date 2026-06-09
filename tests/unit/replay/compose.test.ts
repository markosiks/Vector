import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import { getSeedAgent, SEED_LEADER_ID } from '@/lib/agents/seed';
import { composeIntent, tickNonce, tickTtlIso } from '@/lib/replay/compose';
import type { Context } from '@/lib/intent/types';
import { buildDemoArc } from '@/seed';

/**
 * Unit: per-tick Intent composition (§5.2). The harness re-stamps a
 * deterministic, virtual-clock `nonce`/`ttl` over the strategy's placeholders,
 * and swaps the agent's decision for the canned drain when the attack fires.
 */

const arc = buildDemoArc({ rounds: 2 });
const agent = getSeedAgent(SEED_LEADER_ID)!;
const rate = CONFIG.timing.tick_rate_ms;

function ctx(): Context {
  return {
    agent_id: SEED_LEADER_ID,
    round_id: 'round-0',
    markets: arc.ticks[1]!.markets,
    allocation: '500000',
    remaining_budget: '500000',
    score: 50,
    signals: {},
  };
}

describe('composeIntent', () => {
  test('stamps the deterministic nonce and virtual-clock ttl over a normal decision', async () => {
    const intent = await composeIntent({
      arc,
      agent,
      context: ctx(),
      tickIndex: 1,
      tickRateMs: rate,
      isAttack: false,
    });
    expect(intent.action).toBe('open');
    expect(intent.nonce).toBe(tickNonce(SEED_LEADER_ID, 1));
    expect(intent.nonce).toBe('seed-leader-1');
    expect(intent.ttl).toBe(tickTtlIso(arc, 1, rate));
  });

  test('replaces the decision with the drain when the attack fires', async () => {
    const intent = await composeIntent({
      arc,
      agent,
      context: ctx(),
      tickIndex: arc.attack.atTick,
      tickRateMs: rate,
      isAttack: true,
    });
    expect(intent.action).toBe('transfer');
    expect(intent.target_address).toBe(arc.attack.attackerAddress);
    // Drain size is the agent's allocation.
    expect(intent.size).toBe('500000');
    // Even the attack carries the deterministic harness nonce/ttl.
    expect(intent.nonce).toBe(tickNonce(SEED_LEADER_ID, arc.attack.atTick));
  });

  test('is deterministic — identical inputs yield identical Intents', async () => {
    const args = { arc, agent, context: ctx(), tickIndex: 3, tickRateMs: rate, isAttack: false };
    expect(await composeIntent(args)).toEqual(await composeIntent(args));
  });

  test('nonces are unique per tick so no later tick aliases a replay', () => {
    const nonces = new Set(arc.ticks.map((t) => tickNonce(SEED_LEADER_ID, t.index)));
    expect(nonces.size).toBe(arc.totalTicks);
  });
});
