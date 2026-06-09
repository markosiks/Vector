import { CONFIG } from '@/lib/config/constants';
import { ATTACKER_ADDRESS, SEED_TTL_HORIZON_MS } from '@/seed';
import { getSeedAgent, resolveSeedSigner, type SeedAgent } from '@/lib/agents/seed';
import { BadRequestError } from '@/lib/api/errors';
import { getLatestRound } from '@/lib/db/repos/rounds';
import {
  getIntentByAgentNonce,
  insertIntentReserving,
  type NewIntent,
} from '@/lib/db/repos/intents';
import { getPolicyEventByIntent } from '@/lib/db/repos/policy-events';
import { listLeaderboard, type LeaderboardRow } from '@/lib/db/repos/leaderboard';
import { readKillSwitchState } from '@/lib/db/repos/kill-switch';
import type { Queryable } from '@/lib/db/types';
import type { Intent } from '@/lib/intent/types';
import { signIntent } from '@/lib/intent/sign';
import { validateIntent, type ValidateOptions } from '@/lib/intent/validate';
import { evaluate } from '@/lib/referee/evaluate';
import { runReferee } from '@/lib/referee/record';
import type { RefereeResult, RefereeState } from '@/lib/referee/types';

import { buildDrainIntent } from '@/lib/replay/attack';

/**
 * The operator console's scripted-attack injection (P2.4, task 4).
 *
 * This is the *full operator console around the already-working mechanism*: it
 * builds the canonical drain Intent (the P1.4 `buildDrainIntent`) for the current
 * leader, signs it with that seed agent's key, and runs it through the **real**
 * referee (`runReferee`) — exactly the path a scripted-arc attack takes. Nothing
 * here softens or special-cases the block: a `transfer` to the canned fresh
 * wallet is REJECTed `hard` by rule #3 (`fresh_wallet_transfer_block`), or HALTed
 * if the global kill switch / the leader's per-agent HALT is active. The decision
 * is persisted as a real `policy_event`, so it surfaces in the P1.5 feed.
 *
 * Idempotency: the injected Intent's `nonce` is `op-attack:<idempotencyKey>`,
 * unique per operator click. The durable `intents_agent_nonce_unique` constraint
 * makes a retried/double-submitted click a no-op — the reserve loses the race and
 * returns `null`, so no second Intent, no second `policy_event` is written. A
 * retry then reports the *persisted* Intent (its real id/hash) and its *recorded*
 * decision, read back from the row that won. It must not re-derive them from a
 * freshly built Intent: the rebuilt Intent carries a new wall-clock `ttl`, so its
 * hash drifts between calls, and `evaluate` over the *current* state could report
 * a decision (e.g. HALT after a later stop) that never happened to the original.
 */

/** The leader the attack targets, resolved from the live leaderboard. */
export interface AttackTarget {
  /** The current round the attack is injected into. */
  readonly roundId: string;
  /** The leader agent row (top scorer that maps to a known seed signer). */
  readonly leader: LeaderboardRow;
  /** The seed agent (its fixed signer) the drain is signed as. */
  readonly seed: SeedAgent;
  /** The leader's allocation this round — the drain size (clamped if zero). */
  readonly allocation: string;
}

/** The outcome of an attack injection. */
export interface AttackInjectionResult {
  /** The referee's decision (REJECT/hard in the happy path; HALT under a stop). */
  readonly decision: RefereeResult;
  /**
   * The persisted Intent's id. On an idempotent retry this is the id of the
   * *original* reserved Intent (read back), so the response points at the real
   * persisted row; `null` only in the defensive case where that row is not
   * visible.
   */
  readonly intentId: string | null;
  /** Canonical hash of the injected Intent (audit anchor). */
  readonly intentHash: string;
  /** True when the `(agent, nonce)` was already used — no new rows were written. */
  readonly duplicate: boolean;
  /** The resolved target (round, leader, size). */
  readonly target: AttackTarget;
}

/** Inputs to {@link injectScriptedAttack}. */
export interface InjectAttackArgs {
  /** A single-connection client (the route wraps the call in a transaction). */
  readonly db: Queryable;
  /** Per-click idempotency key (a uuid). De-dupes retries of the same click. */
  readonly idempotencyKey: string;
  /** Reference clock; injectable for deterministic tests. Defaults to `now`. */
  readonly now?: Date;
}

/**
 * Resolve the attack target: the current round and the highest-scored agent on
 * the leaderboard that maps to a known seed signer (the "compromised leader").
 * Throws a {@link BadRequestError} when there is no round yet or no attackable
 * seed agent — both are caller preconditions, not server faults.
 */
export async function resolveAttackTarget(db: Queryable): Promise<AttackTarget> {
  const round = await getLatestRound(db);
  if (round === null) {
    throw new BadRequestError('No round exists yet to inject an attack into', 'no_round');
  }
  const board = await listLeaderboard(db, round.id);
  const leader = board.find((row) => getSeedAgent(row.display_name) !== undefined);
  if (leader === undefined) {
    throw new BadRequestError('No attackable seed leader on the leaderboard', 'no_target');
  }
  const seed = getSeedAgent(leader.display_name);
  if (seed === undefined) {
    // Unreachable given the `find` predicate, but keeps the type non-null.
    throw new BadRequestError('No attackable seed leader on the leaderboard', 'no_target');
  }
  return { roundId: round.id, leader, seed, allocation: leader.allocation_amount ?? '0' };
}

/** Map a validated drain (a `transfer`) Intent to its `intents` columns. */
function drainIntentColumns(
  intent: Intent,
  ids: { readonly roundId: string; readonly agentUuid: string; readonly hash: string },
): NewIntent {
  if (intent.action !== 'transfer') {
    // The drain is always a `transfer`; a non-transfer here is a programmer error.
    throw new Error('injectScriptedAttack: drain Intent must be a transfer');
  }
  return {
    round_id: ids.roundId,
    agent_id: ids.agentUuid,
    intent_hash: ids.hash,
    action: 'transfer',
    target_address: intent.target_address ?? null,
    size: intent.size,
    nonce: intent.nonce,
    ttl: new Date(intent.ttl),
    signature: intent.signature,
    raw_json: intent,
  };
}

/**
 * Build the result for an idempotent retry by reading back the row that won the
 * `(agent, nonce)` reservation. Reports the persisted Intent's id/hash and its
 * recorded `policy_event` decision. Falls back to a pure re-evaluation only in
 * the defensive cases where the persisted row or its event is not visible
 * (which cannot happen normally — the Intent and its event commit in one
 * transaction).
 */
async function duplicateResult(
  db: Queryable,
  target: AttackTarget,
  nonce: string,
  rebuiltHash: string,
  reevaluate: () => RefereeResult,
): Promise<AttackInjectionResult> {
  const persisted = await getIntentByAgentNonce(db, target.leader.id, nonce);
  if (persisted === null) {
    return {
      decision: reevaluate(),
      intentId: null,
      intentHash: rebuiltHash,
      duplicate: true,
      target,
    };
  }
  const event = await getPolicyEventByIntent(db, persisted.id);
  const decision: RefereeResult =
    event === null
      ? reevaluate()
      : {
          decision: event.decision,
          severity: event.severity,
          rule_fired: event.rule_fired,
          detail: (event.detail_json as Record<string, unknown> | null) ?? {},
        };
  return {
    decision,
    intentId: persisted.id,
    intentHash: persisted.intent_hash,
    duplicate: true,
    target,
  };
}

/**
 * Inject the canonical drain against the current leader through the real
 * referee. The caller (the route) must pass a single-connection client and wrap
 * this in a transaction together with its audit write so the Intent, its
 * `policy_event`, and the `operator_action` row commit atomically.
 */
export async function injectScriptedAttack(args: InjectAttackArgs): Promise<AttackInjectionResult> {
  const { db, idempotencyKey } = args;
  const now = args.now ?? new Date();

  const target = await resolveAttackTarget(db);
  const killSwitch = await readKillSwitchState(db);

  const state: RefereeState = {
    killSwitch,
    agent: {
      allocation: target.allocation,
      remaining_budget: target.allocation,
      drawdown: '0',
      halted: target.leader.status === 'halted',
    },
  };

  // Build the canonical drain, then stamp a per-click nonce + a fresh ttl. The
  // nonce carries the idempotency key so a retried click reserves nothing.
  const unsigned = buildDrainIntent({
    agentId: target.seed.id,
    attackerAddress: ATTACKER_ADDRESS,
    size: target.allocation,
  });
  const nonce = `op-attack:${idempotencyKey}`;
  const stamped = {
    ...unsigned,
    nonce,
    ttl: new Date(now.getTime() + SEED_TTL_HORIZON_MS).toISOString(),
  };
  const signed = await signIntent(stamped, target.seed.privateKey);

  // Validate before reserving. We deliberately do NOT pass `isNonceUsed`: durable
  // anti-replay is the DB reservation below, and probing the nonce here would
  // falsely reject the very Intent we are about to persist (orchestrator pattern).
  const validate: ValidateOptions = { resolveSigner: resolveSeedSigner, now };
  const validated = await validateIntent(signed, validate);
  if (!validated.ok) {
    // The canonical drain is well-formed by construction; a failure here is an
    // internal invariant breach, not client input. Surface it as a 500 (thrown).
    throw new Error(`injectScriptedAttack: drain failed validation at ${validated.stage}`);
  }

  const intentRow = await insertIntentReserving(
    db,
    drainIntentColumns(validated.intent, {
      roundId: target.roundId,
      agentUuid: target.leader.id,
      hash: validated.intent_hash,
    }),
  );

  if (intentRow === null) {
    // Idempotent retry: the (agent, nonce) is already reserved by an earlier
    // click. Report the *persisted* Intent and its *recorded* decision — never a
    // freshly built one — so the response is truly idempotent (same key → same
    // hash) and reflects what actually happened, independent of the current
    // state or wall-clock.
    return duplicateResult(db, target, nonce, validated.intent_hash, () =>
      evaluate(validated.intent, state, CONFIG.policy),
    );
  }

  const decision = await runReferee({
    db,
    input: signed,
    ids: { intent_id: intentRow.id, agent_id: target.leader.id, round_id: target.roundId },
    state,
    validate,
  });

  return {
    decision,
    intentId: intentRow.id,
    intentHash: validated.intent_hash,
    duplicate: false,
    target,
  };
}
