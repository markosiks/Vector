'use client';

import type { ReactNode } from 'react';
import useSWR from 'swr';

import type { HealthPayload } from '@/lib/health';

/**
 * Health screen. Polls `/api/health` at the app-wide SWR cadence (configured in
 * `providers.tsx` from the seeded config) and renders the live database state.
 */
export default function HealthPage(): ReactNode {
  const { data, error, isLoading } = useSWR<HealthPayload>('/api/health');

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', lineHeight: 1.5 }}>
      <h1>Health</h1>
      {isLoading && <p>Checking…</p>}
      {error && <p>Probe error: {String(error)}</p>}
      {data && (
        <ul>
          <li>ok: {String(data.ok)}</li>
          <li>db: {data.db}</li>
          <li>config_loaded: {String(data.config_loaded)}</li>
          <li>commit: {data.commit}</li>
        </ul>
      )}
    </main>
  );
}
