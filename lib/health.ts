/**
 * Pure helpers for the `/api/health` endpoint.
 *
 * Kept free of I/O so the mapping from database state to HTTP payload/status is
 * deterministic and unit-testable without a server or a database.
 */

/** Liveness of the Neon connection as observed by a `SELECT 1` probe. */
export type DbState = 'up' | 'down';

/** The JSON body returned by `/api/health`. */
export interface HealthPayload {
  /** Overall health: true iff the database probe succeeded. */
  ok: boolean;
  /** Result of the `SELECT 1` probe. */
  db: DbState;
  /** Whether the seeded config validated and loaded (always true once running). */
  config_loaded: boolean;
  /** Deployed commit SHA, or `'unknown'` when unset. */
  commit: string;
}

/** Build the health payload from observed state. `commit` is normalized. */
export function buildHealthPayload(params: {
  db: DbState;
  commit: string | undefined;
  configLoaded?: boolean;
}): HealthPayload {
  const commit = params.commit?.trim();
  return {
    ok: params.db === 'up',
    db: params.db,
    config_loaded: params.configLoaded ?? true,
    commit: commit && commit.length > 0 ? commit : 'unknown',
  };
}

/** HTTP status for a health payload: 200 when up, 503 when down. */
export function healthStatusCode(db: DbState): 200 | 503 {
  return db === 'up' ? 200 : 503;
}
