'use client';

import { useRef, type ReactNode } from 'react';

import type { AgentView } from '@/lib/arena';
import { AgentRow } from './AgentRow';
import { useFlip } from './useFlip';
import styles from './arena.module.css';

export interface LeaderboardProps {
  readonly agents: readonly AgentView[];
  readonly capitalUnit: string;
  /** Agents whose reputation collapsed this poll. */
  readonly crashedIds: ReadonlySet<string>;
  /** Agents implicated by a REJECT/HALT this poll. */
  readonly flashedIds: ReadonlySet<string>;
  /** Per-agent capital-bar transition duration (ms); falls back to a default. */
  readonly barDurations: ReadonlyMap<string, number>;
  readonly reducedMotion: boolean;
}

const DEFAULT_BAR_MS = 600;

/**
 * The ranked board. Rows are keyed by agent id and ordered by rank; when the
 * order changes between polls, {@link useFlip} animates the slide so an agent
 * visibly falls or climbs. The FLIP pass is re-run whenever the ordered id list
 * changes, and is a no-op under reduced motion.
 */
export function Leaderboard({
  agents,
  capitalUnit,
  crashedIds,
  flashedIds,
  barDurations,
  reducedMotion,
}: LeaderboardProps): ReactNode {
  const ref = useRef<HTMLOListElement>(null);
  const order = agents.map((a) => a.id).join(',');
  useFlip(ref, [order], reducedMotion);

  return (
    <ol className={styles.board} ref={ref} data-testid="leaderboard">
      {agents.map((agent) => (
        <AgentRow
          key={agent.id}
          agent={agent}
          capitalUnit={capitalUnit}
          crashed={crashedIds.has(agent.id)}
          flashed={flashedIds.has(agent.id)}
          barDurationMs={reducedMotion ? 0 : (barDurations.get(agent.id) ?? DEFAULT_BAR_MS)}
        />
      ))}
    </ol>
  );
}
