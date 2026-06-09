import { describe, expect, test } from 'bun:test';
import { privateKeyToAccount } from 'viem/accounts';

import {
  createTradeStrategy,
  getSeedAgent,
  resolveSeedSigner,
  SEED_AGENTS,
  SEED_LEADER_ID,
} from '@/lib/agents/seed';
import type { Context } from '@/lib/intent/types';

/**
 * Unit: the seed roster and its deterministic strategies (§8.1, §6.5). A seed
 * `decide` is a pure function of context; the roster's signer resolver is the
 * validator's `resolveSigner`.
 */

function ctx(overrides: Partial<Context> = {}): Context {
  return {
    agent_id: SEED_LEADER_ID,
    round_id: 'round-0',
    markets: { 'BTC-PERP': { price: '60000', ts: '2026-01-01T00:00:00.000Z' } },
    allocation: '0',
    remaining_budget: '0',
    score: 20,
    signals: {},
    ...overrides,
  };
}

describe('createTradeStrategy', () => {
  const decide = createTradeStrategy({
    market: 'BTC-PERP',
    side: 'long',
    size: '8000',
    leverage: '4',
    max_slippage: '0.005',
  });

  test('proposes a normalized open Intent for the context agent', async () => {
    const intent = await decide(ctx({ allocation: '500000', remaining_budget: '500000' }));
    expect(intent).toMatchObject({
      action: 'open',
      agent_id: SEED_LEADER_ID,
      market: 'BTC-PERP',
      side: 'long',
      size: '8000',
      leverage: '4',
      max_slippage: '0.005',
    });
  });

  test('clamps size down to the remaining budget', async () => {
    const intent = await decide(ctx({ allocation: '1500', remaining_budget: '1500' }));
    expect(intent.size).toBe('1500');
  });

  test('falls back to the base size at cold start (zero budget)', async () => {
    // Round 0 has no allocation yet; emitting a real Intent (not a zero-size one
    // the validator would reject) is what lets scoring bootstrap.
    expect((await decide(ctx({ remaining_budget: '0' }))).size).toBe('8000');
  });

  test('is pure — same context yields an identical proposal', async () => {
    const c = ctx({ allocation: '9000', remaining_budget: '9000' });
    expect(await decide(c)).toEqual(await decide(c));
  });
});

describe('seed roster', () => {
  test('every agent signs with the key that derives its address', () => {
    expect(SEED_AGENTS).toHaveLength(2);
    for (const agent of SEED_AGENTS) {
      expect(privateKeyToAccount(agent.privateKey).address).toBe(agent.signer);
      expect(agent.displayName).toBe(agent.id);
    }
  });

  test('resolveSeedSigner resolves known agents and rejects unknown ones', () => {
    const leader = getSeedAgent(SEED_LEADER_ID);
    expect(leader).toBeDefined();
    expect(resolveSeedSigner(SEED_LEADER_ID)).toBe(leader!.signer);
    expect(resolveSeedSigner('not-a-seed-agent')).toBeNull();
  });
});
