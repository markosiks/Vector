import type { ReactNode } from 'react';

import type { AttestationDto } from '@/lib/api/dto';
import { explorerBlockUrl, explorerTxUrl } from '@/lib/credibility/explorer';
import { formatAttestationValue, formatTimestamp } from '@/lib/credibility/format';
import { ChainStateBadge } from './ChainStateBadge';
import styles from './attestations.module.css';

/** Shorten a uuid/hash for compact display while keeping it recognizable. */
function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 6)}…${id.slice(-4)}`;
}

export interface AttestationRowProps {
  readonly attestation: AttestationDto;
  /** `true` when this `optimistic` row's chain has been silent past the budget. */
  readonly stuck: boolean;
}

/**
 * One attestation: the agent/round it anchors, the integer AgentScore `value`,
 * its reconciliation badge, and — once mined — a real explorer link to the tx
 * and block on Mantle Sepolia. The links come from {@link explorerTxUrl}/
 * {@link explorerBlockUrl}, which return `null` for a malformed hash, so a
 * partially-written row shows the hash as plain text instead of a broken link.
 * A `failed` row shows an explicit "reverted" note; a stuck `optimistic` row is
 * flagged by the badge.
 */
export function AttestationRow({ attestation: a, stuck }: AttestationRowProps): ReactNode {
  const txUrl = explorerTxUrl(a.tx_hash);
  const blockUrl = explorerBlockUrl(a.block_number);

  return (
    <li className={styles.row} data-testid="attestation-row" data-state={a.chain_state}>
      <div className={styles.rowMain}>
        <span className={styles.value} data-testid="attestation-value">
          {formatAttestationValue(a.value, a.value_decimals)}
          {a.tag1 ? <span className={styles.tag}>{a.tag1}</span> : null}
        </span>
        <ChainStateBadge state={a.chain_state} stuck={stuck} />
      </div>

      <div className={styles.rowMeta}>
        <span className={styles.metaItem}>
          <span className={styles.metaLabel}>agent</span>
          <span className={styles.mono}>{shortId(a.agent_id)}</span>
        </span>
        <span className={styles.metaItem}>
          <span className={styles.metaLabel}>round</span>
          <span className={styles.mono}>{shortId(a.round_id)}</span>
        </span>
        <span className={styles.metaItem}>
          <span className={styles.metaLabel}>tx</span>
          {a.tx_hash === null ? (
            <span className={styles.muted}>not submitted</span>
          ) : txUrl ? (
            <a className={styles.link} href={txUrl} target="_blank" rel="noreferrer noopener">
              {shortId(a.tx_hash)} ↗
            </a>
          ) : (
            <span className={`${styles.mono} ${styles.muted}`} title="Malformed hash — no link">
              {shortId(a.tx_hash)}
            </span>
          )}
        </span>
        <span className={styles.metaItem}>
          <span className={styles.metaLabel}>block</span>
          {a.block_number === null ? (
            <span className={styles.muted}>—</span>
          ) : blockUrl ? (
            <a className={styles.link} href={blockUrl} target="_blank" rel="noreferrer noopener">
              {a.block_number} ↗
            </a>
          ) : (
            <span className={`${styles.mono} ${styles.muted}`}>{a.block_number}</span>
          )}
        </span>
      </div>

      <div className={styles.rowFoot}>
        <span className={styles.muted}>written {formatTimestamp(a.created_at)}</span>
        {a.chain_state === 'confirmed' && a.confirmed_at ? (
          <span className={styles.confirmNote} data-testid="confirmed-note">
            confirmed {formatTimestamp(a.confirmed_at)}
          </span>
        ) : null}
        {a.chain_state === 'failed' ? (
          <span className={styles.failNote} data-testid="failed-note">
            reverted on-chain — will be re-anchored next round
          </span>
        ) : null}
        {stuck ? (
          <span className={styles.stuckNote} data-testid="stuck-note">
            awaiting confirmation — pending operator sweep
          </span>
        ) : null}
      </div>
    </li>
  );
}
