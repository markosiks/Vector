import 'server-only';

import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

import { ENV } from '@/lib/config/env';
import { ForbiddenError, UnauthorizedError } from '@/lib/api/errors';

import { deriveSessionToken, verifyOperatorToken, verifySessionToken } from './token';

/**
 * Server-only operator-console authentication (P2.4).
 *
 * Access model: a single shared `OPERATOR_CONSOLE_TOKEN` (validated, server-only
 * {@link ENV}). The operator proves knowledge of it once at login; the server
 * then stores an httpOnly, SameSite=Strict session cookie carrying only
 * `sha256(token)` (never the raw secret). Every mutating `/api/operator/*` route
 * re-verifies that cookie before acting. The pure comparison/derivation lives in
 * `token.ts`; this module owns only the ENV + cookie wiring.
 *
 * Fail-closed: when no token is configured the console is *disabled* — login and
 * every mutation answer `403 operator_disabled` and the page renders a disabled
 * notice. There is no "open" fallback that would expose the kill-switch/attack
 * controls without an explicitly configured secret.
 */

/** The operator session cookie name. */
export const OPERATOR_COOKIE = 'vector_operator';

/** Session lifetime: 8 hours, then re-login. */
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

/** Whether the operator console is enabled (a token is configured). */
export function isOperatorConfigured(): boolean {
  return typeof ENV.OPERATOR_CONSOLE_TOKEN === 'string' && ENV.OPERATOR_CONSOLE_TOKEN.length > 0;
}

/** Verify a presented raw token at login (constant time, fail-closed). */
export function verifyLoginToken(presented: unknown): boolean {
  return verifyOperatorToken(presented, ENV.OPERATOR_CONSOLE_TOKEN);
}

/** The opaque session value to store after a successful login. */
export function sessionCookieValue(): string {
  // `isOperatorConfigured()` is the caller's precondition; assert it so a
  // misuse fails loudly rather than deriving a digest of `undefined`.
  const token = ENV.OPERATOR_CONSOLE_TOKEN;
  if (typeof token !== 'string' || token.length === 0) {
    throw new ForbiddenError();
  }
  return deriveSessionToken(token);
}

/** Cookie attributes for the session cookie (shared by set/clear). */
function baseCookieAttrs(): {
  httpOnly: true;
  sameSite: 'strict';
  secure: boolean;
  path: string;
} {
  return {
    httpOnly: true,
    sameSite: 'strict',
    // Secure in production; relaxed for local http dev so the cookie is usable.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  };
}

/** Cookie options for a freshly issued session. */
export function sessionCookieOptions(): ReturnType<typeof baseCookieAttrs> & { maxAge: number } {
  return { ...baseCookieAttrs(), maxAge: SESSION_MAX_AGE_SECONDS };
}

/** Cookie options that immediately expire the session (logout). */
export function clearCookieOptions(): ReturnType<typeof baseCookieAttrs> & { maxAge: number } {
  return { ...baseCookieAttrs(), maxAge: 0 };
}

/** Whether a request carries a valid operator session cookie. */
export function isAuthenticatedRequest(req: NextRequest): boolean {
  const cookie = req.cookies.get(OPERATOR_COOKIE)?.value;
  return verifySessionToken(cookie, ENV.OPERATOR_CONSOLE_TOKEN);
}

/**
 * Gate a mutating operator route. Throws {@link ForbiddenError} (403) when the
 * console is disabled and {@link UnauthorizedError} (401) when the session
 * cookie is missing or invalid; returns normally only for an authenticated
 * operator. Both are {@link ApiError}s, so `route()` maps them to safe responses.
 */
export function requireOperator(req: NextRequest): void {
  if (!isOperatorConfigured()) throw new ForbiddenError();
  if (!isAuthenticatedRequest(req)) throw new UnauthorizedError();
}

/**
 * Server-component read of the session state (for `app/operator/page.tsx`).
 * Reads the cookie via `next/headers` rather than a request object.
 */
export async function isAuthenticatedServer(): Promise<boolean> {
  const store = await cookies();
  const cookie = store.get(OPERATOR_COOKIE)?.value;
  return verifySessionToken(cookie, ENV.OPERATOR_CONSOLE_TOKEN);
}
