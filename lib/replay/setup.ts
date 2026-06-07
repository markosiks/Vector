import { CONFIG } from '@/lib/config/constants';
import { SEED_AGENTS } from '@/lib/agents/seed';
import { agentRow, type AgentRow } from '@/lib/db/schema';
import { insertAgent } from '@/lib/db/repos/agents';
import { getRoundByIndex, insertRound } from '@/lib/db/repos/rounds';
import { listAgentsByScore } from '@/lib/db/repos/agents';
import type { Queryable } from '@/lib/db/types';
import type { RoundRow } from '@/lib/db/schema';
import { deriveRouterAgents, loadPrevAllocations, recordRoute } from '@/lib/router/record';
import type { RouterState } from '@/lib/router/types';
import type { DemoArc } from '@/seed';

/**
 * Idempotent setup for a demo-arc run (architecture.txt §6.5).
 *
 * Materializes the persistent prerequisites the arc trades against — the seed
 * agents, round 0, and the **cold-start capital allocation** — so the very first
 * round already has capital-at-risk to score (without a bootstrap allocation the
 * system deadlocks: no allocation ⇒ no CaR ⇒ score never rises, §6.2). Every
 * step is find-or-create / idempotent, so re-running setup on a non-empty schema
 * converges rather than duplicating.
 */

/** Result of {@link setupArc}: the agent id map, round 0, and the bootstrap router state. */
export interface ArcSetup {
  /** Map from stable seed `agent_id` to the persisted {@link AgentRow} (uuid id). */
  readonly agentsBySeedId: ReadonlyMap<string, AgentRow>;
  /** The `rounds.id` of round 0 (already carrying the cold-start allocation). */
  readonly round0Id: string;
  /** Router state after the cold-start bootstrap (threaded into the first settle). */
  readonly routerState: RouterState;
}

/** Options for {@link setupArc}. */
export interface SetupArcOptions {
  /** Owner string stamped on created agents (default `vector-ops`). */
  readonly owner?: string;
}

/** Find an existing seed agent by its stable `display_name`, or `null`. */
async function findAgentByDisplayName(
  db: Queryable,
  displayName: string,
): Promise<AgentRow | null> {
  const { rows } = await db.query(
    "SELECT * FROM agents WHERE display_name = $1 AND strategy_kind = 'seed' LIMIT 1",
    [displayName],
  );
  const first = rows[0];
  return first === undefined ? null : agentRow.parse(first);
}

/** Find-or-create the round at `index`, tagging it with the arc's seed ref. */
export async function ensureRound(
  db: Queryable,
  index: number,
  seedRef: string,
): Promise<RoundRow> {
  const existing = await getRoundByIndex(db, index);
  if (existing !== null) return existing;
  return insertRound(db, { index, state: 'open', seed_ref: seedRef });
}

export async function setupArc(
  db: Queryable,
  arc: DemoArc,
  options: SetupArcOptions = {},
): Promise<ArcSetup> {
  const owner = options.owner ?? 'vector-ops';
  const seedRef = `seed/${arc.version}`;

  // 1 — Seed agents (idempotent): trust starts at the low `score_0` prior.
  const agentsBySeedId = new Map<string, AgentRow>();
  for (const agent of SEED_AGENTS) {
    const existing = await findAgentByDisplayName(db, agent.id);
    const row =
      existing ??
      (await insertAgent(db, {
        display_name: agent.id,
        owner,
        strategy_kind: 'seed',
        status: 'active',
        score_current: CONFIG.scoring.score_0,
      }));
    agentsBySeedId.set(agent.id, row);
  }

  // 2 — Round 0.
  const round0 = await ensureRound(db, 0, seedRef);

  // 3 — Cold-start route: every live seed agent gets an equal share so round 0
  // has capital-at-risk. `recordRoute` is idempotent against the round, so a
  // re-run does not double the pool.
  const agentRows = await listAgentsByScore(db);
  const routerAgents = deriveRouterAgents(agentRows);
  const prev = await loadPrevAllocations(db, round0.id);
  const bootstrapState: RouterState = { tick: 0, cooldownUntilTick: 0 };
  const routed = await recordRoute({
    db,
    roundId: round0.id,
    agents: routerAgents,
    prev,
    state: bootstrapState,
    trigger: 'settle',
  });

  return { agentsBySeedId, round0Id: round0.id, routerState: routed.result.state };
}
