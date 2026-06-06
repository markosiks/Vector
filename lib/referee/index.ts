/**
 * The Referee / Firewall (architecture §6.3, P1.1): Vector's bounded-execution
 * gate. A validated, signed Intent in — an ordered ALLOW / CLIP / REJECT / HALT
 * decision out, with one `policy_event` emitted per decision. See
 * `docs/referee.md` for the rule table and decision matrix.
 */

export { evaluate } from './evaluate';
export { runReferee, type RefereeIds, type RunRefereeArgs } from './record';
export { BLOCKING_RULES, CLIPPING_RULES } from './rules';
export type {
  AgentState,
  Decision,
  DestinationInfo,
  RefereeConfig,
  RefereeResult,
  RefereeState,
  Rule,
  Severity,
} from './types';
