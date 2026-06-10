import type { PolicySeverity } from '@/lib/db/schema';

/**
 * Severity precedence map — worst-last. A higher rank dominates when comparing
 * two severity values (e.g. picking the worst decision per intent in the scorer,
 * or ordering events in the credibility display).
 *
 * Single source of truth: imported by both `lib/scoring/record.ts` (scorer
 * aggregation) and `lib/credibility/referee.ts` (display layer). Extracting
 * the map here prevents the two consumers from drifting if a new severity level
 * is introduced.
 */
export const SEVERITY_RANK: Record<string, number> = {
  none: 0,
  soft: 1,
  hard: 2,
  halt: 3,
} satisfies Record<PolicySeverity, number>;
