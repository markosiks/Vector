import type { AgentSnapshot, CapitalFlow, FlowArc, FlowDirection } from './types';

/**
 * Capital-flow derivation: turn two consecutive leaderboard polls into the
 * visible "capital flows from #1 to #2" motion.
 *
 * The read API (P1.5) exposes each agent's *current* allocation, not the
 * router's internal `delta`/`prev_weight`, so the screen reconstructs the flow
 * the only honest way a polling client can: by diffing the allocation an agent
 * held last poll against the one it holds now. That diff **is** the realized
 * `delta` as the UI can observe it, and because the pool is conserved on
 * reallocation (demo-spine guarantee), the outflows and inflows of a settle sum
 * to ~zero — which is exactly what lets us pair the leader's loss with the
 * runner-up's gain into a single arc.
 *
 * All magnitudes are `number` fractions of the pool: this is *geometry*, used to
 * size and time the animation, never to display a balance. The exact strings the
 * board shows come straight from the DTO, untouched by these floats.
 */

/** Below this fraction-of-pool, a change is noise (re-render, rounding) — ignore it. */
const FLOW_EPSILON = 1e-9;

function toNumber(value: string | null): number {
  if (value === null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function directionOf(delta: number): FlowDirection {
  if (delta > FLOW_EPSILON) return 'in';
  if (delta < -FLOW_EPSILON) return 'out';
  return 'none';
}

/**
 * Per-agent signed capital change between two polls, as a fraction of the pool.
 *
 * The union of agent ids across both snapshots is walked, so an agent that gains
 * its first allocation (absent → funded) or loses all of it (funded → absent) is
 * still reported. `poolSize` ≤ 0 or non-finite yields all-`none` flows rather
 * than dividing by zero. Agents whose change is within {@link FLOW_EPSILON} are
 * reported as `none` so a quiet poll produces no spurious motion.
 */
export function deriveFlows(
  prev: readonly AgentSnapshot[],
  next: readonly AgentSnapshot[],
  poolSize: number,
): CapitalFlow[] {
  const pool = Number.isFinite(poolSize) && poolSize > 0 ? poolSize : 0;
  const prevById = new Map(prev.map((a) => [a.id, a.allocation]));
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const a of [...prev, ...next]) {
    if (!seen.has(a.id)) {
      seen.add(a.id);
      ids.push(a.id);
    }
  }
  const nextById = new Map(next.map((a) => [a.id, a.allocation]));

  return ids.map((id) => {
    const deltaAbs = toNumber(nextById.get(id) ?? null) - toNumber(prevById.get(id) ?? null);
    const deltaFraction = pool === 0 ? 0 : deltaAbs / pool;
    return { agentId: id, direction: directionOf(deltaFraction), deltaFraction };
  });
}

/**
 * Pair outflows with inflows into transfer arcs, greedily matching the largest
 * loser to the largest gainer until one side is exhausted. On a conserving
 * reallocation (the demo's leader-crash reroute) this yields the single dominant
 * arc "leader → runner-up"; on a multi-agent shuffle it yields the few arcs that
 * carry the most capital. Each arc's `fraction` is the matched magnitude, so the
 * component can size the moving "packet" proportionally.
 *
 * Arcs are emitted largest-first and bounded by `maxArcs` (default `3`) so a
 * noisy poll cannot spawn an unbounded swarm of overlapping animations.
 */
export function pairFlows(flows: readonly CapitalFlow[], maxArcs = 3): FlowArc[] {
  const outs = flows
    .filter((f) => f.direction === 'out')
    .map((f) => ({ id: f.agentId, amt: -f.deltaFraction }))
    .sort((a, b) => b.amt - a.amt);
  const ins = flows
    .filter((f) => f.direction === 'in')
    .map((f) => ({ id: f.agentId, amt: f.deltaFraction }))
    .sort((a, b) => b.amt - a.amt);

  const arcs: FlowArc[] = [];
  let i = 0;
  let j = 0;
  while (i < outs.length && j < ins.length && arcs.length < maxArcs) {
    const out = outs[i]!;
    const inc = ins[j]!;
    const moved = Math.min(out.amt, inc.amt);
    if (moved > FLOW_EPSILON) {
      arcs.push({ fromAgentId: out.id, toAgentId: inc.id, fraction: moved });
    }
    out.amt -= moved;
    inc.amt -= moved;
    if (out.amt <= FLOW_EPSILON) i++;
    if (inc.amt <= FLOW_EPSILON) j++;
  }
  return arcs;
}
