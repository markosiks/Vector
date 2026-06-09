import type { ReactNode } from 'react';

import { chainStateMeta, type ChainStateTone } from '@/lib/credibility/chain-state';
import type { ChainState } from '@/lib/db/schema';
import styles from './attestations.module.css';

const TONE_CLASS: Record<ChainStateTone, string> = {
  pending: styles.tonePending!,
  success: styles.toneSuccess!,
  danger: styles.toneDanger!,
};

export interface ChainStateBadgeProps {
  readonly state: ChainState;
  /** When set, marks an `optimistic` row whose chain has gone silent past budget. */
  readonly stuck?: boolean;
}

/**
 * The reconciliation badge. Colour is driven by tone, not by re-deriving from
 * the label, so a copy change never desyncs the colour. A stuck `optimistic` row
 * gets an extra "chain silent" qualifier and a `data-stuck` hook for tests; a
 * non-terminal state carries `aria-busy` so assistive tech announces it as
 * in-progress.
 */
export function ChainStateBadge({ state, stuck = false }: ChainStateBadgeProps): ReactNode {
  const meta = chainStateMeta(state);
  return (
    <span
      className={`${styles.badge} ${TONE_CLASS[meta.tone]}`}
      data-testid="chain-state-badge"
      data-state={meta.state}
      data-stuck={stuck ? 'true' : undefined}
      aria-busy={meta.terminal ? undefined : true}
      title={
        stuck ? `${meta.description} Chain has been silent — pending a sweep.` : meta.description
      }
    >
      <span className={styles.badgeDot} aria-hidden="true" />
      {meta.label}
      {stuck ? <span className={styles.badgeQualifier}> · chain silent</span> : null}
    </span>
  );
}
