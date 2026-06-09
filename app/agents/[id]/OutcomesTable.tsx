import type { ReactNode } from 'react';

import type { OutcomeDto } from '@/lib/api/dto';
import { formatCapital } from '@/lib/arena/format';
import { formatSignedCapital, formatTimestamp } from '@/lib/credibility/format';
import { CONFIG } from '@/lib/config/constants';
import styles from './agent-detail.module.css';

const UNIT = CONFIG.capital.capital_unit_label;

export interface OutcomesTableProps {
  readonly outcomes: readonly OutcomeDto[];
}

/**
 * Per-round settlement outcomes: realized/marked PnL, capital at risk, fees, and
 * drawdown. PnL and position delta carry an explicit sign ({@link
 * formatSignedCapital}); every magnitude is an exact truncated prefix of the
 * stored `numeric` — never a float — so a 38-digit capital figure renders
 * digit-for-digit. An agent with no settled rounds shows an empty state.
 */
export function OutcomesTable({ outcomes }: OutcomesTableProps): ReactNode {
  if (outcomes.length === 0) {
    return (
      <div className={styles.panelEmpty} data-testid="outcomes-empty">
        No settled rounds yet.
      </div>
    );
  }

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table} data-testid="outcomes-table">
        <thead>
          <tr>
            <th scope="col">Realized PnL</th>
            <th scope="col">Marked PnL</th>
            <th scope="col">Capital at risk</th>
            <th scope="col">Fees</th>
            <th scope="col">Drawdown</th>
            <th scope="col">When</th>
          </tr>
        </thead>
        <tbody>
          {outcomes.map((o) => (
            <tr key={o.id} data-testid="outcome-row">
              <td className={`${styles.mono} ${signClass(o.pnl_realized)}`}>
                {formatSignedCapital(o.pnl_realized)}
              </td>
              <td className={`${styles.mono} ${signClass(o.pnl_marked)}`}>
                {formatSignedCapital(o.pnl_marked)}
              </td>
              <td className={styles.mono}>
                {formatCapital(o.capital_at_risk)} <span className={styles.unit}>{UNIT}</span>
              </td>
              <td className={styles.mono}>{formatCapital(o.fees)}</td>
              <td className={`${styles.mono} ${styles.neg}`}>{formatCapital(o.drawdown, 4)}</td>
              <td className={styles.muted}>{formatTimestamp(o.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Colour a signed money cell by sign, using a cheap leading-char check. */
function signClass(value: string): string {
  if (value.startsWith('-')) return styles.neg!;
  return /[1-9]/.test(value) ? styles.pos! : '';
}
