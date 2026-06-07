import type { LeaderboardEntryDto, PolicyEventDto } from '@/lib/api/dto';
import type { PolicyDecision } from '@/lib/db/schema';

/**
 * Factories for the Arena pure-logic tests: minimal, overridable DTOs shaped
 * exactly like the read API returns. Decimal columns are kept as strings (as the
 * wire does) so the derivations are exercised on realistic input.
 */

let seq = 0;
const uuid = (n: number): string => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

export function makeAgent(over: Partial<LeaderboardEntryDto> = {}): LeaderboardEntryDto {
  seq += 1;
  return {
    id: over.id ?? uuid(seq),
    display_name: over.display_name ?? `agent-${seq}`,
    owner: over.owner ?? 'ops',
    strategy_kind: over.strategy_kind ?? 'seed',
    status: over.status ?? 'active',
    score_current: over.score_current ?? '50',
    agent_id_onchain: over.agent_id_onchain ?? null,
    allocation: over.allocation ?? null,
    created_at: over.created_at ?? '2026-06-07T12:00:00.000Z',
  };
}

export function makePolicyEvent(over: Partial<PolicyEventDto> = {}): PolicyEventDto {
  seq += 1;
  const decision: PolicyDecision = over.decision ?? 'ALLOW';
  return {
    id: over.id ?? uuid(seq),
    intent_id: over.intent_id ?? uuid(seq + 100000),
    agent_id: over.agent_id ?? uuid(1),
    round_id: over.round_id ?? uuid(900000),
    rule_fired: over.rule_fired ?? 'none',
    decision,
    severity:
      over.severity ?? (decision === 'HALT' ? 'halt' : decision === 'REJECT' ? 'hard' : 'none'),
    detail: over.detail ?? null,
    created_at: over.created_at ?? '2026-06-07T12:00:00.000Z',
  };
}

/** A deterministic LCG so fuzz runs are reproducible (control the randomness). */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
