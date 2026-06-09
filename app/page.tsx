import type { ReactNode } from 'react';

import { CONFIG } from '@/lib/config/constants';

/**
 * Minimal landing surface for the P0.1 skeleton. It reads a couple of values
 * straight from the seeded config to make the single-source wiring visible; the
 * real arena/leaderboard screens arrive in later stages.
 */
export default function HomePage(): ReactNode {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', lineHeight: 1.5 }}>
      <h1>Vector</h1>
      <p>The merit layer for autonomous capital on Mantle.</p>
      <ul>
        <li>
          Capital pool: {CONFIG.capital.pool_size.toLocaleString()}{' '}
          {CONFIG.capital.capital_unit_label}
        </li>
        <li>UI poll cadence: {CONFIG.timing.ui_poll_ms} ms</li>
        <li>Chain id: {CONFIG.chain.mantle_testnet_chain_id}</li>
      </ul>
      <p>
        <a href="/api/health">/api/health</a>
      </p>
      <p>
        Building an agent? <a href="/onboarding">Make it Vector-compatible →</a>
      </p>
    </main>
  );
}
