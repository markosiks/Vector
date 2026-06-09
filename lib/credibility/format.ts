import { formatCapital, EMPTY } from '@/lib/arena/format';
import { compareDecimal } from '@/lib/intent/canonical';

/**
 * Display helpers specific to the credibility screens, layered on the Arena's
 * precision-safe {@link formatCapital} (which truncates a decimal *string* and
 * never routes it through a float).
 */

/**
 * Format a signed value (PnL, position delta) with an explicit leading sign so a
 * gain and a loss are distinguishable at a glance. Zero and `null` carry no sign.
 * Built on {@link formatCapital}, so the magnitude is still an exact truncated
 * prefix of the stored decimal — never a rounded float.
 */
export function formatSignedCapital(value: string | null, fractionDigits = 2): string {
  if (value === null) return EMPTY;
  const base = formatCapital(value, fractionDigits);
  if (base === EMPTY || base.startsWith('-')) return base;
  // Positive magnitudes get a `+`; a true zero stays unsigned.
  return compareDecimal(value, 0) > 0 ? `+${base}` : base;
}

/**
 * Format an ISO-8601 timestamp for display as `YYYY-MM-DD HH:MM:SSZ` (UTC).
 * Deliberately **locale-independent** and UTC-pinned (like the Arena formatters)
 * so the demo renders byte-identically on any judge's machine and a cross-page
 * sort never disagrees with the server's `created_at DESC` order. An unparseable
 * value returns {@link EMPTY} rather than `Invalid Date`.
 */
export function formatTimestamp(iso: string | null): string {
  if (iso === null) return EMPTY;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return EMPTY;
  return new Date(ms)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, 'Z');
}

/** Format a `[0, 1]`-ish factor (perf, w) as a fixed 3-decimal display number. */
export function formatFactor(value: number): string {
  if (!Number.isFinite(value)) return EMPTY;
  return value.toFixed(3);
}

/**
 * Format a point-scale term (policy, drawdown, the reconstructed raw) with up to
 * two decimals and a leading sign when `signed`. These are explainability
 * numbers (already float in `components_json`), not ledger money, so a plain
 * fixed-precision render is correct here.
 */
export function formatPoints(value: number, signed = false): string {
  if (!Number.isFinite(value)) return EMPTY;
  const fixed = trimZeros(value.toFixed(2));
  if (!signed || value <= 0) return fixed;
  return `+${fixed}`;
}

/**
 * Format an ERC-8004 attestation `value` (a Solidity `int128` integer string)
 * scaled by its `value_decimals`, the way the registry stores a fixed-point
 * number. Vector anchors an integer AgentScore (`value_decimals = 0`), but the
 * column allows a scale, so we shift the decimal point by string surgery —
 * never `Number(value) / 10**decimals`, which would corrupt a 39-digit value.
 * A non-integer or negative-scale input is returned unchanged (never throws).
 */
export function formatAttestationValue(value: string, decimals: number): string {
  if (!/^-?\d+$/.test(value) || !Number.isInteger(decimals)) return value;
  if (decimals <= 0) return formatCapital(value, 0);
  const neg = value.startsWith('-');
  const digits = neg ? value.slice(1) : value;
  const padded = digits.padStart(decimals + 1, '0');
  const intPart = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals);
  return formatCapital(`${neg ? '-' : ''}${intPart}.${frac}`, decimals);
}

/** Drop trailing zeros / a bare decimal point from a fixed string (`1.50`→`1.5`). */
function trimZeros(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}
