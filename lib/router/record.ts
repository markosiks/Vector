import { CONFIG } from '@/lib/config/constants';
import {
  insertCapitalAllocation,
  listAllocationsByRound,
} from '@/lib/db/repos/capital-allocations';
import type { AgentRow, CapitalAllocationRow } from '@/lib/db/schema';
import type { Queryable } from '@/lib/db/types';

import { route } from './route';
import type {
  Allocation,
  PrevAllocation,
  RouteResult,
  RouterAgent,
  RouterConfig,
  RouterState,
  RouteTrigger,
} from './types';

/**
 * Persistence layer for the capital router (P1.3). `route()` is the pure policy;
 * this module reads the previous allocation, derives the per-agent router inputs
 * from the denormalized `agents` cache, and writes the new `capital_allocations`
 * rows — the append-only ledger the P1.6 animation reads.
 */

/** The seeded router config (`CONFIG.router` + the conserved pool from `CONFIG.capital`). */
export function defaultRouterConfig(): RouterConfig {
  return { ...CONFIG.router, pool_size: CONFIG.capital.pool_size };
}

/** Options for {@link deriveRouterAgents}. */
export interface DeriveRouterAgentsOptions {
  /**
   * Agents that suffered a floor-crash this round (from the scoring result), and
   * must be gated out immediately. A `crash` trigger reroutes regardless, but
   * the explicit set makes the intent unambiguous even on a `settle` pass.
   */
  readonly crashedAgentIds?: ReadonlySet<string>;
  /** Global kill-switch (HALT): when active, every agent is gated out. */
  readonly killSwitchActive?: boolean;
}

/**
 * Reduce the `agents` rows to the router's per-agent inputs. `score` is the
 * denormalized `score_current`; `halted` is the operator HALT status (or the
 * global kill-switch); `crashed` is the per-round floor-crash set. Agents are
 * sorted by `id` so the apportionment tie-break is reproducible.
 */
export function deriveRouterAgents(
  agents: readonly AgentRow[],
  options: DeriveRouterAgentsOptions = {},
): RouterAgent[] {
  const crashed = options.crashedAgentIds ?? new Set<string>();
  const killed = options.killSwitchActive ?? false;
  return agents
    .map((a) => ({
      agentId: a.id,
      score: Number(a.score_current),
      halted: killed || a.status === 'halted',
      crashed: crashed.has(a.id),
    }))
    .sort((x, y) => (x.agentId < y.agentId ? -1 : x.agentId > y.agentId ? 1 : 0));
}

/** Read a round's allocations as the {@link PrevAllocation} baseline (weight = `target_weight`). */
export async function loadPrevAllocations(
  db: Queryable,
  roundId: string,
): Promise<PrevAllocation[]> {
  const rows = await listAllocationsByRound(db, roundId);
  // One round writes at most one allocation per agent; if a re-routed round wrote
  // several (settle then crash), the last row is the agent's standing position.
  const byAgent = new Map<string, PrevAllocation>();
  for (const r of rows) {
    byAgent.set(r.agent_id, { agentId: r.agent_id, amount: r.amount, weight: r.target_weight });
  }
  return [...byAgent.values()];
}

/** Arguments for {@link recordRoute}. */
export interface RecordRouteArgs {
  readonly db: Queryable;
  /** `rounds.id` the new allocations belong to. */
  readonly roundId: string;
  readonly agents: readonly RouterAgent[];
  readonly prev: readonly PrevAllocation[];
  readonly state: RouterState;
  readonly trigger: RouteTrigger;
  /** Defaults to the seeded {@link defaultRouterConfig}. */
  readonly config?: RouterConfig;
}

/** Result of {@link recordRoute}: the pure computation plus the inserted rows. */
export interface RecordRouteResult {
  readonly result: RouteResult;
  readonly rows: readonly CapitalAllocationRow[];
}

/** An allocation worth persisting: it holds capital now or it just lost capital. */
function isMaterial(a: Allocation): boolean {
  return Number.parseFloat(a.amount) > 0 || Number.parseFloat(a.prev_weight) > 0;
}

/**
 * Compute and persist one routing pass. Inserts a `capital_allocations` row for
 * every *material* allocation — an agent that holds capital now or that just had
 * it drained (a zero row for an agent that was and stays empty is noise, so it
 * is skipped). Returns the pure {@link RouteResult} (including the next cooldown
 * state for the caller to persist) and the inserted rows.
 *
 * Conservation is a property of the *full* result (`Σ amount == pool_size`);
 * filtering immaterial zero rows from the ledger does not change it, since those
 * rows carry no capital.
 */
export async function recordRoute(args: RecordRouteArgs): Promise<RecordRouteResult> {
  const config = args.config ?? defaultRouterConfig();
  const result = route(args.agents, args.prev, args.state, config, args.trigger);

  const rows: CapitalAllocationRow[] = [];
  for (const a of result.allocations) {
    if (!isMaterial(a)) continue;
    rows.push(
      await insertCapitalAllocation(args.db, {
        agent_id: a.agentId,
        round_id: args.roundId,
        amount: a.amount,
        target_weight: a.target_weight,
        prev_weight: a.prev_weight,
        delta: a.delta,
        trigger: a.trigger,
      }),
    );
  }

  return { result, rows };
}
