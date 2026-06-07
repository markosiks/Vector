'use client';

import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';

import type { LeaderboardDto, PolicyEventDto } from '@/lib/api/dto';
import type { Page } from '@/lib/api/respond';

/**
 * Client data + helper hooks for the Arena screen.
 *
 * Both feeds poll at the single app-wide `ui_poll_ms` cadence configured in
 * `app/providers.tsx` (sourced from the seeded config) — no sockets, no
 * `fetch` in `useEffect`. We pass no per-hook `refreshInterval` so the cadence
 * stays in exactly one place; changing it there retunes the whole screen.
 */

/** The current leaderboard: ranked agents, their allocations, and round status. */
export function useLeaderboard(): {
  data: LeaderboardDto | undefined;
  error: unknown;
  isLoading: boolean;
} {
  const { data, error, isLoading } = useSWR<LeaderboardDto>('/api/leaderboard');
  return { data, error, isLoading };
}

/** The head page of the policy-event red-alert feed (newest first). */
export function usePolicyFeed(limit = 50): {
  data: Page<PolicyEventDto> | undefined;
  error: unknown;
  isLoading: boolean;
} {
  const { data, error, isLoading } = useSWR<Page<PolicyEventDto>>(
    `/api/policy-events?limit=${limit}`,
  );
  return { data, error, isLoading };
}

/**
 * The previous settled value of `current`, for diffing one poll against the last.
 * Updates only when `current` is defined, so a transient `undefined` between
 * revalidations never wipes the baseline the animations diff against.
 */
export function usePrevious<T>(current: T | undefined): T | undefined {
  const prev = useRef<T | undefined>(undefined);
  const settled = useRef<T | undefined>(undefined);
  useEffect(() => {
    if (current !== undefined) {
      prev.current = settled.current;
      settled.current = current;
    }
  }, [current]);
  return prev.current;
}

/**
 * `true` when the user asked the OS to reduce motion. Read once on mount and kept
 * live via a media-query listener, so the screen can fall back to instant,
 * non-animated state changes for accessibility without a reload.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent): void => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}
