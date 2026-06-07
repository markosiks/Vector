/**
 * Exact fixed-point integer arithmetic for the capital router (§6.2).
 *
 * The pool is conserved on *integer* units (the smallest representable fraction
 * of the `numeric` column), never on floats: the router decides the *policy* in
 * floating-point weight space, but the conserved quantity — the per-agent
 * `amount` — is produced by {@link apportion}, a largest-remainder (Hamilton)
 * apportionment of the absolute weight vector onto the integer pool total. That
 * makes `Σ amount == pool_size` hold **by construction** on every pass, with no
 * rounding drift even across thousands of rounds, because each round apportions
 * the *absolute* target rather than accumulating signed deltas.
 */

/**
 * Convert a finite, non-negative decimal `value` to integer units at `scale`
 * decimal places, exactly (via its decimal string, never a binary float
 * multiply). E.g. `toUnits(1_000_000, 18)` is `10n ** 24n`.
 *
 * @throws RangeError on a non-finite, negative, or out-of-grid value.
 */
export function toUnits(value: number, scale: number): bigint {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`toUnits: value must be finite and >= 0, got ${value}`);
  }
  if (!Number.isInteger(scale) || scale < 0) {
    throw new RangeError(`toUnits: scale must be a non-negative integer, got ${scale}`);
  }
  // `toFixed` is deterministic and rounds to `scale` digits; the string is then
  // parsed exactly into a bigint, so no binary-float error reaches the units.
  const [intPart, fracPart = ''] = value.toFixed(scale).split('.');
  const frac = fracPart.padEnd(scale, '0').slice(0, scale);
  return BigInt(intPart + frac);
}

/**
 * Parse a (optionally signed) fixed-scale decimal string into integer units at
 * `scale`, **exactly** via its digits — never through a binary float, so a
 * 24-digit `numeric` amount round-trips without precision loss. Fractional
 * digits beyond `scale` are truncated.
 */
export function parseUnits(value: string, scale: number): bigint {
  if (!Number.isInteger(scale) || scale < 0) {
    throw new RangeError(`parseUnits: scale must be a non-negative integer, got ${scale}`);
  }
  const trimmed = value.trim();
  const negative = trimmed.startsWith('-');
  const magnitude = (negative ? trimmed.slice(1) : trimmed).replace(/^\+/, '');
  const dotParts = magnitude.split('.');
  const [intPart = '', fracPart = ''] = dotParts;
  if (dotParts.length > 2 || !/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart)) {
    throw new RangeError(`parseUnits: not a decimal string: ${value}`);
  }
  const frac = fracPart.padEnd(scale, '0').slice(0, scale);
  const units = BigInt((intPart || '0') + frac);
  return negative ? -units : units;
}

/**
 * Format integer `units` at `scale` decimal places back into a canonical
 * decimal string with exactly `scale` fractional digits (the stored
 * representation). `units` must be non-negative.
 */
export function formatUnits(units: bigint, scale: number): string {
  if (units < 0n) {
    throw new RangeError(`formatUnits: units must be >= 0, got ${units}`);
  }
  if (scale === 0) return units.toString();
  const s = units.toString().padStart(scale + 1, '0');
  const cut = s.length - scale;
  return `${s.slice(0, cut)}.${s.slice(cut)}`;
}

/**
 * Quantize the ratio `units / total` to a signed fixed-scale decimal string with
 * `scale` fractional digits, rounding half-up. Used to render an agent's weight
 * (`amount / pool`) and the signed `delta`. `total` must be positive.
 */
export function ratioToFixed(numerator: bigint, total: bigint, scale: number): string {
  if (total <= 0n) {
    throw new RangeError(`ratioToFixed: total must be > 0, got ${total}`);
  }
  const sign = numerator < 0n ? '-' : '';
  const abs = numerator < 0n ? -numerator : numerator;
  const pow = 10n ** BigInt(scale);
  // Round half-up: (abs·10^scale + total/2) / total.
  const scaled = (abs * pow + total / 2n) / total;
  return sign + formatUnits(scaled, scale);
}

/**
 * Subtract two fixed-scale decimal strings exactly and re-render at `scale`.
 * Both inputs must already be at (or within) `scale` digits; the result is the
 * signed difference, used for `delta = target_weight − prev_weight`.
 */
export function subtractFixed(a: string, b: string, scale: number): string {
  const diff = parseUnits(a, scale) - parseUnits(b, scale);
  const sign = diff < 0n ? '-' : '';
  const abs = diff < 0n ? -diff : diff;
  return sign + formatUnits(abs, scale);
}

/**
 * Largest-remainder (Hamilton) apportionment of `total` integer units across the
 * given non-negative `weights`, returning integer parts that sum **exactly** to
 * `total`. Negative or non-finite weights are clamped to `0`; an all-zero (or
 * empty-mass) weight vector apportions `total` as evenly as possible.
 *
 * Determinism: leftover units (the rounding remainder) are awarded to the
 * largest fractional remainders, ties broken by ascending index, so a fixed
 * input yields a bit-identical apportionment on every run.
 */
export function apportion(weights: readonly number[], total: bigint): bigint[] {
  const n = weights.length;
  if (total < 0n) {
    throw new RangeError(`apportion: total must be >= 0, got ${total}`);
  }
  if (n === 0) {
    if (total !== 0n) {
      throw new RangeError('apportion: cannot distribute a positive total across zero agents');
    }
    return [];
  }

  // Clamp to a non-negative mass; fall back to a uniform vector when there is no
  // mass to distribute (all weights zero/negative), so the pool still conserves.
  const SCALE = 1_000_000_000; // 1e9: integer numerator resolution for the ratios.
  const clamped = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const mass = clamped.reduce((acc, w) => acc + w, 0);
  const ratios = mass > 0 ? clamped.map((w) => w / mass) : clamped.map(() => 1 / n);

  let numer = ratios.map((r) => BigInt(Math.round(r * SCALE)));
  let denom = numer.reduce((acc, x) => acc + x, 0n);
  if (denom === 0n) {
    // Degenerate rounding (e.g. n huge): force a uniform integer numerator.
    numer = numer.map(() => 1n);
    denom = BigInt(n);
  }

  // Integer floor part and its remainder per agent (`product mod denom`).
  const parts = numer.map((x) => {
    const product = x * total;
    const base = product / denom;
    return { base, remainder: product - base * denom };
  });

  const assigned = parts.reduce((acc, p) => acc + p.base, 0n);
  const leftover = Number(total - assigned); // in [0, n) by construction

  // Award the leftover units to the largest remainders; ties → lower index.
  const winners = new Set(
    parts
      .map((p, i) => ({ i, remainder: p.remainder }))
      .sort((a, b) =>
        a.remainder !== b.remainder ? (a.remainder > b.remainder ? -1 : 1) : a.i - b.i,
      )
      .slice(0, leftover)
      .map((x) => x.i),
  );

  return parts.map((p, i) => (winners.has(i) ? p.base + 1n : p.base));
}
