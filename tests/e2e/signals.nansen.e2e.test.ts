import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import { SEED_AGENTS, SEED_LEADER_ID } from '@/lib/agents/seed';
import { composeIntent } from '@/lib/replay/compose';
import { nansenSignalsFor } from '@/lib/replay/signals';
import { planTicks } from '@/lib/replay/scheduler';
import { intentHash } from '@/lib/intent/canonical';
import { signIntent } from '@/lib/intent/sign';
import { unsignedIntentSchema } from '@/lib/intent/schema';
import type { Context, Signals } from '@/lib/intent/types';
import type { NansenSignal, NansenSignalProvider } from '@/lib/signals/nansen';
import { DEMO_ARC } from '@/seed';

/**
 * End-to-end read-only contract for the Nansen signal (P2.2).
 *
 * The load-bearing property: a populated `context.signals.nansen` is visible to
 * `decide` but can NEVER change what executes. This signs the entire arc twice —
 * once with the leader's Nansen signal injected, once empty — and asserts the
 * sequences of signed Intent bytes are *byte-identical*. That is the trust
 * boundary made concrete: the signal informs the decision and nothing downstream
 * (sign → referee → rail) can observe it.
 *
 * No database: this exercises the deterministic signing surface only (mirrors
 * `tests/e2e/replay.e2e.test.ts`).
 */

const RATE = CONFIG.timing.tick_rate_ms;

const SNAPSHOT: NansenSignal = {
  source: 'nansen',
  endpoint: '/api/v1/smart-money/netflows',
  fetchedAtMs: 1_700_000_000_000,
  netflows: [
    { chain: 'ethereum', symbol: 'WETH', tokenAddress: '0xabc', netflowUsd: '4200000' },
    { symbol: 'PEPE', netflowUsd: '-99999.99' },
  ],
};

/** A provider that always serves {@link SNAPSHOT}; records that it was polled. */
function liveLeaderProvider(): { provider: NansenSignalProvider; polls: number[] } {
  const polls: number[] = [];
  return {
    provider: {
      current: () => SNAPSHOT,
      maybeRefresh: (tick) => {
        polls.push(tick);
      },
    },
    polls,
  };
}

/** Sign the whole arc, injecting `signalsFor(agentId)` into each tick's context. */
async function signArc(
  signalsFor: (agentId: string) => Signals,
): Promise<Array<{ nonce: string; hash: string; sig: string }>> {
  const arc = DEMO_ARC;
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
        signals: signalsFor(agent.id),
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

describe('nansen signal — read-only into context, never into execution', () => {
  test('injecting the leader signal yields a byte-identical signed arc', async () => {
    const baseline = await signArc(() => ({}));
    const withSignal = await signArc((agentId) =>
      agentId === SEED_LEADER_ID ? { nansen: SNAPSHOT } : {},
    );
    expect(withSignal).toEqual(baseline);
  });

  test('nansenSignalsFor places the live snapshot only on the leader', () => {
    const { provider } = liveLeaderProvider();
    expect(nansenSignalsFor(SEED_LEADER_ID, provider)).toEqual({ nansen: SNAPSHOT });
    for (const agent of SEED_AGENTS.filter((a) => a.id !== SEED_LEADER_ID)) {
      expect(nansenSignalsFor(agent.id, provider)).toEqual({});
    }
  });
});
