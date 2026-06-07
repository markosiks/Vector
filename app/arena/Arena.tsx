'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { CONFIG } from '@/lib/config/constants';
import {
  deriveFlows,
  deriveScoreChanges,
  flowDurationMs,
  rankAgents,
  selectFlashes,
  summarizeFlashes,
  type AgentSnapshot,
} from '@/lib/arena';
import { useLeaderboard, usePolicyFeed, usePrevious, useReducedMotion } from './hooks';
import { Leaderboard } from './Leaderboard';
import { RedFlash } from './RedFlash';
import styles from './arena.module.css';

const POOL = CONFIG.capital.pool_size;
const EMPTY_IDS: ReadonlySet<string> = new Set();

interface FlashState {
  readonly key: number;
  readonly count: number;
  readonly agentIds: ReadonlySet<string>;
}

/**
 * The live Arena. Two SWR feeds poll at the single `ui_poll_ms` cadence; every
 * animation is derived by diffing the current poll against the previous one with
 * the pure helpers in `lib/arena`:
 *
 *  - capital-flow → bar widths animate, durations scaled by move size vs `max_step`;
 *  - reputation-drop → crashed agents redden/empty and fall in rank (FLIP);
 *  - red-flash → a screen overlay + per-row flash fire within one poll of a
 *    REJECT/HALT, de-duplicated by event id so each block flashes exactly once.
 *
 * The screen degrades gracefully: a feed error shows a banner but never tears
 * down the board, and a transient `undefined` between revalidations is ignored.
 */
export function Arena(): ReactNode {
  const { data: lb, error: lbError, isLoading } = useLeaderboard();
  const { data: feed } = usePolicyFeed();
  const reducedMotion = useReducedMotion();

  const agents = useMemo(() => (lb ? rankAgents(lb.data, POOL) : []), [lb]);
  const prevSnapshot = usePrevious<readonly AgentSnapshot[]>(lb?.data);

  // Capital-flow + reputation-drop, derived from the previous poll.
  const { crashedIds, barDurations } = useMemo(() => {
    const crashed = new Set<string>();
    const durations = new Map<string, number>();
    if (prevSnapshot && lb) {
      const timing = { maxStep: CONFIG.router.max_step, pollMs: CONFIG.timing.ui_poll_ms };
      for (const f of deriveFlows(prevSnapshot, lb.data, POOL)) {
        if (f.direction !== 'none')
          durations.set(f.agentId, flowDurationMs(f.deltaFraction, timing));
      }
      for (const c of deriveScoreChanges(prevSnapshot, lb.data, CONFIG.scoring.crash_cap)) {
        if (c.isCrash) crashed.add(c.agentId);
      }
    }
    return { crashedIds: crashed as ReadonlySet<string>, barDurations: durations };
  }, [prevSnapshot, lb]);

  // Red-flash state, threaded across polls by event id.
  const seenRef = useRef<ReadonlySet<string>>(EMPTY_IDS);
  const initRef = useRef(false);
  const keyRef = useRef(0);
  const [flash, setFlash] = useState<FlashState>({ key: 0, count: 0, agentIds: EMPTY_IDS });

  useEffect(() => {
    if (!feed) return;
    // First load establishes the baseline: existing blocks are history, not new.
    if (!initRef.current) {
      initRef.current = true;
      seenRef.current = selectFlashes(feed.data, EMPTY_IDS).seen;
      return;
    }
    const { flashes, seen } = selectFlashes(feed.data, seenRef.current);
    seenRef.current = seen;
    if (flashes.length > 0) {
      const summary = summarizeFlashes(flashes);
      keyRef.current += 1;
      setFlash({ key: keyRef.current, count: summary.count, agentIds: summary.agentIds });
    }
  }, [feed]);

  // Clear the per-row flash shortly after it fires so a later block can re-fire it.
  useEffect(() => {
    if (flash.agentIds.size === 0) return;
    const t = setTimeout(() => setFlash((f) => ({ ...f, agentIds: EMPTY_IDS })), 800);
    return () => clearTimeout(t);
  }, [flash]);

  const round = lb?.round ?? null;
  const capitalUnit = lb?.capital_unit ?? CONFIG.capital.capital_unit_label;

  return (
    <main className={styles.screen}>
      <header className={styles.header}>
        <h1 className={styles.title}>Vector Arena</h1>
        <span className={styles.round}>
          {round ? (
            <>
              Round {round.index} <span className={styles.roundState}>{round.state}</span>
            </>
          ) : (
            <span className={styles.roundState}>no round yet</span>
          )}
        </span>
      </header>

      {lbError ? (
        <p className={`${styles.states} ${styles.error}`} role="alert">
          Leaderboard unavailable — retrying…
        </p>
      ) : isLoading && agents.length === 0 ? (
        <p className={styles.states}>Loading the arena…</p>
      ) : agents.length === 0 ? (
        <p className={styles.states}>No agents in the arena yet.</p>
      ) : (
        <Leaderboard
          agents={agents}
          capitalUnit={capitalUnit}
          crashedIds={crashedIds}
          flashedIds={flash.agentIds}
          barDurations={barDurations}
          reducedMotion={reducedMotion}
        />
      )}

      <RedFlash flashKey={flash.key} count={flash.count} />
    </main>
  );
}
