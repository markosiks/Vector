import { z } from 'zod';

import {
  policyEventRow,
  type PolicyDecision,
  type PolicyEventRow,
  type PolicySeverity,
} from '../schema';
import type { Queryable } from '../types';
import { CURSOR_KEY_SQL, insertOne, type Keyset, keysetBefore, selectMany } from './_shared';

/**
 * A page row carries the microsecond-precision {@link CURSOR_KEY_SQL} alias
 * alongside the domain row, so {@link import('../../api/respond').paginate} mints
 * the next cursor from the exact stored timestamp rather than a millisecond-
 * truncated `Date`.
 */
const policyEventPageRow = policyEventRow.extend({ cursor_t: z.string() });
export type PolicyEventPageRow = z.infer<typeof policyEventPageRow>;

/** Fields accepted when recording a referee decision. */
export interface NewPolicyEvent {
  intent_id: string;
  agent_id: string;
  round_id: string;
  rule_fired: string;
  decision: PolicyDecision;
  severity: PolicySeverity;
  detail_json?: unknown;
}

export function insertPolicyEvent(db: Queryable, input: NewPolicyEvent): Promise<PolicyEventRow> {
  return insertOne(
    db,
    'policy_events',
    {
      intent_id: input.intent_id,
      agent_id: input.agent_id,
      round_id: input.round_id,
      rule_fired: input.rule_fired,
      decision: input.decision,
      severity: input.severity,
      detail_json: input.detail_json,
    },
    policyEventRow,
  );
}

/** Red-alert feed: most recent policy events across all agents, newest first. */
export function listRecentPolicyEvents(db: Queryable, limit = 100): Promise<PolicyEventRow[]> {
  return selectMany(
    db,
    'SELECT * FROM policy_events ORDER BY created_at DESC LIMIT $1',
    [limit],
    policyEventRow,
  );
}

/**
 * One keyset page of the red-alert feed, newest first. Ordered
 * `created_at DESC, id DESC` — the `id` tie-break makes paging deterministic
 * when events share a `created_at` tick (REJECT/HALT bursts write many at once),
 * which a `created_at`-only order would shuffle across pages. With `before` the
 * page continues strictly older than that cursor; without it, from the head. The
 * `created_at DESC` ordering is served by `idx_policy_events_created`.
 */
export function listPolicyEventsPage(
  db: Queryable,
  limit: number,
  before?: Keyset,
): Promise<PolicyEventPageRow[]> {
  const params: unknown[] = [];
  const where = before === undefined ? '' : `WHERE ${keysetBefore(before, params)} `;
  params.push(limit);
  return selectMany(
    db,
    `SELECT *, ${CURSOR_KEY_SQL} FROM policy_events ${where}ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
    policyEventPageRow,
  );
}

/**
 * Agent-detail feed: an agent's most recent policy events, newest first. The
 * `agent_id` filter and `created_at DESC, id DESC` order are served together by
 * `idx_policy_events_agent_created`.
 */
export function listRecentPolicyEventsByAgent(
  db: Queryable,
  agentId: string,
  limit = 100,
): Promise<PolicyEventRow[]> {
  return selectMany(
    db,
    'SELECT * FROM policy_events WHERE agent_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
    [agentId, limit],
    policyEventRow,
  );
}

/**
 * All policy events for one agent in one round, oldest first. The scoring
 * engine reduces these into per-severity violation counts and the `drain_r`
 * flag (rule #3, `fresh_wallet_transfer_block`).
 */
export function listPolicyEventsByAgentRound(
  db: Queryable,
  agentId: string,
  roundId: string,
): Promise<PolicyEventRow[]> {
  return selectMany(
    db,
    'SELECT * FROM policy_events WHERE agent_id = $1 AND round_id = $2 ORDER BY created_at ASC',
    [agentId, roundId],
    policyEventRow,
  );
}
