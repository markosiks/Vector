import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { BadRequestError, ForbiddenError, UnauthorizedError } from '@/lib/api/errors';
import { noContent, readJson, route } from '@/lib/api/respond';
import {
  OPERATOR_COOKIE,
  clearCookieOptions,
  isOperatorConfigured,
  sessionCookieOptions,
  sessionCookieValue,
  verifyLoginToken,
} from '@/lib/operator/auth';

/**
 * `POST /api/operator/session` — operator login. The body carries the shared
 * `OPERATOR_CONSOLE_TOKEN`; on a constant-time match the server issues an
 * httpOnly, SameSite=Strict session cookie (carrying only `sha256(token)`, never
 * the raw secret) and answers `204`. A wrong token is `401`; an unconfigured
 * console is `403`. `DELETE` clears the cookie (logout).
 *
 * Node runtime: `node:crypto` and the validated server-only `ENV` are required.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Bound the presented token: the configured `OPERATOR_CONSOLE_TOKEN` is itself
// capped at 4096 chars (env schema's MAX_URL_LEN), so anything longer can never
// match — reject it at the boundary instead of hashing an unbounded body.
const loginBody = z.object({ token: z.string().min(1).max(4096) }).strict();

export function POST(req: NextRequest): Promise<Response> {
  return route(async () => {
    if (!isOperatorConfigured()) throw new ForbiddenError();

    const parsed = loginBody.safeParse(await readJson(req));
    if (!parsed.success) {
      throw new BadRequestError('Expected a JSON body { token: string }', 'invalid_body');
    }
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
    res.cookies.set(OPERATOR_COOKIE, '', clearCookieOptions());
    return res;
  });
}
