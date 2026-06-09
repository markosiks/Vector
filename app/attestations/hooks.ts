'use client';

import { useEffect, useState } from 'react';
import useSWRInfinite from 'swr/infinite';

import type { AttestationDto } from '@/lib/api/dto';
import type { Page } from '@/lib/api/respond';
import { CONFIG } from '@/lib/config/constants';
import type { ChainState } from '@/lib/db/schema';

/**
 * Client data layer for the Attestation Log (P2.3).
 *
 * The feed is keyset-paginated (P1.5): page 0 is the live head, deeper pages are
 * strictly-older windows pinned by `next_cursor`. We use `useSWRInfinite` so the
 * head *and* every loaded older page revalidate on the single app-wide
 * `ui_poll_ms` cadence (inherited from {@link import('../providers')}). That is
 * what makes the reconciliation honest: an `optimistic` row flips to `confirmed`
 * — or a `confirmed` row re-reconciles after a reorg — on whichever page it
 * lives, without a socket and without re-mounting the list.
 *
 * Rows are flattened and de-duplicated by `id`: as new attestations arrive at
 * the head, a row can briefly straddle a page boundary between polls, and the
 * keyset guarantees no gap but can transiently surface the boundary row twice.
 */

/** Page size for each request; the API clamps anything out of `1..200`. */
const PAGE_LIMIT = 50;
/**
 * Hard cap on how many pages "Load older" will accumulate, so an unbounded walk
 * of a very long history can never exhaust the tab's memory. At the cap the UI
 * stops offering more and says so.
 */
const MAX_PAGES = 40;

/** The chain-state filter, including the "all states" pseudo-value. */
export type StateFilter = ChainState | 'all';

export interface AttestationFeed {
  readonly attestations: readonly AttestationDto[];
  readonly error: unknown;
  readonly isLoading: boolean;
  readonly isLoadingMore: boolean;
  /** More older rows may exist and we are under the page cap. */
  readonly hasMore: boolean;
  /** We stopped paging because the render cap was reached, not the end of data. */
  readonly atPageCap: boolean;
  readonly loadMore: () => void;
}

/**
 * A clock that advances on the app poll cadence, for liveness checks like
 * "is this optimistic row stuck?". It is `null` until mount so the server and
 * the first client paint agree (no hydration mismatch from `new Date()`), then
 * ticks every `ui_poll_ms` in lockstep with the data it qualifies.
 */
export function useNow(): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), CONFIG.timing.ui_poll_ms);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** Build the request URL for page `pageIndex`, or `null` to stop paging. */
function makeGetKey(filter: StateFilter, limit: number) {
  return (pageIndex: number, previous: Page<AttestationDto> | null): string | null => {
    // Stop once the previous page was terminal (a short page → no cursor).
    if (previous && previous.next_cursor === null) return null;
    const params = new URLSearchParams({ limit: String(limit) });
    if (filter !== 'all') params.set('chain_state', filter);
    if (pageIndex > 0) {
      if (!previous?.next_cursor) return null;
      params.set('cursor', previous.next_cursor);
    }
    return `/api/attestations?${params.toString()}`;
  };
}

/**
 * The live attestation feed for `filter`, with keyset "Load older" paging. The
 * filter is part of the SWR key, so switching it transparently re-keys the cache
 * to the new state's pages.
 */
export function useAttestationFeed(filter: StateFilter, limit = PAGE_LIMIT): AttestationFeed {
  const { data, error, size, setSize, isLoading, isValidating } = useSWRInfinite<
    Page<AttestationDto>
  >(makeGetKey(filter, limit), { revalidateFirstPage: true, parallel: false });

  const seen = new Set<string>();
  const attestations: AttestationDto[] = [];
  for (const page of data ?? []) {
    for (const a of page.data) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      attestations.push(a);
    }
  }

  const lastPage = data && data.length > 0 ? data[data.length - 1] : undefined;
  const endReached = lastPage ? lastPage.next_cursor === null : false;
  const atPageCap = size >= MAX_PAGES;
  // We have requested more pages than have resolved → an older page is loading.
  const isLoadingMore = isValidating && data !== undefined && size > data.length;

  return {
    attestations,
    error,
    isLoading,
    isLoadingMore,
    hasMore: !endReached && !atPageCap,
    atPageCap: atPageCap && !endReached,
    loadMore: () => void setSize(size + 1),
  };
}
