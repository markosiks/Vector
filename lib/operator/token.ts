import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Operator-token comparison — the pure security core of the operator console
 * (P2.4), free of any `server-only` guard or ENV/cookie wiring so it can be
 * unit/fuzz tested directly. The eager, server-only ENV/cookie loader lives in
 * `auth.ts`.
 *
 * Security invariants:
 * - The comparison is **constant-time** (`crypto.timingSafeEqual`) so a caller
 *   cannot recover the configured token byte-by-byte from response timing.
 * - It is *length-safe*: `timingSafeEqual` throws on a length mismatch, which
 *   itself leaks the length, so we first compare byte-lengths in constant time
 *   (and only then the contents). The early length check is unavoidable but is
 *   itself constant-time and never branches on content.
 * - No value (presented or configured) is ever returned, thrown, or logged: the
 *   result is a single boolean.
 */

/**
 * Constant-time equality for two UTF-8 secrets. Returns `false` (never throws)
 * for any non-string input or any length mismatch, and compares contents in
 * constant time only when the lengths already match.
 */
export function constantTimeEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // A length mismatch is a clean `false`. `timingSafeEqual` requires equal
  // lengths (it throws otherwise); guarding here keeps the call total. The
  // length comparison leaks only the *length*, never the bytes.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify a presented operator token against the configured one.
 *
 * Fail-closed: when no token is configured (`configured` is `undefined`/empty)
 * the console is disabled, so *every* presented token is rejected — there is no
 * "open" mode. A present token is accepted only on an exact match.
 *
 * The comparison runs over the **sha256 digests** of both sides (as the session
 * path already does), not the raw strings. Digests are always 64 hex chars, so
 * the length-mismatch branch of `constantTimeEqual` can never fire on the login
 * path: a wrong guess no longer leaks the configured token's byte length through
 * timing. Correctness is unchanged — `sha256(a) === sha256(b) ⇔ a === b` for the
 * relevant input space (a sha256 collision is not a practical attack).
 */
export function verifyOperatorToken(presented: unknown, configured: string | undefined): boolean {
  if (typeof configured !== 'string' || configured.length === 0) return false;
  if (typeof presented !== 'string') return false;
  return constantTimeEqual(deriveSessionToken(presented), deriveSessionToken(configured));
}

/**
 * Derive the opaque session value stored in the operator cookie from the raw
 * token: `sha256(token)` as lowercase hex. The raw secret therefore never sits
 * in a cookie — the cookie carries only a one-way digest, which is validated by
 * re-deriving the same digest from the configured token and comparing in
 * constant time. (It is still a bearer credential, as any shared-secret session
 * is, but a leaked cookie does not reveal the token itself.)
 */
export function deriveSessionToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Validate a cookie's session value against the configured token. Fail-closed:
 * an unconfigured console rejects every cookie. The comparison is constant-time
 * over the derived digests.
 */
export function verifySessionToken(cookieValue: unknown, configured: string | undefined): boolean {
  if (typeof configured !== 'string' || configured.length === 0) return false;
  if (typeof cookieValue !== 'string' || cookieValue.length === 0) return false;
  return constantTimeEqual(cookieValue, deriveSessionToken(configured));
}
