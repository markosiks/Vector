'use client';

import type { ReactNode } from 'react';

import { formatScore } from '@/lib/arena/format';
import { EwmaChart } from './EwmaChart';
import { IntentsTable } from './IntentsTable';
import { OutcomesTable } from './OutcomesTable';
import { ScoreBreakdown } from './ScoreBreakdown';
import { useAgentDetail } from './hooks';
import styles from './agent-detail.module.css';

export interface AgentDetailProps {
  readonly agentId: string;
}

/**
 * The Agent-detail screen (P2.3): one agent's credibility story — its EWMA score
 * curve, the latest round's score composition, the referee's verdicts on its
 * recent intents, and the settlement outcomes. All four advance together on the
 * single poll cadence. A malformed/unknown id resolves to an explicit not-found
 * state (no retry storm); a transient failure shows a banner over stale data.
 */
export function AgentDetail({ agentId }: AgentDetailProps): ReactNode {
  const { data, error, isLoading, notFound } = useAgentDetail(agentId);

  if (notFound) {
    return (
      <main className={styles.screen}>
        <div className={styles.state} data-testid="agent-not-found">
          <h1 className={styles.title}>Agent not found</h1>
          <p className={styles.muted}>No agent matches this id.</p>
        </div>
      </main>
    );
  }

  if (isLoading && !data) {
    return (
      <main className={styles.screen}>
        <p className={styles.state}>Loading agent…</p>
      </main>
    );
  }

  if (!data) {
    return (
      <main className={styles.screen}>
        <p className={`${styles.state} ${styles.error}`} role="alert">
          Agent feed unavailable — retrying…
        </p>
      </main>
    );
  }

  const { agent, scores, intents, policy_events, outcomes } = data;
  // The breakdown reflects the latest scored round that carries components.
  const latestComponents =
    [...scores].reverse().find((s) => s.components !== null)?.components ?? null;

  return (
    <main className={styles.screen}>
      {error ? (
        <p className={`${styles.banner} ${styles.error}`} role="alert">
          Live updates paused — retrying…
        </p>
      ) : null}

      <header className={styles.head}>
        <div>
          <h1 className={styles.title}>{agent.display_name}</h1>
          <p className={styles.headMeta}>
            <span className={styles.muted}>{agent.strategy_kind}</span>
            <span className={styles.dot}>·</span>
            <span className={styles.muted}>owner {agent.owner}</span>
            <span className={styles.dot}>·</span>
            <span className={`${styles.statusPill} ${styles[`status_${agent.status}`] ?? ''}`}>
              {agent.status}
            </span>
          </p>
        </div>
        <div className={styles.scoreNow} data-testid="agent-score">
          <span className={styles.muted}>AgentScore</span>
          <strong className={styles.scoreValue}>{formatScore(agent.score_current)}</strong>
        </div>
      </header>

      <section className={styles.section} aria-labelledby="ewma-h">
        <h2 id="ewma-h" className={styles.sectionTitle}>
          Score history
        </h2>
        <EwmaChart scores={scores} />
      </section>

      <section className={styles.section} aria-labelledby="breakdown-h">
        <h2 id="breakdown-h" className={styles.sectionTitle}>
          Latest score composition
        </h2>
        <ScoreBreakdown components={latestComponents} />
      </section>

      <div className={styles.split}>
        <section className={styles.section} aria-labelledby="intents-h">
          <h2 id="intents-h" className={styles.sectionTitle}>
            Recent intents &amp; referee decisions
          </h2>
          <IntentsTable intents={intents} policyEvents={policy_events} />
        </section>

        <section className={styles.section} aria-labelledby="outcomes-h">
          <h2 id="outcomes-h" className={styles.sectionTitle}>
            Outcomes
          </h2>
          <OutcomesTable outcomes={outcomes} />
        </section>
      </div>
    </main>
  );
}
