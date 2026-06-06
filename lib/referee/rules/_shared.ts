import { normalizeDecimal } from '@/lib/intent/canonical';
import type { Intent } from '@/lib/intent/types';

/**
 * Shared primitives for the policy rules. Kept tiny on purpose: each rule owns
 * its own decision logic; this module only holds the cross-cutting bits (address
 * comparison, building a clipped Intent) so they stay defined once.
 */

/**
 * Case-insensitive address equality. EVM addresses are case-insensitive
 * (mixed-case is only an EIP-55 checksum), so a whitelist match must not depend
 * on casing — otherwise a checksummed entry would fail to match its lowercase
 * form and a permitted destination would be wrongly rejected.
 */
export const eqAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** True iff `address` appears in `whitelist` (case-insensitive). */
export const isWhitelistedAddress = (address: string, whitelist: readonly string[]): boolean =>
  whitelist.some((entry) => eqAddress(entry, address));

/**
 * Return a copy of `intent` with one numeric field reduced to `value` (a config
 * cap). The cap is normalized to a canonical decimal string so the clipped
 * payload stays byte-consistent with the rest of the pipeline. The signature is
 * intentionally left as-is and is now stale — a clipped Intent is never
 * re-signed; the rail executes the post-clip parameters and the original
 * signature/hash survive for audit only (P1.1 §4.5).
 */
export function clipNumericField(
  intent: Intent,
  field: 'size' | 'leverage',
  value: number | string,
): Intent {
  return { ...intent, [field]: normalizeDecimal(value) } as Intent;
}
