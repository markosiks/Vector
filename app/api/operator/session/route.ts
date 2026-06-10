import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { BadRequestError, TooManyRequestsError, UnauthorizedError } from '@/lib/api/errors';
import { RateLimiter } from '@/lib/api/rate-limit';
import { noContent, readJson, route } from '@/lib/api/respond';
import {
  OPERATOR_COOKIE,
  clearCookieOptions,
  sessionCookieOptions,
  sessionCookieValue,
  verifyLoginToken,
} from '@/lib/operator/auth';

/**
 * `POST /api/operator/session` — operator login. The body carries the shared
 * `OPERATOR_CONSOLE_TOKEN`; on a constant-time match the server issues an
 * httpOnly, SameSite=Strict session cookie (carrying only `sha256(token)`, never
 * the raw secret) and answers `204`. A wrong token or an unconfigured console
 * both answer `401` — a uniform status prevents an attacker from detecting
 * whether the console is enabled before mounting a brute-force (F-02).
 * Excessive attempts from one IP are rejected with `429` (F-01).
 *
 * `DELETE` clears the cookie (logout). SameSite=Strict already mitigates a
 * CSRF-logout attempt; the endpoint requires no authentication because clearing
 * a stale cookie is harmless and always desirable (F-09 design choice).
 *
 * Node runtime: `node:crypto` and the validated server-only `ENV` are required.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Bound the presented token: the configured `OPERATOR_CONSOLE_TOKEN` is itself
// capped at 4096 chars (env schema's MAX_URL_LEN), so anything longer can never
// match — reject it at the boundary instead of hashing an unbounded body.
const loginBody = z.object({ token: z.string().min(1).max(4096) }).strict();

/**
 * In-process sliding-window rate limiter for login attempts (F-01).
 * 5 attempts per 60 s per IP. Process-scoped: resets on cold start, which is
 * acceptable for a single-region operator endpoint. Replace with a Redis/Upstash
 * counter for multi-region deployments.
 */
const loginRateLimiter = new RateLimiter({ limit: 5, windowMs: 60_000 });

/** Extract the best-effort client IP from a Next.js request. */
function clientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  );
}

export function POST(req: NextRequest): Promise<Response> {
  return route(async () => {
    // Rate-limit before touching auth to avoid timing side-channels on whether
    // the console is configured (the rate limiter itself is timing-invariant).
    const ip = clientIp(req);
    if (!loginRateLimiter.check(ip)) {
      throw new TooManyRequestsError('Too many login attempts; try again later');
    }

    const parsed = loginBody.safeParse(await readJson(req));
    if (!parsed.success) {
      throw new BadRequestError('Expected a JSON body { token: string }', 'invalid_body');
    }

    // Return 401 for both "console not configured" and "wrong token" (F-02).
    // A uniform status prevents reconnaissance: an attacker cannot determine
    // whether the console is enabled by probing the login endpoint.
    if (!verifyLoginToken(parsed.data.token)) {
      throw new UnauthorizedError('Invalid operator token', 'invalid_token');
    }

    const res = noContent();
    res.cookies.set(OPERATOR_COOKIE, sessionCookieValue(), sessionCookieOptions());
    return res;
  });
}

export function DELETE(): Promise<Response> {
  return route(async () => {
    const res = noContent();
    // Clear regardless of configuration so a stale cookie is always removable.
    // SameSite=Strict already mitigates a CSRF-logout attempt; an attacker
    // cannot escalate from forcing a re-login (F-09 documented design choice).
    res.cookies.set(OPERATOR_COOKIE, '', clearCookieOptions());
    return res;
  });
}
