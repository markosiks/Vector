/**
 * Shared router test helpers.
 *
 * Keep this file focused on utilities used across multiple router test suites
 * (unit, fuzz, integration, e2e). Centralising `amountUnits` here means a
 * change to `AMOUNT_SCALE` or the fixed-point format only needs one edit
 * instead of four.
 */

/**
 * Parse an amount string in 18-decimal-place fixed-point notation to exact
 * integer units. Mirrors the layout produced by `formatUnits(x, 18)`.
 *
 * Examples:
 *   amountUnits('1000000.000000000000000000') === 10n ** 24n
 *   amountUnits('0.000000000000000001')       === 1n
 */
export function amountUnits(a: string): bigint {
  const [i, f = ''] = a.split('.');
  return BigInt((i ?? '0') + f.padEnd(18, '0').slice(0, 18));
}
