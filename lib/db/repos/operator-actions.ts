import { operatorActionRow, type OperatorActionKind, type OperatorActionRow } from '../schema';
import type { Queryable } from '../types';
import { insertOne, selectMany } from './_shared';

/**
 * The operator-actions audit log repository (P2.4) — append + read only.
 *
 * Every accepted operator-console mutation records exactly one row here so the
 * control plane is auditable (who/when/what). It is deliberately thin: callers
 * pass an already-curated `detail_json` (never a secret), and reads are the
 * newest-first feed the console renders.
 */

/** Fields accepted when recording an operator action. */
export interface NewOperatorAction {
  kind: OperatorActionKind;
  /** Operator identity label; defaults to `'operator'` (single shared identity). */
  actor?: string;
  /** The agent this action targeted, when applicable. */
  agent_id?: string | null;
  /** Structured parameters + outcome. Must never carry a secret. */
  detail_json?: unknown;
}

export function insertOperatorAction(
  db: Queryable,
  input: NewOperatorAction,
): Promise<OperatorActionRow> {
  return insertOne(
    db,
    'operator_actions',
    {
      kind: input.kind,
      actor: input.actor,
      agent_id: input.agent_id ?? null,
      detail_json: input.detail_json,
    },
    operatorActionRow,
  );
}

/** The audit feed: the most recent operator actions, newest first. */
export function listRecentOperatorActions(db: Queryable, limit = 50): Promise<OperatorActionRow[]> {
  return selectMany(
    db,
    'SELECT * FROM operator_actions ORDER BY created_at DESC, id DESC LIMIT $1',
    [limit],
    operatorActionRow,
  );
}
