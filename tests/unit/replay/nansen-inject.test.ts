import { describe, expect, test } from 'bun:test';

import { SEED_LEADER_ID, SEED_RUNNER_UP_ID } from '@/lib/agents/seed';
import { nansenSignalsFor } from '@/lib/replay/signals';
import type { NansenSignal, NansenSignalProvider } from '@/lib/signals/nansen';

/**
 * Unit: the orchestrator's signal-injection policy (P2.2). The Nansen snapshot
 * is injected **only** into the leader's `context.signals`, only when a provider
 * is wired and holds a value; every other case is an empty `{}` — which is what
 * keeps the default arc byte-identical.
 */

const SNAPSHOT: NansenSignal = {
  source: 'nansen',
  endpoint: '/api/v1/smart-money/netflows',
  fetchedAtMs: 1,
  netflows: [{ symbol: 'WETH', netflowUsd: '100' }],
};

function provider(value: NansenSignal | undefined): NansenSignalProvider {
  return { current: () => value, maybeRefresh: () => undefined };
}

describe('nansenSignalsFor', () => {
  test('injects the snapshot into the leader only', () => {
    const p = provider(SNAPSHOT);
    expect(nansenSignalsFor(SEED_LEADER_ID, p)).toEqual({ nansen: SNAPSHOT });
    expect(nansenSignalsFor(SEED_RUNNER_UP_ID, p)).toEqual({});
  });

  test('no provider ⇒ empty signals (byte-identical default)', () => {
    expect(nansenSignalsFor(SEED_LEADER_ID, undefined)).toEqual({});
  });

  test('provider with no cached snapshot ⇒ empty signals', () => {
    expect(nansenSignalsFor(SEED_LEADER_ID, provider(undefined))).toEqual({});
  });

  test('an unknown agent never receives a signal', () => {
    expect(nansenSignalsFor('seed-unknown', provider(SNAPSHOT))).toEqual({});
  });
});
