import {
  policyEventRow,
  type PolicyDecision,
  type PolicyEventRow,
  type PolicySeverity,
} from '../schema';
import type { Queryable } from '../types';
import { insertOne, selectMany } from './_shared';

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
