import { NextResponse } from 'next/server';

import { checkDb } from '@/lib/db/client';
import { buildHealthPayload, healthStatusCode } from '@/lib/health';

/**
 * Health endpoint. Runs a real `SELECT 1` against Neon and reports liveness,
 * config-loaded status and the deployed commit. Always dynamic (never cached)
 * and on the Node.js runtime because it opens a database connection.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  const db = await checkDb();
  const payload = buildHealthPayload({ db, commit: process.env.GIT_COMMIT });
  return NextResponse.json(payload, { status: healthStatusCode(db) });
}
