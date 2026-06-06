'use client';

import type { ReactNode } from 'react';
import { SWRConfig } from 'swr';

import { CONFIG } from '@/lib/config/constants';

/**
 * Default SWR fetcher: GET the URL and parse JSON. A non-2xx response throws so
 * SWR surfaces it as an error rather than caching a failure body.
 */
async function fetcher<T>(resource: string): Promise<T> {
  const response = await fetch(resource);
  if (!response.ok) {
    throw new Error(`Request to ${resource} failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}

/**
 * App-wide data layer. All live screens poll read endpoints at the single
 * `ui_poll_ms` cadence from the seeded config — no sockets (architecture.txt
 * §7.3, §11). The interval is sourced from {@link CONFIG}, never hardcoded, so
 * changing it in one file retunes every screen.
 */
export function Providers({ children }: { children: ReactNode }): ReactNode {
  return (
    <SWRConfig
      value={{
        fetcher,
        refreshInterval: CONFIG.timing.ui_poll_ms,
        dedupingInterval: CONFIG.timing.ui_poll_ms,
        revalidateOnFocus: false,
      }}
    >
      {children}
    </SWRConfig>
  );
}
