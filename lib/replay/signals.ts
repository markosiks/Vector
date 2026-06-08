import { SEED_LEADER_ID } from '@/lib/agents/seed';
import type { Signals } from '@/lib/intent/types';
import type { NansenSignalProvider } from '@/lib/signals/nansen';

/**
 * The read-only signal slot for one agent at one tick (P2.2).
 *
 * Policy: the Nansen smart-money snapshot is injected **only** into the leader's
 * context — it is the smart-money-aware agent the arc is built around — and only
 * when a provider is wired *and* currently holds a snapshot. Every other case
 * yields an empty `{}`, which is what keeps the default arc byte-identical.
 *
 * The value is read-only and lives solely in `context.signals`. Because a seed
 * agent's `decide` returns an Intent that never embeds `signals`, the snapshot
 * structurally cannot reach signing, the referee, or the rail — it informs the
 * decision and nothing else (trust boundary: read-only into `context`).
 */
export function nansenSignalsFor(
  agentId: string,
  nansen: NansenSignalProvider | undefined,
): Signals {
  if (agentId !== SEED_LEADER_ID || nansen === undefined) return {};
  const signal = nansen.current();
  return signal === undefined ? {} : { nansen: signal };
}
