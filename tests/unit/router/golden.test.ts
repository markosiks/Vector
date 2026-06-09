import { describe, expect, test } from 'bun:test';

import { route } from '@/lib/router/route';
import type { PrevAllocation, RouterAgent, RouterConfig, RouterState } from '@/lib/router/types';

import golden from '@/tests/fixtures/router-golden.json';

/**
 * Golden regression for the capital router (§6.2): the deterministic demo arc
 * — bootstrap → merit step toward the leader → blocked-theft crash that drains
 * the offender and reroutes capital. Each step's `route()` output must match the
 * recorded fixture bit-for-bit, and every step must conserve the pool exactly.
 *
 * Regenerate intentionally (and review the diff) only when the policy changes.
 */

interface GoldenStep {
  readonly name: string;
  readonly agents: RouterAgent[];
  readonly prev: PrevAllocation[];
  readonly state: RouterState;
  readonly trigger: 'settle' | 'attestation' | 'crash' | 'operator';
  readonly result: {
    readonly allocations: ReadonlyArray<Record<string, string>>;
    readonly state: RouterState;
  };
}

const fixture = golden as unknown as { config: RouterConfig; steps: GoldenStep[] };
const POOL_UNITS = 10n ** 24n;

function amountUnits(a: string): bigint {
  const [i, f = ''] = a.split('.');
  return BigInt((i ?? '0') + f.padEnd(18, '0').slice(0, 18));
}

describe('router golden — the deterministic demo arc', () => {
  for (const step of fixture.steps) {
    test(step.name, () => {
      const { allocations, state } = route(
        step.agents,
        step.prev,
        step.state,
        fixture.config,
        step.trigger,
      );
      expect(allocations).toEqual(step.result.allocations as never);
      expect(state).toEqual(step.result.state);

      const total = allocations.reduce((acc, a) => acc + amountUnits(a.amount), 0n);
      expect(total).toBe(POOL_UNITS);
    });
  }
});
