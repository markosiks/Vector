import type { ReactNode } from 'react';

import type { IntentDto, PolicyEventDto } from '@/lib/api/dto';
import { correlateIntents, decisionTone } from '@/lib/credibility/referee';
import { formatTimestamp } from '@/lib/credibility/format';
import { EMPTY } from '@/lib/arena/format';
import styles from './agent-detail.module.css';

const TONE_CLASS = {
  ok: styles.decOk ?? '',
  warn: styles.decWarn ?? '',
  danger: styles.decDanger ?? '',
  critical: styles.decCritical ?? '',
};

export interface IntentsTableProps {
  readonly intents: readonly IntentDto[];
  readonly policyEvents: readonly PolicyEventDto[];
}

/** Compact one-line summary of an intent's trade shape. */
function describeIntent(i: IntentDto): string {
  const parts: string[] = [i.action];
  if (i.side) parts.push(i.side);
  if (i.market) parts.push(i.market);
  if (i.size) parts.push(`size ${i.size}`);
  if (i.leverage) parts.push(`${i.leverage}×`);
  return parts.join(' · ');
}

/**
 * The agent's recent intents joined to the referee's verdict on each, by
 * `intent_id` ({@link correlateIntents}). The dominant decision per intent is
 * badged (ALLOW/CLIP/REJECT/HALT with severity); an intent the referee has not
 * ruled on shows a neutral placeholder rather than implying a verdict. The
 * underlying DTO already omits `signature`/`raw_json`/`nonce`, so nothing
 * sensitive is rendered.
 */
export function IntentsTable({ intents, policyEvents }: IntentsTableProps): ReactNode {
  const rows = correlateIntents(intents, policyEvents);
  if (rows.length === 0) {
    return (
      <div className={styles.panelEmpty} data-testid="intents-empty">
        No intents submitted yet.
      </div>
    );
  }

  return (
    <ul className={styles.intents} data-testid="intents-table">
      {rows.map(({ intent, worst, events }) => (
        <li key={intent.id} className={styles.intentRow} data-testid="intent-row">
          <div className={styles.intentMain}>
            <span className={styles.intentDesc}>{describeIntent(intent)}</span>
            {worst ? (
              <span
                className={`${styles.decision} ${TONE_CLASS[decisionTone(worst.decision)]}`}
                data-testid="decision-badge"
                data-decision={worst.decision}
                title={`${worst.rule_fired} · severity ${worst.severity}`}
              >
                {worst.decision}
                <span className={styles.sev}>{worst.severity}</span>
              </span>
            ) : (
              <span className={`${styles.decision} ${styles.decNone}`} data-testid="decision-badge">
                {EMPTY} no ruling
              </span>
            )}
          </div>
          <div className={styles.intentMeta}>
            <span className={styles.muted}>{formatTimestamp(intent.created_at)}</span>
            {events.length > 1 ? (
              <span className={styles.muted}>+{events.length - 1} more rule(s) fired</span>
            ) : null}
            {intent.target_address ? (
              <span className={`${styles.mono} ${styles.muted}`}>→ {intent.target_address}</span>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
