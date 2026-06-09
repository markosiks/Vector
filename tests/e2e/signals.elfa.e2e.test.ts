import { describe, expect, test } from 'bun:test';

import { SEED_AGENTS, SEED_RUNNER_UP_ID } from '@/lib/agents/seed';
import { CONFIG } from '@/lib/config/constants';
import { intentHash } from '@/lib/intent/canonical';
import { unsignedIntentSchema } from '@/lib/intent/schema';
import { signIntent } from '@/lib/intent/sign';
import type { Context, Signals } from '@/lib/intent/types';
import { composeIntent } from '@/lib/replay/compose';
import { planTicks } from '@/lib/replay/scheduler';
import { elfaSignalsFor } from '@/lib/replay/signals';
import { buildElfaMock } from '@/lib/signals/elfa';
import type { ElfaSignal, ElfaSignalProvider } from '@/lib/signals/elfa';
import { DEMO_ARC } from '@/seed';

/**
 * End-to-end read-only contract for the Elfa signal (P3.1).
 *
 * The load-bearing property: a populated `context.signals.elfa` is visible to
 * `decide` but can NEVER change what executes. This signs the entire arc twice —
 * once with the runner-up's Elfa signal injected, once empty — and asserts the
 * sequences of signed Intent bytes are *byte-identical*. That is the trust
 * boundary made concrete: the signal informs the decision and nothing downstream
 * (sign → referee → rail) can observe it.
 *
 * It also pins the distinctive Elfa invariant: a wired provider *always* yields a
 * value on the runner-up (live or seeded mock), never `undefined`/`{}`.
 *
 * No database: this exercises the deterministic signing surface only.
 */

const RATE = CONFIG.timing.tick_rate_ms;

/** A deterministic mock snapshot, plus a hand-built "live" one for variety. */
const MOCK: ElfaSignal = buildElfaMock();
const LIVE: ElfaSignal = {
  source: 'elfa',
  origin: 'live',
  endpoint: '/v2/aggregations/trending-tokens',
  fetchedAtMs: 1_700_000_123_456,
  sentiments: [
    { symbol: 'BTC', sentiment: '0.91', mentions: '5000', mindshare: '0.40' },
    { symbol: 'DOGE', sentiment: '-0.33' },
  ],
};

/** A provider serving a fixed snapshot; records that it was polled. */
function fixedProvider(value: ElfaSignal): { provider: ElfaSignalProvider; polls: number[] } {
  const polls: number[] = [];
  return {
    provider: {
      current: () => value,
      maybeRefresh: (tick) => {
        polls.push(tick);
      },
      mode: () => (value.origin === 'live' ? 'live' : 'mock'),
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

describe('elfa signal — read-only into context, never into execution', () => {
  test('injecting the runner-up mock signal yields a byte-identical signed arc', async () => {
    const baseline = await signArc(() => ({}));
    const withMock = await signArc((agentId) =>
      agentId === SEED_RUNNER_UP_ID ? { elfa: MOCK } : {},
    );
    expect(withMock).toEqual(baseline);
  });

  test('even a live (wall-clock) snapshot cannot change the signed arc', async () => {
    const baseline = await signArc(() => ({}));
    const withLive = await signArc((agentId) =>
      agentId === SEED_RUNNER_UP_ID ? { elfa: LIVE } : {},
    );
    expect(withLive).toEqual(baseline);
  });

  test('elfaSignalsFor places the value only on the runner-up, always populated when wired', () => {
    for (const value of [MOCK, LIVE]) {
      const { provider } = fixedProvider(value);
      expect(elfaSignalsFor(SEED_RUNNER_UP_ID, provider)).toEqual({ elfa: value });
      for (const agent of SEED_AGENTS.filter((a) => a.id !== SEED_RUNNER_UP_ID)) {
        expect(elfaSignalsFor(agent.id, provider)).toEqual({});
      }
    }
  });
});
