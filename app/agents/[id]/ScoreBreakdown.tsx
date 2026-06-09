import type { ReactNode } from 'react';

import type { ContributionSign } from '@/lib/credibility/components';
import { breakdownFrom } from '@/lib/credibility/components';
import { formatFactor, formatPoints } from '@/lib/credibility/format';
import styles from './agent-detail.module.css';

/** Map a contribution's sign to its bar/value tone class (green/red/muted). */
function toneClass(sign: ContributionSign): string {
  if (sign === 'positive') return styles.pos ?? '';
  if (sign === 'negative') return styles.neg ?? '';
  return styles.muted ?? '';
}

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

      {/*
       * Proportional contribution bars: a visual, at-a-glance read of how the
       * three additive point-terms compose `raw` on a 0–100 axis. Decorative —
       * the same numbers are announced by the `terms` list and the result row —
       * so the whole block is aria-hidden to avoid double-reading for AT.
       */}
      <div className={styles.bars} data-testid="breakdown-bars" aria-hidden="true">
        {b.contributions.map((c) => (
          <div className={styles.barRow} key={c.key} data-testid={`bar-${c.key}`}>
            <span className={styles.barLabel} title={c.label}>
              {c.label}
            </span>
            <span className={styles.barTrack}>
              <span
                className={`${styles.barFill} ${toneClass(c.sign)}`}
                data-sign={c.sign}
                style={{ width: `${c.widthPct}%` }}
              />
            </span>
            <span className={`${styles.barValue} ${styles.mono} ${toneClass(c.sign)}`}>
              {formatPoints(c.points, true)}
            </span>
          </div>
        ))}
        <div className={`${styles.barRow} ${styles.barResultRow}`} data-testid="bar-result">
          <span className={styles.barLabel}>Result</span>
          <span className={styles.barTrack}>
            <span className={styles.barFillResult} style={{ width: `${b.resultFillPct}%` }} />
          </span>
          <span className={`${styles.barValue} ${styles.mono}`}>{formatPoints(b.raw)}</span>
        </div>
      </div>

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
