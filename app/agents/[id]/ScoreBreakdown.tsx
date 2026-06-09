import type { ReactNode } from 'react';

import { breakdownFrom } from '@/lib/credibility/components';
import { formatFactor, formatPoints } from '@/lib/credibility/format';
import styles from './agent-detail.module.css';

export interface ScoreBreakdownProps {
  /** The latest scored round's `components_json` (untrusted; may be null/broken). */
  readonly components: unknown;
}

/**
 * The §6.1 score composition for the latest round, rendered as an *explicit
 * formula* — `100 · perf × w + policy − dd`, then clamped to `[0,100]` — so it
 * is visibly a weighted product plus signed point adjustments, never a flat sum.
 * A missing/corrupt `components_json` degrades to an empty state.
 */
export function ScoreBreakdown({ components }: ScoreBreakdownProps): ReactNode {
  const b = breakdownFrom(components);
  if (b === null) {
    return (
      <div className={styles.panelEmpty} data-testid="breakdown-empty">
        No component breakdown for the latest round.
      </div>
    );
  }

  return (
    <div className={styles.breakdown} data-testid="score-breakdown">
      <div className={styles.formula} aria-hidden="true">
        <span>
          100 · <em>perf</em> × <em>w</em>
        </span>
        <span>
          + <em>policy</em>
        </span>
        <span>
          − <em>dd</em>
        </span>
      </div>

      <dl className={styles.terms}>
        <div className={styles.term}>
          <dt>Performance × weight</dt>
          <dd>
            <span className={styles.mono}>{formatFactor(b.perf)}</span>
            <span className={styles.op}>×</span>
            <span className={styles.mono}>{formatFactor(b.w)}</span>
            <span className={styles.op}>→</span>
            <strong className={styles.mono} data-testid="perf-points">
              {formatPoints(b.performancePoints)}
            </strong>
          </dd>
        </div>
        <div className={styles.term}>
          <dt>Policy</dt>
          <dd>
            <strong className={`${styles.mono} ${b.policy < 0 ? styles.neg : styles.pos}`}>
              {formatPoints(b.policy, true)}
            </strong>
          </dd>
        </div>
        <div className={styles.term}>
          <dt>Drawdown</dt>
          <dd>
            <strong className={`${styles.mono} ${b.dd > 0 ? styles.neg : ''}`}>
              −{formatPoints(b.dd)}
            </strong>
          </dd>
        </div>
      </dl>

      <div className={styles.result}>
        <span className={styles.muted}>= clamp({formatPoints(b.rawUnclamped)}, 0, 100)</span>
        <strong className={styles.rawValue} data-testid="raw-value">
          {formatPoints(b.raw)}
        </strong>
        {b.clamped ? (
          <span className={styles.clampNote} data-testid="clamp-note">
            clamped
          </span>
        ) : null}
      </div>
    </div>
  );
}
