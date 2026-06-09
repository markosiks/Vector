import { describe, expect, test } from 'bun:test';

import {
  chainStateMeta,
  isStuckOptimistic,
  STUCK_OPTIMISTIC_MS,
} from '@/lib/credibility/chain-state';

/**
 * The badge model must describe every real chain state honestly (pending vs
 * confirmed vs failed) and survive an unknown value from a corrupt DTO. The
 * stuck-optimistic signal must fire only for an `optimistic` row older than the
 * reconcile budget — never for a confirmed/failed row or a fresh write.
 */

describe('chainStateMeta', () => {
  test('optimistic is a non-terminal pending state', () => {
    const m = chainStateMeta('optimistic');
    expect(m.tone).toBe('pending');
    expect(m.terminal).toBe(false);
    expect(m.label).toBe('Optimistic');
  });

  test('confirmed is terminal/success and failed is terminal/danger', () => {
    expect(chainStateMeta('confirmed')).toMatchObject({ tone: 'success', terminal: true });
    expect(chainStateMeta('failed')).toMatchObject({ tone: 'danger', terminal: true });
  });

  test('an unknown state degrades, never throws', () => {
    const m = chainStateMeta('garbage');
    expect(m.label).toBe('garbage');
    expect(m.terminal).toBe(false);
  });
});

describe('isStuckOptimistic', () => {
  const now = new Date('2026-06-09T12:00:00.000Z');
  const ago = (ms: number): string => new Date(now.getTime() - ms).toISOString();

  test('fresh optimistic write is not stuck', () => {
    expect(isStuckOptimistic({ chain_state: 'optimistic', created_at: ago(1_000) }, now)).toBe(
      false,
    );
  });

  test('optimistic past the budget is stuck', () => {
    expect(
      isStuckOptimistic(
        { chain_state: 'optimistic', created_at: ago(STUCK_OPTIMISTIC_MS + 1) },
        now,
      ),
    ).toBe(true);
  });

  test('confirmed / failed are never stuck regardless of age', () => {
    expect(isStuckOptimistic({ chain_state: 'confirmed', created_at: ago(10 * 60_000) }, now)).toBe(
      false,
    );
    expect(isStuckOptimistic({ chain_state: 'failed', created_at: ago(10 * 60_000) }, now)).toBe(
      false,
    );
  });

  test('an unparseable timestamp is treated as not-stuck', () => {
    expect(isStuckOptimistic({ chain_state: 'optimistic', created_at: 'not-a-date' }, now)).toBe(
      false,
    );
  });

  test('honours a custom threshold', () => {
    const att = { chain_state: 'optimistic' as const, created_at: ago(5_000) };
    expect(isStuckOptimistic(att, now, 4_000)).toBe(true);
    expect(isStuckOptimistic(att, now, 6_000)).toBe(false);
  });
});
