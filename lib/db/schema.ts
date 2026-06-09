import { z } from 'zod';

/**
 * TypeScript mirror of the SQL data model (`lib/db/migrations/0001_*`).
 *
 * The SQL DDL is the source of truth for the schema; this module mirrors its
 * enum domains and row shapes so the repository layer is typed and so a row
 * read back from Postgres can be validated. Enum tuples are declared once here
 * and reused by both the zod schemas and any caller that needs the domain.
 *
 * Numeric/`numeric` columns are represented as `string` end-to-end: the driver
 * returns them as strings to preserve precision, and we never coerce money,
 * scores, or CaR through a float.
 */

// --- Enum domains (must match the CREATE TYPE statements in 0001) -----------
export const AGENT_STATUS = ['active', 'halted', 'gated'] as const;
export const STRATEGY_KIND = ['seed', 'external'] as const;
export const ROUND_STATE = ['open', 'settling', 'settled'] as const;
export const INTENT_ACTION = ['open', 'close', 'modify', 'transfer'] as const;
export const INTENT_SIDE = ['long', 'short'] as const;
export const POLICY_DECISION = ['ALLOW', 'CLIP', 'REJECT', 'HALT'] as const;
export const POLICY_SEVERITY = ['none', 'soft', 'hard', 'halt'] as const;
export const EXECUTION_RAIL = ['byreal', 'seed'] as const;
export const EXECUTION_STATUS = ['sent', 'filled', 'partial', 'error'] as const;
export const ALLOCATION_TRIGGER = ['settle', 'attestation', 'crash', 'operator'] as const;
export const CHAIN_STATE = ['optimistic', 'confirmed', 'failed'] as const;
export const OPERATOR_ACTION_KIND = ['kill_switch', 'agent_status', 'attack'] as const;

export type AgentStatus = (typeof AGENT_STATUS)[number];
export type StrategyKind = (typeof STRATEGY_KIND)[number];
export type RoundState = (typeof ROUND_STATE)[number];
export type IntentAction = (typeof INTENT_ACTION)[number];
export type IntentSide = (typeof INTENT_SIDE)[number];
export type PolicyDecision = (typeof POLICY_DECISION)[number];
export type PolicySeverity = (typeof POLICY_SEVERITY)[number];
export type ExecutionRail = (typeof EXECUTION_RAIL)[number];
export type ExecutionStatus = (typeof EXECUTION_STATUS)[number];
export type AllocationTrigger = (typeof ALLOCATION_TRIGGER)[number];
export type ChainState = (typeof CHAIN_STATE)[number];
export type OperatorActionKind = (typeof OPERATOR_ACTION_KIND)[number];

// --- Reusable column codecs -------------------------------------------------
/** Postgres `numeric`, surfaced as a decimal string to preserve precision. */
const numeric = z.string();
/** Postgres `timestamptz`, surfaced by the driver as a `Date`. */
const ts = z.date();
const uuid = z.string().uuid();
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

// --- Row schemas (shapes returned by `SELECT *`) ----------------------------
export const agentRow = z.object({
  id: uuid,
  agent_id_onchain: z.string().nullable(),
  display_name: z.string(),
  owner: z.string(),
  strategy_kind: z.enum(STRATEGY_KIND),
  status: z.enum(AGENT_STATUS),
  score_current: numeric,
  created_at: ts,
});

export const roundRow = z.object({
  id: uuid,
  index: z.number().int(),
  state: z.enum(ROUND_STATE),
  seed_ref: z.string().nullable(),
  started_at: ts,
  settled_at: ts.nullable(),
});

export const intentRow = z.object({
  id: uuid,
  round_id: uuid,
  agent_id: uuid,
  intent_hash: z.string(),
  action: z.enum(INTENT_ACTION),
  market: z.string().nullable(),
  side: z.enum(INTENT_SIDE).nullable(),
  size: numeric.nullable(),
  leverage: numeric.nullable(),
  tp: numeric.nullable(),
  sl: numeric.nullable(),
  max_slippage: numeric.nullable(),
  target_address: z.string().nullable(),
  nonce: z.string().nullable(),
  ttl: ts.nullable(),
  signature: z.string().nullable(),
  raw_json: z.unknown().nullable(),
  created_at: ts,
});

export const policyEventRow = z.object({
  id: uuid,
  intent_id: uuid,
  agent_id: uuid,
  round_id: uuid,
  rule_fired: z.string(),
  decision: z.enum(POLICY_DECISION),
  severity: z.enum(POLICY_SEVERITY),
  detail_json: z.unknown().nullable(),
  created_at: ts,
});

export const executionRow = z.object({
  id: uuid,
  intent_id: uuid,
  rail: z.enum(EXECUTION_RAIL),
  rail_order_id: z.string().nullable(),
  status: z.enum(EXECUTION_STATUS),
  request_json: z.unknown().nullable(),
  response_json: z.unknown().nullable(),
  created_at: ts,
});

export const outcomeRow = z.object({
  id: uuid,
  execution_id: uuid.nullable(),
  agent_id: uuid,
  round_id: uuid,
  pnl_realized: numeric,
  pnl_marked: numeric,
  capital_at_risk: numeric,
  fees: numeric,
  position_delta: numeric,
  drawdown: numeric,
  created_at: ts,
});

/**
 * Explainability breakdown persisted in `scores.components_json`. Downstream
 * consumers (P2.3 attestations, the agent-detail UI) key on exactly these four
 * keys, so the shape is enforced at the persistence boundary, not just by the
 * producer's type. `.strict()` rejects extra/renamed keys at parse time.
 */
export const scoreComponents = z
  .object({
    perf: z.number().finite(),
    w: z.number().finite(),
    policy: z.number().finite(),
    dd: z.number().finite(),
  })
  .strict();

export const scoreRow = z.object({
  id: uuid,
  agent_id: uuid,
  round_id: uuid,
  raw_r: numeric,
  score_r: numeric,
  components_json: scoreComponents.nullable(),
  created_at: ts,
});

export const capitalAllocationRow = z.object({
  id: uuid,
  agent_id: uuid,
  round_id: uuid,
  amount: numeric,
  target_weight: numeric,
  prev_weight: numeric,
  delta: numeric,
  trigger: z.enum(ALLOCATION_TRIGGER),
  created_at: ts,
});

export const attestationRow = z.object({
  id: uuid,
  agent_id: uuid,
  round_id: uuid,
  value: numeric,
  value_decimals: z.number().int(),
  tag1: z.string().nullable(),
  tag2: z.string().nullable(),
  feedback_uri: z.string().nullable(),
  feedback_hash: hex32.nullable(),
  /** Canonical off-chain detail JSON served at `feedback_uri`; `null` until built. */
  feedback_detail: z.string().nullable(),
  chain_state: z.enum(CHAIN_STATE),
  tx_hash: hex32.nullable(),
  block_number: z.string().nullable(),
  created_at: ts,
  confirmed_at: ts.nullable(),
});

export const killSwitchRow = z.object({
  id: z.number().int(),
  active: z.boolean(),
  reason: z.string().nullable(),
  set_by: z.string().nullable(),
  updated_at: ts,
});

export const operatorActionRow = z.object({
  id: uuid,
  kind: z.enum(OPERATOR_ACTION_KIND),
  actor: z.string(),
  agent_id: uuid.nullable(),
  detail_json: z.unknown().nullable(),
  created_at: ts,
});

export type AgentRow = z.infer<typeof agentRow>;
export type RoundRow = z.infer<typeof roundRow>;
export type IntentRow = z.infer<typeof intentRow>;
export type PolicyEventRow = z.infer<typeof policyEventRow>;
export type ExecutionRow = z.infer<typeof executionRow>;
export type OutcomeRow = z.infer<typeof outcomeRow>;
export type ScoreRow = z.infer<typeof scoreRow>;
export type CapitalAllocationRow = z.infer<typeof capitalAllocationRow>;
export type AttestationRow = z.infer<typeof attestationRow>;
export type KillSwitchRow = z.infer<typeof killSwitchRow>;
export type OperatorActionRow = z.infer<typeof operatorActionRow>;
