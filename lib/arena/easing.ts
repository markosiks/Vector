/**
 * Pure easing and timing helpers for the Arena animations.
 *
 * Nothing here touches the DOM or the clock; every function is a total map from
 * numbers to numbers, so the animation logic is unit-testable in isolation and
 * the components stay thin. Durations are derived from the seeded config
 * (`router.max_step`, `timing.ui_poll_ms`) so retuning the demo in one file
 * retimes every transition — the same single-source rule the rest of Vector
 * follows.
 */

/** Clamp to the closed unit interval, mapping `NaN` to `0`. */
export function clamp01(t: number): number {
  if (Number.isNaN(t)) return 0;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t;
}

/** Standard ease-in-out cubic on `[0, 1]`; values outside are clamped first. */
export function easeInOutCubic(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** Bounds for a capital-flow transition, in milliseconds. */
const MIN_FLOW_MS = 250;
const MAX_FLOW_MS = 1_200;

/**
 * Duration of a capital-flow transition, scaled by how big the move is relative
 * to the router's `max_step` (the largest fraction of the pool one reallocation
 * may move). A full `max_step` move takes ~80% of the poll interval so it reads
 * as a deliberate transfer yet always settles before the next poll could start a
 * new one; a tiny move is quick. The result is clamped to `[250, 1200]` ms so
 * neither a dust move nor a malformed huge `fraction` produces a jarring or
 * unbounded animation.
 *
 * @param fraction signed or unsigned change as a fraction of the pool
 * @param timing the seeded `router.max_step` and `timing.ui_poll_ms` values
 */
export function flowDurationMs(
  fraction: number,
  timing: { readonly maxStep: number; readonly pollMs: number },
): number {
  const { maxStep, pollMs } = timing;
  const ceiling = Math.min(MAX_FLOW_MS, Math.round(pollMs * 0.8));
  if (!Number.isFinite(fraction) || maxStep <= 0) return MIN_FLOW_MS;
  const ratio = clamp01(Math.abs(fraction) / maxStep);
  const span = Math.max(0, ceiling - MIN_FLOW_MS);
  return MIN_FLOW_MS + Math.round(span * ratio);
}
