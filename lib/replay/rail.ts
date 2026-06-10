import type { ExecutionStatus } from '@/lib/db/schema';
import type { Intent } from '@/lib/intent/types';
import type { SeedOutcome } from '@/seed';

/**
 * The execution-rail seam (architecture.txt §6.5 fallback note).
 *
 * The demo spine settles every allowed Intent through a {@link Rail}: in the
 * deterministic [CORE] path that is the *seed rail*, which returns the frozen
 * fill from the dataset. A live venue adapter (P2.1) can be injected later
 * behind the same interface. The orchestrator always holds the seed fill as a
 * **fallback**: if a live rail returns nothing or throws, the seeded outcome is
 * substituted so the arc never stalls — a silent, deterministic degradation
 * rather than a hung demo (§6.5: "empty/error rail ⇒ seeded outcomes").
 */

/** A rail's settlement of one Intent: the status to persist and the resulting outcome. */
export interface RailFill {
  /** Execution status for the `executions` row. */
  readonly status: ExecutionStatus;
  /** The realized outcome to persist (PnL, capital-at-risk, drawdown, …). */
  readonly outcome: SeedOutcome;
  /** Optional venue order id. */
  readonly rail_order_id?: string | null;
  /** Optional raw rail response, stored on the `executions` row for audit. */
  readonly response?: unknown;
}

/** What the rail is asked to settle. */
export interface RailRequest {
  readonly intent: Intent;
  /** Stable seed `agent_id`. */
  readonly agentId: string;
  /** Global tick ordinal (the seed rail keys its fill on this). */
  readonly tickIndex: number;
  /**
   * Canonical `intent_hash` of the Intent being settled. Required so every
   * call-site enforces idempotency: the live rail (P2.1) uses it as the
   * idempotency key so a retry never places a second order. The seed rail
   * ignores the value but the field is still required to ensure callers always
   * supply a hash (B-04 / B-01).
   */
  readonly intentHash: string;
}

/** An execution rail: settles an allowed Intent, or returns `null` to defer to fallback. */
export interface Rail {
  execute(request: RailRequest): Promise<RailFill | null>;
}

/** Build the deterministic seed rail backed by an arc's frozen fills. */
export function createSeedRail(fillFor: (agentId: string, tickIndex: number) => SeedOutcome): Rail {
  return {
    execute: ({ agentId, tickIndex }): Promise<RailFill | null> =>
      Promise.resolve({
        status: 'filled',
        outcome: fillFor(agentId, tickIndex),
        rail_order_id: `seed-${agentId}-${tickIndex}`,
      }),
  };
}

/**
 * Settle through `rail` if present, otherwise (or on an empty/error result) fall
 * back to the seeded fill so the arc always advances. The fallback is silent by
 * design — the demo degrades to deterministic seed data instead of surfacing a
 * rail outage mid-presentation — and is logged only at the caller's discretion.
 */
export async function settleWithFallback(
  rail: Rail | undefined,
  request: RailRequest,
  seedFill: RailFill,
): Promise<{ fill: RailFill; degraded: boolean }> {
  if (rail === undefined) return { fill: seedFill, degraded: false };
  try {
    const fill = await rail.execute(request);
    if (fill === null) return { fill: seedFill, degraded: true };
    return { fill, degraded: false };
  } catch {
    // Empty or throwing rail ⇒ deterministic seeded outcome; never stall.
    return { fill: seedFill, degraded: true };
  }
}
