import { describe, expect, test } from 'bun:test';

import {
  armAttack,
  consumeAttackArm,
  createSeedRail,
  isAttackArmed,
  resetAttackArm,
  settleWithFallback,
  type Rail,
  type RailFill,
} from '@/lib/replay';
import type { SeedOutcome } from '@/seed';

/**
 * Unit: the execution-rail seam + fallback (§6.5) and the operator attack latch.
 * The fallback guarantees the arc never stalls: an empty or throwing rail
 * degrades to the deterministic seeded fill.
 */

const OUTCOME: SeedOutcome = {
  pnl_realized: '100',
  pnl_marked: '0',
  capital_at_risk: '1000',
  fees: '1',
  position_delta: '1',
  drawdown: '0.020',
};
const SEED_FILL: RailFill = { status: 'filled', outcome: OUTCOME, rail_order_id: 'seed-x' };

describe('createSeedRail', () => {
  test('returns the frozen fill for the requested (agent, tick)', async () => {
    const rail = createSeedRail(() => OUTCOME);
    const fill = await rail.execute({ intent: {} as never, agentId: 'a', tickIndex: 3, intentHash: 'h' });
    expect(fill?.outcome).toEqual(OUTCOME);
    expect(fill?.status).toBe('filled');
  });
});

describe('settleWithFallback', () => {
  const req = { intent: {} as never, agentId: 'a', tickIndex: 0, intentHash: 'h' };

  test('uses the seed fill when no rail is provided', async () => {
    expect(await settleWithFallback(undefined, req, SEED_FILL)).toEqual({
      fill: SEED_FILL,
      degraded: false,
    });
  });

  test('uses the live fill when the rail returns one', async () => {
    const live: RailFill = { status: 'partial', outcome: OUTCOME };
    const rail: Rail = { execute: () => Promise.resolve(live) };
    expect(await settleWithFallback(rail, req, SEED_FILL)).toEqual({ fill: live, degraded: false });
  });

  test('falls back (degraded) when the rail returns null', async () => {
    const rail: Rail = { execute: () => Promise.resolve(null) };
    expect(await settleWithFallback(rail, req, SEED_FILL)).toEqual({
      fill: SEED_FILL,
      degraded: true,
    });
  });

  test('falls back (degraded) when the rail throws', async () => {
    const rail: Rail = { execute: () => Promise.reject(new Error('venue down')) };
    expect(await settleWithFallback(rail, req, SEED_FILL)).toEqual({
      fill: SEED_FILL,
      degraded: true,
    });
  });
});

describe('operator attack latch', () => {
  test('arms, reads once, then clears', () => {
    resetAttackArm();
    expect(isAttackArmed()).toBe(false);
    armAttack();
    expect(isAttackArmed()).toBe(true);
    expect(consumeAttackArm()).toBe(true);
    expect(consumeAttackArm()).toBe(false);
    expect(isAttackArmed()).toBe(false);
  });
});
