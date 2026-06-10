import { NextResponse } from 'next/server';

import { checkDb } from '@/lib/db/client';
import { buildHealthPayload, healthStatusCode } from '@/lib/health';

/**
 * Health endpoint. Runs a real `SELECT 1` against Neon and reports liveness,
 * config-loaded status and the deployed commit. Always dynamic (never cached)
 * and on the Node.js runtime because it opens a database connection.
 *
 * C-01: commit is read from the validated `ENV` singleton, not `process.env`.
 * C-06: `configLoaded` reflects whether the `ENV`/`CONFIG` import succeeded;
 *       normally the import crash-exits before this route loads, but wrapping
 *       in try/catch makes the field observable and accurate in edge cases.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Eagerly attempt to import the validated ENV singleton. If the config layer is
// broken the import throws, which sets configLoaded=false in the health payload
// (rather than crashing silently). In the normal path this module-scope
// assignment completes before the first request arrives.
let configCommit: string | undefined;
let configLoaded = false;
try {
  const { ENV } = await import('@/lib/config/env');
  configCommit = ENV.GIT_COMMIT;
  configLoaded = true;
} catch {
  // Config import failed — we still serve a degraded health response.
}

export async function GET(): Promise<NextResponse> {
  const db = await checkDb();
  const payload = buildHealthPayload({ db, commit: configCommit, configLoaded });
  return NextResponse.json(payload, { status: healthStatusCode(db) });
}
