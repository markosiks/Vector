import { describe, expect, test } from 'bun:test';

import { SEED_AGENTS } from '@/lib/agents/seed';
import { onchainAgentId, seedOnchainIdAssignments } from '@/lib/chain/agent-id';

describe('operator on-chain agentId assignment', () => {
  test('covers every seed agent, in roster order, with stable 1-based ids', () => {
    const assignments = seedOnchainIdAssignments();
    expect(assignments).toEqual(
      SEED_AGENTS.map((a, i) => ({ agentId: a.id, agentIdOnchain: String(i + 1) })),
    );
  });

  test('assigned on-chain ids are unique', () => {
    const ids = seedOnchainIdAssignments().map((a) => a.agentIdOnchain);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('resolves a known seed agent deterministically', () => {
    const first = SEED_AGENTS[0]!;
    expect(onchainAgentId(first.id)).toBe('1');
  });

  test('returns null for an unknown agent rather than inventing an id', () => {
    expect(onchainAgentId('not-a-seed-agent')).toBeNull();
  });
});
