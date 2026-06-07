import type { SeedAgent } from '@/lib/agents/seed';
import type { Context, UnsignedIntentInput } from '@/lib/intent/types';
import type { DemoArc } from '@/seed';

import { buildDrainIntent } from './attack';
import { tickInstantMs } from './scheduler';

/**
 * Compose the harness-stamped Intent an agent issues at a tick (§5.2 steps 2–3).
 *
 * The agent's pure `decide` (or, when the attack fires, the canned drain) only
 * *proposes* the trade; the harness owns anti-replay and expiry, so this stamps
 * the authoritative, deterministic `nonce` and `ttl`, overwriting the strategy's
 * placeholders. Both are derived from the virtual clock, never `Date.now()`:
 *
 *   - `nonce = "<agent_id>-<tickIndex>"` — unique per (agent, tick), so each
 *     tick's Intent is distinct and no later tick is rejected as a replay;
 *   - `ttl   = tickInstant(tick) + ttlHorizonMs` — a fixed instant, so the signed
 *     bytes are reproducible *and* the Intent is unexpired when validated against
 *     the same virtual `now`.
 *
 * The result is still an *unsigned* input; the orchestrator signs and validates
 * it. `composeIntent` performs no I/O and is deterministic given the arc, the
 * agent, and the context.
 */

/** Inputs to {@link composeIntent}. */
export interface ComposeIntentArgs {
  readonly arc: DemoArc;
  readonly agent: SeedAgent;
  /** The read-only decision context for this tick. */
  readonly context: Context;
  /** Global tick ordinal (drives the nonce and the virtual clock). */
  readonly tickIndex: number;
  /** Tick interval in ms (`CONFIG.timing.tick_rate_ms`). */
  readonly tickRateMs: number;
  /**
   * When `true`, the agent's decision is replaced by the canned drain (the
   * orchestrator sets this at the scripted attack tick or on an operator
   * trigger). The drain size is the agent's current allocation.
   */
  readonly isAttack: boolean;
}

/** The virtual-clock ISO `ttl` for a tick: `tickInstant + ttlHorizon`. */
export function tickTtlIso(arc: DemoArc, tickIndex: number, tickRateMs: number): string {
  const instant = tickInstantMs(arc.baseTimeMs, tickIndex, tickRateMs);
  return new Date(instant + arc.ttlHorizonMs).toISOString();
}

/** The deterministic per-(agent, tick) nonce. */
export function tickNonce(agentId: string, tickIndex: number): string {
  return `${agentId}-${tickIndex}`;
}

export async function composeIntent(args: ComposeIntentArgs): Promise<UnsignedIntentInput> {
  const { arc, agent, context, tickIndex, tickRateMs, isAttack } = args;

  const proposed: UnsignedIntentInput = isAttack
    ? buildDrainIntent({
        agentId: agent.id,
        attackerAddress: arc.attack.attackerAddress,
        size: context.allocation,
      })
    : await agent.decide(context);

  // Harness authority: overwrite whatever nonce/ttl the strategy proposed with
  // the deterministic, virtual-clock-derived values.
  return {
    ...proposed,
    nonce: tickNonce(agent.id, tickIndex),
    ttl: tickTtlIso(arc, tickIndex, tickRateMs),
  };
}
