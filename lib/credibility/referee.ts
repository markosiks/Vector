import type { IntentDto, PolicyEventDto } from '@/lib/api/dto';
import type { PolicyDecision, PolicySeverity } from '@/lib/db/schema';
import { SEVERITY_RANK as _SEVERITY_RANK } from '@/lib/referee/severity';

/**
 * Correlate an agent's recent intents with the referee decisions on them, for
 * the Agent-detail screen (P2.3).
 *
 * The read API returns `intents[]` and `policy_events[]` side by side rather than
 * nested, and the UI joins them by `intent_id` (P1.5). One intent may trip
 * several rules, so this module groups the events per intent and surfaces the
 * **dominant** decision — the most severe outcome — by a fixed precedence, so
 * the row shows "what the firewall ultimately did" without hiding the softer
 * rules that also fired. It is pure data: no React, fully unit/fuzz-testable.
 */

/** Decision precedence, worst-last. A higher rank dominates when an intent
 *  trips several rules (a HALT outranks a REJECT outranks a CLIP outranks ALLOW). */
const DECISION_RANK: Record<PolicyDecision, number> = {
  ALLOW: 0,
  CLIP: 1,
  REJECT: 2,
  HALT: 3,
};

/** Severity precedence, worst-last — the tie-break within one decision.
 *  Re-exported from the shared source of truth (lib/referee/severity.ts, S7). */
const SEVERITY_RANK: Record<PolicySeverity, number> = _SEVERITY_RANK as Record<PolicySeverity, number>;

export function decisionRank(d: PolicyDecision): number {
  return DECISION_RANK[d] ?? 0;
}

export function severityRank(s: PolicySeverity): number {
  return SEVERITY_RANK[s] ?? 0;
}

/** Visual tone for a decision badge — orthogonal to the exact label. */
export type DecisionTone = 'ok' | 'warn' | 'danger' | 'critical';

const DECISION_TONE: Record<PolicyDecision, DecisionTone> = {
  ALLOW: 'ok',
  CLIP: 'warn',
  REJECT: 'danger',
  HALT: 'critical',
};

export function decisionTone(d: PolicyDecision): DecisionTone {
  return DECISION_TONE[d] ?? 'warn';
}

/** An intent paired with the referee events that fired on it. */
export interface IntentDecision {
  readonly intent: IntentDto;
  /** All events on this intent, worst decision first. */
  readonly events: readonly PolicyEventDto[];
  /** The dominant (most severe) event, or `null` if the referee logged none. */
  readonly worst: PolicyEventDto | null;
}

/**
 * Order two events worst-first: by decision rank, then severity, then a stable
 * `created_at`/`id` tie-break so the result is deterministic for a fixed input.
 */
function worseFirst(a: PolicyEventDto, b: PolicyEventDto): number {
  const d = decisionRank(b.decision) - decisionRank(a.decision);
  if (d !== 0) return d;
  const s = severityRank(b.severity) - severityRank(a.severity);
  if (s !== 0) return s;
  const t = b.created_at.localeCompare(a.created_at);
  if (t !== 0) return t;
  return b.id.localeCompare(a.id);
}

/**
 * Group `policyEvents` under their intent and return one {@link IntentDecision}
 * per intent, in the input intent order (the API's newest-first). Events whose
 * `intent_id` matches no listed intent (the intent fell outside the `?limit=`
 * window) are dropped here — the policy-event feed screen owns those — so the
 * detail table never shows a decision with no visible intent to anchor it.
 */
export function correlateIntents(
  intents: readonly IntentDto[],
  policyEvents: readonly PolicyEventDto[],
): IntentDecision[] {
  const byIntent = new Map<string, PolicyEventDto[]>();
  for (const e of policyEvents) {
    const list = byIntent.get(e.intent_id);
    if (list) list.push(e);
    else byIntent.set(e.intent_id, [e]);
  }
  return intents.map((intent) => {
    const events = (byIntent.get(intent.id) ?? []).slice().sort(worseFirst);
    return { intent, events, worst: events[0] ?? null };
  });
}
