/**
 * The deterministic demo spine (architecture.txt §6.5): drives the frozen seed
 * arc through the real referee → scoring → router pipeline on a seeded execution
 * rail, producing a byte-reproducible end-to-end run (signal → decide → intent →
 * referee → execution → outcome → score → [attestation seam] → capital re-route).
 * See `docs/demo-spine.md`.
 */

export {
  planTicks,
  roundCount,
  arcDurationMs,
  tickInstantMs,
  type SchedulerTiming,
  type TickPlan,
} from './scheduler';
export { composeIntent, tickNonce, tickTtlIso, type ComposeIntentArgs } from './compose';
export { buildDrainIntent, type DrainIntentParams } from './attack';
export {
  createSeedRail,
  settleWithFallback,
  type Rail,
  type RailFill,
  type RailRequest,
} from './rail';
export { armAttack, consumeAttackArm, isAttackArmed, resetAttackArm } from './control';
export { setupArc, ensureRound, type ArcSetup, type SetupArcOptions } from './setup';
export {
  runArc,
  type ArcAllocation,
  type RunArcHooks,
  type RunArcOptions,
  type RunArcResult,
} from './orchestrator';
export { nansenSignalsFor } from './signals';
