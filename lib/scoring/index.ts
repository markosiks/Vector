/**
 * Scoring engine (P1.2, architecture.txt §6.1).
 *
 * `score()` is the pure, deterministic AgentScore function; `record.ts` derives
 * its inputs from persisted outcomes/policy events and writes the `scores` row
 * plus the denormalized `agents.score_current`/`status` cache.
 */
export { score, type ScoringConfig } from './score';
export {
  deriveScoreInputs,
  previousScore,
  recordScore,
  type RecordScoreArgs,
  type RecordScoreResult,
} from './record';
export type { ScoreComponents, ScoreInputs, ScoreResult } from './types';
