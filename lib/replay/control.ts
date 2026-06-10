/**
 * Operator control for the demo spine — the minimal "fire the attack" trigger
 * (architecture.txt §6.5; the full operator console is P2.4).
 *
 * The deterministic arc already scripts the attack at `arc.attack.atTick`, so a
 * hands-off replay is fully reproducible. This module adds a manual override: an
 * operator can *arm* the drain so it fires on the target agent's next tick,
 * regardless of the scripted timing. It is a process-local, single-instance
 * latch — honest for a one-process demo server — and is deliberately **not** the
 * source of determinism (the scripted tick is). A multi-instance deployment
 * would back this with a shared store; that is out of scope for the spine.
 */

/**
 * An injectable attack latch. Scoping this to `RunArcOptions` keeps the
 * module-level singleton correct for the single-process demo while enabling
 * independent instances in tests and future multi-tenant deployments (R-03).
 */
export interface AttackLatch {
  /** Atomically read-and-clear the latch; returns true if it was armed. */
  consume(): boolean;
}

let armed = false;

/** Arm the drain: the target agent's next processed tick becomes an attack. */
export function armAttack(): void {
  armed = true;
}

/** Whether the drain is currently armed (non-consuming read). */
export function isAttackArmed(): boolean {
  return armed;
}

/** Atomically read-and-clear the arm latch (fires exactly once). */
export function consumeAttackArm(): boolean {
  const was = armed;
  armed = false;
  return was;
}

/** Reset the latch (test isolation / between runs). */
export function resetAttackArm(): void {
  armed = false;
}
