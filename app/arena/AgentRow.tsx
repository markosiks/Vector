'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import { formatCapital, formatScore, truncateName, type AgentView } from '@/lib/arena';
import styles from './arena.module.css';

/** Map an agent status to its pill class. */
const STATUS_CLASS: Record<AgentView['status'], string> = {
  active: styles.statusActive ?? '',
  gated: styles.statusGated ?? '',
  halted: styles.statusHalted ?? '',
};

export interface AgentRowProps {
  readonly agent: AgentView;
  readonly capitalUnit: string;
  /** Reputation collapsed this poll — redden and empty the bars. */
  readonly crashed: boolean;
  /** A REJECT/HALT implicated this agent this poll — fire the row flash. */
  readonly flashed: boolean;
  /** Capital-bar transition duration (ms), from `flowDurationMs`. */
  readonly barDurationMs: number;
}

/**
 * One leaderboard row: rank, identity, a score bar and a capital bar, and the
 * exact capital figure. The bars' *widths* come from the float fractions
 * (geometry); the score and capital *text* come from the exact decimal strings
 * (precision). The capital bar's width animates over `barDurationMs` so a
 * reallocation reads as capital draining or filling.
 */
export function AgentRow({
  agent,
  capitalUnit,
  crashed,
  flashed,
  barDurationMs,
}: AgentRowProps): ReactNode {
  const rowClass = [
    styles.row,
    agent.rank === 0 ? styles.leaderRow : '',
    crashed ? styles.crashed : '',
    flashed ? styles.flashRow : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <li className={rowClass} data-flip-key={agent.id} data-testid="agent-row">
      <Link
        href={`/agents/${agent.id}`}
        className={styles.rowLink}
        aria-label={`Open ${agent.displayName} agent detail`}
      />
      <span className={styles.rank}>{agent.rank + 1}</span>

      <span className={styles.identity}>
        <span className={styles.name} title={agent.displayName}>
          {truncateName(agent.displayName)}
          <span className={`${styles.statusTag} ${STATUS_CLASS[agent.status]}`}>
            {agent.status}
          </span>
        </span>
        <span className={styles.owner}>{agent.owner}</span>
      </span>

      <span className={styles.bars}>
        <span className={styles.barTrack}>
          <span
            className={`${styles.barFill} ${styles.scoreFill}`}
            style={{ width: `${(agent.scoreFraction * 100).toFixed(2)}%` }}
            data-testid="score-bar"
          />
        </span>
        <span className={styles.barTrack}>
          <span
            className={styles.barFill}
            style={{
              width: `${(agent.allocationFraction * 100).toFixed(2)}%`,
              transitionDuration: `${barDurationMs}ms`,
            }}
            data-testid="capital-bar"
          />
        </span>
        <span className={styles.barLabel}>
          <span>score {formatScore(agent.score)}</span>
        </span>
      </span>

      <span className={styles.metric}>
        <span className={styles.metricValue} data-testid="capital-value">
          {formatCapital(agent.allocation, 0)}
        </span>{' '}
        <span className={styles.metricUnit}>{capitalUnit}</span>
      </span>
    </li>
  );
}
