'use client';

import { useState, type ReactNode } from 'react';

import { isStuckOptimistic } from '@/lib/credibility/chain-state';
import { AttestationRow } from './AttestationRow';
import { useAttestationFeed, useNow, type StateFilter } from './hooks';
import styles from './attestations.module.css';

const FILTERS: readonly { value: StateFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'optimistic', label: 'Optimistic' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'failed', label: 'Failed' },
];

/**
 * The Attestation Log (P2.3): the ERC-8004 mirror as an honest reconciliation
 * feed. It polls the keyset head at the single app cadence, so an `optimistic`
 * row visibly flips to `confirmed` (or `failed`) in place; older history loads
 * on demand and keeps polling too, so a reorg re-reconcile shows wherever it
 * lands. The screen degrades gracefully: a feed error shows a banner without
 * tearing down already-loaded rows.
 */
export function Attestations(): ReactNode {
  const [filter, setFilter] = useState<StateFilter>('all');
  const { attestations, error, isLoading, isLoadingMore, hasMore, atPageCap, loadMore } =
    useAttestationFeed(filter);
  const now = useNow();

  return (
    <main className={styles.screen}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Attestation Log</h1>
          <p className={styles.subtitle}>
            ERC-8004 reputation attestations on Mantle Sepolia — optimistic writes reconciling to
            on-chain confirmation.
          </p>
        </div>
        <nav className={styles.filters} aria-label="Filter by chain state">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`${styles.filterBtn} ${filter === f.value ? styles.filterActive : ''}`}
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
              data-testid={`filter-${f.value}`}
            >
              {f.label}
            </button>
          ))}
        </nav>
      </header>

      {error ? (
        <p className={`${styles.state} ${styles.error}`} role="alert">
          Attestation feed unavailable — retrying…
        </p>
      ) : null}

      {isLoading && attestations.length === 0 ? (
        <p className={styles.state}>Loading attestations…</p>
      ) : attestations.length === 0 && !error ? (
        <p className={styles.state} data-testid="attestations-empty">
          No attestations {filter === 'all' ? 'yet' : `in “${filter}”`}.
        </p>
      ) : (
        <ol className={styles.list} data-testid="attestation-list">
          {attestations.map((a) => (
            <AttestationRow
              key={a.id}
              attestation={a}
              stuck={now !== null && isStuckOptimistic(a, now)}
            />
          ))}
        </ol>
      )}

      {attestations.length > 0 ? (
        <div className={styles.footer}>
          {hasMore ? (
            <button
              type="button"
              className={styles.loadMore}
              onClick={loadMore}
              disabled={isLoadingMore}
              data-testid="load-more"
            >
              {isLoadingMore ? 'Loading…' : 'Load older'}
            </button>
          ) : atPageCap ? (
            <span className={styles.muted}>History capped — narrow by state to see more.</span>
          ) : (
            <span className={styles.muted}>End of history.</span>
          )}
        </div>
      ) : null}
    </main>
  );
}
