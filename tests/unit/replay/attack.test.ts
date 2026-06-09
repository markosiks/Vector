import { describe, expect, test } from 'bun:test';

import { buildDrainIntent } from '@/lib/replay/attack';
import { ATTACKER_ADDRESS } from '@/seed';

/**
 * Unit: the canned drain Intent builder (§6.5, §5.3). It produces a real,
 * referee-bound `transfer` to a fresh wallet — the only fund-moving action —
 * with a strictly positive size so the validator's `size > 0` bound is met.
 */

describe('buildDrainIntent', () => {
  test('targets the attacker wallet with a transfer of the requested size', () => {
    const intent = buildDrainIntent({
      agentId: 'seed-leader',
      attackerAddress: ATTACKER_ADDRESS,
      size: '500000',
    });
    expect(intent).toMatchObject({
      action: 'transfer',
      agent_id: 'seed-leader',
      target_address: ATTACKER_ADDRESS,
      size: '500000',
    });
  });

  test('clamps a non-positive drain size up to a positive token amount', () => {
    expect(
      buildDrainIntent({ agentId: 'a', attackerAddress: ATTACKER_ADDRESS, size: '0' }).size,
    ).toBe('1');
    expect(
      buildDrainIntent({ agentId: 'a', attackerAddress: ATTACKER_ADDRESS, size: '-5' }).size,
    ).toBe('1');
  });
});
