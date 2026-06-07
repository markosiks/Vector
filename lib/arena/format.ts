import { normalizeDecimal } from '../intent/canonical';

/**
 * Display formatting for the Arena screen.
 *
 * Every formatter here operates on the **exact decimal string** the read API
 * returns and never round-trips it through a JS `number`: a `numeric(38,18)`
 * allocation or a 39-digit value would lose its low-order digits the instant it
 * became a float. Grouping and fixed-precision are done by string surgery on the
 * canonical form from {@link normalizeDecimal}, so the displayed value is the
 * stored value — exactly.
 *
 * Formatting is intentionally **locale-independent** (ASCII thousands `,`, point
 * `.`): the demo must render byte-identically on any judge's machine, so a
 * deterministic format beats a locale-sensitive one here. That determinism is
 * the same property the seeded config and the replay arc are built on.
 */

/** Placeholder for a missing value (unfunded agent, absent score). */
export const EMPTY = '—';

/** Group an all-digits integer string with ASCII thousands separators. */
function groupThousands(intDigits: string): string {
  return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Split a canonical decimal into sign, integer, and fraction parts.
 * `normalizeDecimal` guarantees an optional leading `-`, then digits, an optional
 * `.`, then digits — with no exponent and no superfluous leading zeros.
 */
function parts(canonical: string): { sign: string; int: string; frac: string } {
  const sign = canonical.startsWith('-') ? '-' : '';
  const body = sign ? canonical.slice(1) : canonical;
  const dot = body.indexOf('.');
  if (dot === -1) return { sign, int: body, frac: '' };
  return { sign, int: body.slice(0, dot), frac: body.slice(dot + 1) };
}

/**
 * Format a capital amount for display: thousands-grouped integer part and up to
 * `fractionDigits` fractional places, **truncated** (not rounded) so the shown
 * value is always a true prefix of the stored value — no float, no rounding that
 * could imply a balance the ledger does not hold. `null` renders as {@link EMPTY}.
 *
 * @param value exact decimal string (or `null`)
 * @param fractionDigits trailing places to keep (default `2`, `0` for whole units)
 */
export function formatCapital(value: string | null, fractionDigits = 2): string {
  if (value === null) return EMPTY;
  const { sign, int, frac } = parts(normalizeDecimal(value));
  const grouped = groupThousands(int);
  if (fractionDigits <= 0) return `${sign}${grouped}`;
  const kept = frac.slice(0, fractionDigits).padEnd(fractionDigits, '0');
  return `${sign}${grouped}.${kept}`;
}

/**
 * Format an AgentScore (0–100) to a fixed number of decimals. Truncates on the
 * canonical string for the same precision-safety reason as {@link formatCapital};
 * a score never exceeds three significant integer digits, but the path is shared
 * so the rule "displayed value ⊆ stored value" holds everywhere.
 */
export function formatScore(value: string, fractionDigits = 1): string {
  const { sign, int, frac } = parts(normalizeDecimal(value));
  if (fractionDigits <= 0) return `${sign}${int}`;
  const kept = frac.slice(0, fractionDigits).padEnd(fractionDigits, '0');
  return `${sign}${int}.${kept}`;
}

/**
 * Truncate an over-long display name to `max` characters with an ellipsis, so a
 * hostile or accidental 500-char name can never break the row layout on the
 * projector. Names at or under the budget are returned unchanged.
 */
export function truncateName(name: string, max = 28): string {
  const chars = [...name];
  if (chars.length <= max) return name;
  return `${chars.slice(0, max - 1).join('')}…`;
}
