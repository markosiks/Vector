'use client';

import type { ReactNode } from 'react';
import useSWR from 'swr';

import type { HealthPayload } from '@/lib/health';

import styles from './health.module.css';

/**
 * Health screen. Polls `/api/health` at the app-wide SWR cadence (configured in
 * `providers.tsx` from the seeded config) and renders the live database state
 * in the app-wide dark theme.
 */
export default function HealthPage(): ReactNode {
  const { data, error, isLoading } = useSWR<HealthPayload>('/api/health');

  return (
    <main className={styles.screen}>
      <div className={styles.inner}>
        <h1 className={styles.title}>Health</h1>
        <p className={styles.subtitle}>
          Live <span className={styles.mono}>/api/health</span> probe — database liveness, config,
          and the deployed commit.
        </p>

        {isLoading && <p className={styles.hint}>Checking…</p>}
        {error && <p className={styles.error}>Probe error: {String(error)}</p>}
        {data && (
          <dl className={styles.card}>
            <div>
              <dt>Status</dt>
              <dd>
                <span className={`${styles.pill} ${data.ok ? styles.pillUp : styles.pillDown}`}>
                  <span className={styles.pillDot} aria-hidden="true" />
                  {data.ok ? 'operational' : 'degraded'}
                </span>
              </dd>
            </div>
            <div>
              <dt>Database</dt>
              <dd>
                <span
                  className={`${styles.pill} ${data.db === 'up' ? styles.pillUp : styles.pillDown}`}
                >
                  <span className={styles.pillDot} aria-hidden="true" />
                  {data.db}
                </span>
              </dd>
            </div>
            <div>
              <dt>Config loaded</dt>
              <dd>{String(data.config_loaded)}</dd>
            </div>
            <div>
              <dt>Commit</dt>
              <dd>
                <span className={styles.mono}>{data.commit}</span>
              </dd>
            </div>
          </dl>
        )}
      </div>
    </main>
  );
}
