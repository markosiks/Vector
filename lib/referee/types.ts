import type { VectorConfig } from '@/lib/config/constants.schema';
import type { PolicyDecision, PolicySeverity } from '@/lib/db/schema';
import type { Intent } from '@/lib/intent/types';
import type { DeepReadonly } from '@/lib/utils/deep-freeze';

/**
 * The Referee / Firewall — Vector's bounded-execution gate (architecture §6.3,
 * P1.1). It is the single path from a validated {@link Intent} to the execution
 * rail (B2): a typed Intent is evaluated against a **fixed, ordered** rule set
 * and reduced to one of four decisions. The first rule that fires decides the
 * outcome; later rules never run. Every decision emits a `policy_event`.
 *
 * The referee validates a *typed Intent*, never a prompt, and `evaluate` is a
 * pure function of `(intent, state, config)` — same inputs ⇒ same decision and
 * the same `policy_event`. Scoring, routing, and execution live elsewhere; the
 * referee only judges.
 */

/** The four terminal decisions (mirrors the `policy_decision` SQL enum). */
export type Decision = PolicyDecision;

/** The severity attached to a decision (mirrors the `policy_severity` SQL enum). */
export type Severity = PolicySeverity;

/** The slice of seeded config the referee reads (caps, whitelist, fresh-wallet). */
export type RefereeConfig = DeepReadonly<VectorConfig['policy']>;

/**
 * What the referee knows about a transfer's destination, when known. Wallet
 * age/history are off-chain facts the referee cannot derive itself, so they are
 * injected as state; absence is treated as "fresh" (fail-closed). This metadata
 * never changes the *decision* for a non-whitelisted destination (always
 * REJECT), only the recorded rationale.
 */
export interface DestinationInfo {
  readonly address: string;
  /** Wallet age in seconds; below `fresh_wallet_criteria.max_age_seconds` ⇒ fresh. */
  readonly age_seconds?: number;
  /** Whether the destination has any prior on-chain history. */
  readonly has_history?: boolean;
}

/** Per-agent risk state the referee evaluates against (§6.3). */
export interface AgentState {
  /** Capital allocated to the agent this round (canonical decimal string). */
  readonly allocation: string;
  /** Remaining spend budget this round (canonical decimal string, ≥ 0). */
  readonly remaining_budget: string;
  /** Current intra-round drawdown as a fraction (canonical decimal string). */
  readonly drawdown: string;
}

/** The full state snapshot an evaluation runs against. */
export interface RefereeState {
  /** Global kill switch; when active, everything halts before any other rule. */
  readonly killSwitch: { readonly active: boolean; readonly reason?: string | null };
  readonly agent: AgentState;
  /** Metadata for a `transfer` Intent's destination, when available. */
  readonly destination?: DestinationInfo;
}

/**
 * The outcome of evaluating one Intent. `modified_intent`/`clipped` are present
 * only for a CLIP: the payload was reduced to a cap, which invalidates the
 * original signature, so the rail executes these post-clip parameters while the
 * original `intent_hash`/signature are retained for audit only (never re-signed).
 */
export interface RefereeResult {
  readonly decision: Decision;
  readonly severity: Severity;
  /** Stable id of the rule that decided, e.g. `fresh_wallet_transfer_block`. */
  readonly rule_fired: string;
  /** Structured rationale persisted to `policy_events.detail_json`. */
  readonly detail: Record<string, unknown>;
  /** Present iff `decision === 'CLIP'`: the Intent with reduced parameters. */
  readonly modified_intent?: Intent;
  /** True iff a parameter was clipped. */
  readonly clipped?: boolean;
}

/**
 * A single policy rule: a pure function that either fires (returns a result) or
 * passes (returns `null`, deferring to the next rule). Rules must not perform
 * IO; persistence is the caller's job (`record.ts`).
 */
export type Rule = (
  intent: Intent,
  state: RefereeState,
  config: RefereeConfig,
) => RefereeResult | null;
