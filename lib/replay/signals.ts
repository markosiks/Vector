import { SEED_LEADER_ID, SEED_RUNNER_UP_ID } from '@/lib/agents/seed';
import type { Signals } from '@/lib/intent/types';
import type { ElfaSignalProvider } from '@/lib/signals/elfa';
import type { NansenSignalProvider } from '@/lib/signals/nansen';

/**
 * The read-only signal slot for one agent at one tick (P2.2 Nansen, P3.1 Elfa).
 *
 * Policy:
 *  - The **Nansen** smart-money snapshot is injected **only** into the leader's
 *    context — it is the smart-money-aware agent the arc is built around — and
 *    only when a provider is wired *and* currently holds a snapshot.
 *  - The **Elfa** sentiment snapshot is injected **only** into the runner-up's
 *    context (`seed-2`, distinct from the leader that carries Nansen), and only
 *    when a provider is wired. The Elfa provider always holds a value (live or
 *    seeded mock), so when wired the runner-up always sees a sentiment.
 *
 * Every other case yields an empty `{}`. When no provider is wired the default
 * arc stays byte-identical; even when wired, the value lives solely in
 * `context.signals` and a seed agent's `decide` returns an Intent that never
 * embeds `signals`, so the snapshot structurally cannot reach signing, the
 * referee, or the rail (trust boundary: read-only into `context`).
 */

/** The leader's Nansen slot: the live snapshot when present, else `{}`. */
export function nansenSignalsFor(
  agentId: string,
  nansen: NansenSignalProvider | undefined,
): Signals {
  if (agentId !== SEED_LEADER_ID || nansen === undefined) return {};
  const signal = nansen.current();
  return signal === undefined ? {} : { nansen: signal };
}

/** The runner-up's Elfa slot: the current value (live or mock) when wired, else `{}`. */
export function elfaSignalsFor(agentId: string, elfa: ElfaSignalProvider | undefined): Signals {
  if (agentId !== SEED_RUNNER_UP_ID || elfa === undefined) return {};
  return { elfa: elfa.current() };
}

/**
 * Compose the full read-only signal slot for `agentId`, merging every wired
 * source. The per-source policies target *different* agents (Nansen → leader,
 * Elfa → runner-up), so the merged objects never collide; an unwired source
 * contributes nothing, preserving the byte-identical default.
 */
export function signalsFor(
  agentId: string,
  providers: {
    readonly nansen?: NansenSignalProvider | undefined;
    readonly elfa?: ElfaSignalProvider | undefined;
  },
): Signals {
  return {
    ...nansenSignalsFor(agentId, providers.nansen),
    ...elfaSignalsFor(agentId, providers.elfa),
  };
}
