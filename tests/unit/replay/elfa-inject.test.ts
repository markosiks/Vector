import { describe, expect, test } from 'bun:test';

import { SEED_LEADER_ID, SEED_RUNNER_UP_ID } from '@/lib/agents/seed';
import { elfaSignalsFor, nansenSignalsFor, signalsFor } from '@/lib/replay/signals';
import { buildElfaMock } from '@/lib/signals/elfa';
import type { ElfaSignal, ElfaSignalProvider } from '@/lib/signals/elfa';
import type { NansenSignal, NansenSignalProvider } from '@/lib/signals/nansen';

/**
 * Unit: the orchestrator's signal-injection policy for Elfa (P3.1) and the
 * combined `signalsFor`. The Elfa value is injected **only** into the runner-up's
 * `context.signals` (distinct from the leader that carries Nansen), and only when
 * a provider is wired; no provider ⇒ `{}` (byte-identical default). Because the
 * Elfa provider always holds a value, when wired the runner-up always sees one.
 */

const ELFA: ElfaSignal = buildElfaMock();

function elfaProvider(value: ElfaSignal): ElfaSignalProvider {
  return { current: () => value, maybeRefresh: () => undefined, mode: () => 'mock' };
}

const NANSEN: NansenSignal = {
  source: 'nansen',
  endpoint: '/api/v1/smart-money/netflows',
  fetchedAtMs: 1,
  netflows: [{ symbol: 'WETH', netflowUsd: '100' }],
};

function nansenProvider(value: NansenSignal | undefined): NansenSignalProvider {
  return { current: () => value, maybeRefresh: () => undefined };
}

describe('elfaSignalsFor', () => {
  test('injects the snapshot into the runner-up only', () => {
    const p = elfaProvider(ELFA);
    expect(elfaSignalsFor(SEED_RUNNER_UP_ID, p)).toEqual({ elfa: ELFA });
    expect(elfaSignalsFor(SEED_LEADER_ID, p)).toEqual({});
  });

  test('no provider ⇒ empty signals (byte-identical default)', () => {
    expect(elfaSignalsFor(SEED_RUNNER_UP_ID, undefined)).toEqual({});
  });

  test('an unknown agent never receives a signal', () => {
    expect(elfaSignalsFor('seed-unknown', elfaProvider(ELFA))).toEqual({});
  });
});

describe('signalsFor — merges per-source policies without collision', () => {
  test('leader gets only Nansen, runner-up gets only Elfa', () => {
    const providers = { nansen: nansenProvider(NANSEN), elfa: elfaProvider(ELFA) };
    expect(signalsFor(SEED_LEADER_ID, providers)).toEqual({ nansen: NANSEN });
    expect(signalsFor(SEED_RUNNER_UP_ID, providers)).toEqual({ elfa: ELFA });
  });

  test('no providers wired ⇒ empty for every agent (byte-identical default)', () => {
    expect(signalsFor(SEED_LEADER_ID, {})).toEqual({});
    expect(signalsFor(SEED_RUNNER_UP_ID, {})).toEqual({});
  });

  test('only Elfa wired ⇒ leader untouched, runner-up carries Elfa', () => {
    const providers = { elfa: elfaProvider(ELFA) };
    expect(signalsFor(SEED_LEADER_ID, providers)).toEqual({});
    expect(signalsFor(SEED_RUNNER_UP_ID, providers)).toEqual({ elfa: ELFA });
  });

  test('matches the standalone Nansen helper for the leader', () => {
    const providers = { nansen: nansenProvider(NANSEN) };
    expect(signalsFor(SEED_LEADER_ID, providers)).toEqual(
      nansenSignalsFor(SEED_LEADER_ID, providers.nansen),
    );
  });
});
