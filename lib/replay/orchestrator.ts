import { CONFIG } from '@/lib/config/constants';
import { SEED_AGENTS, getSeedAgent, resolveSeedSigner } from '@/lib/agents/seed';
import { listAgentsByScore } from '@/lib/db/repos/agents';
import { insertExecution } from '@/lib/db/repos/executions';
import { insertIntentReserving, type NewIntent } from '@/lib/db/repos/intents';
import { insertOutcome } from '@/lib/db/repos/outcomes';
import { readKillSwitchState, type KillSwitchState } from '@/lib/db/repos/kill-switch';
import { listPolicyEventsByAgentRound } from '@/lib/db/repos/policy-events';
import { listSeedOutcomesByAgentRound } from '@/lib/db/repos/outcomes';
import type { AgentRow, OutcomeRow, PolicyEventRow } from '@/lib/db/schema';
import type { Queryable } from '@/lib/db/types';
import type { Context, Intent } from '@/lib/intent/types';
import type { ElfaSignalProvider } from '@/lib/signals/elfa';
import type { NansenSignalProvider } from '@/lib/signals/nansen';
import { signIntent } from '@/lib/intent/sign';
import { validateIntent, type ValidateOptions } from '@/lib/intent/validate';
import { deriveRouterAgents, loadPrevAllocations, recordRoute } from '@/lib/router/record';
import type { RouterState } from '@/lib/router/types';
import { runReferee } from '@/lib/referee/record';
import type { RefereeState } from '@/lib/referee/types';
import { deriveScoreInputs, recordScore } from '@/lib/scoring/record';
import type { ScoreInputs, ScoreResult } from '@/lib/scoring/types';
import type { DemoArc } from '@/seed';

import { composeIntent } from './compose';
import { consumeAttackArm } from './control';
import { planTicks, roundCount, tickInstantMs, type SchedulerTiming } from './scheduler';
import { createSeedRail, settleWithFallback, type Rail } from './rail';
import { ensureRound, setupArc, type ArcSetup } from './setup';
import { signalsFor } from './signals';

/**
 * The demo-spine orchestrator (architecture.txt §6.5).
 *
 * Drives the frozen arc through the **real** pipeline, tick by tick: each agent's
 * decision is composed, signed, persisted (reserving its nonce), and run through
 * the real referee; an allowed Intent settles on the seed rail and writes a real
 * `executions(rail=seed)` + `outcomes` pair. At each round's settle tick it
 * scores every agent from the round's persisted facts (P1.2) and re-routes
 * capital for the next round (P1.3) — score **before** route, with the
 * attestation step (P1.8) reserved as a seam in between (see {@link RunArcHooks}).
 *
 * Determinism: the only clock is the arc's virtual clock; Intents are stamped
 * and validated against `tickInstant(tick)`, never `Date.now()`, so the same
 * `(arc, config)` produces a byte-identical sequence of signed Intents,
 * decisions, and persisted rows. Pacing (sleeping between ticks for the live
 * demo) is the caller's concern and never feeds back into this logic. The one
 * deliberate external input is the operator kill switch, read once per round: an
 * active switch HALTs every Intent regardless of `(arc, config)`. That override
 * is the whole point of an emergency stop; with the switch inactive (the seeded
 * default) the sequence stays byte-identical.
 *
 * ## Concurrency
 * Each round's settle (score all agents + route the next round) is one logical
 * write, wrapped in a single `BEGIN…COMMIT`, so a partial settle never persists a
 * non-conserving round (the contract `recordRoute`/`recordScore` require). The
 * caller MUST therefore pass a single-connection `Queryable` (a pool *client*),
 * not the shared pool.
 */

/** Optional seams for observability and the P1.8 attestation step. */
export interface RunArcHooks {
  /**
   * Invoked after an agent is scored at a settle, **before** capital re-routes.
   * This is the attestation seam (P1.8): an implementation will anchor the score
   * on-chain here. In the spine it is a no-op observability hook.
   */
  readonly onScored?: (event: {
    readonly agentId: string;
    readonly roundId: string;
    readonly scoreR: string;
    readonly crashed: boolean;
  }) => void | Promise<void>;
  /**
   * The P1.8 attestation seam, invoked after an agent is scored at a settle and
   * **inside the settle transaction** — so anything it persists (the optimistic
   * attestation mirror) is atomic with the score it anchors. It receives the
   * transaction's `db` plus the round's facts (the score result, the scoring
   * inputs, and the immutable outcomes/policy events). The on-chain write itself
   * is *not* done here; the caller queues it for after the commit so chain
   * latency never blocks the arc. A no-op when unset — the default demo path is
   * byte-identical.
   */
  readonly onAttest?: (event: {
    readonly db: Queryable;
    readonly agent: {
      readonly seedId: string;
      readonly uuid: string;
      readonly onchainId: string | null;
    };
    readonly roundId: string;
    readonly result: ScoreResult;
    readonly inputs: ScoreInputs;
    readonly outcomes: readonly OutcomeRow[];
    readonly policyEvents: readonly PolicyEventRow[];
  }) => void | Promise<void>;
  /** Invoked once per processed tick (after settle), for progress/streaming. */
  readonly onTick?: (event: {
    readonly index: number;
    readonly roundIndex: number;
    readonly isRoundSettle: boolean;
  }) => void | Promise<void>;
}

/** Options for {@link runArc}. */
export interface RunArcOptions {
  /** Execution rail; defaults to the deterministic seed rail backed by the arc. */
  readonly rail?: Rail;
  /**
   * Optional **credibility** rail (P2.1): a live venue (Byreal) settled *in
   * addition to* the deterministic seed rail. Allowed Intents that settle on the
   * seed path are also offered to this rail; a non-null fill is recorded as a
   * separate `executions(rail='byreal')` + `outcomes` pair for the verifiable
   * surface, and is **excluded from scoring** (the §3 boundary). Failures are
   * swallowed — the arc never depends on it. Unset (the default) ⇒ no Byreal
   * rows ⇒ the arc is byte-identical.
   */
  readonly credibilityRail?: Rail;
  /** Timing slice; defaults to `CONFIG.timing`. */
  readonly timing?: SchedulerTiming;
  /** Extra validator options merged over the defaults (signer resolver, skew). */
  readonly validate?: Partial<ValidateOptions>;
  /** Setup owner string for created agents. */
  readonly owner?: string;
  /**
   * Optional **Nansen smart-money signal** (P2.2): a read-only provider whose
   * cached snapshot is injected into the leader's `context.signals.nansen`
   * (see {@link signalsFor}). It is polled once per tick via
   * `maybeRefresh`, which never blocks the tick. Unset (the default) ⇒ every
   * agent's `signals` is `{}` ⇒ the arc is byte-identical. Even when set, seed
   * strategies ignore `context.signals`, so the produced Intents — and thus the
   * deterministic arc — are unchanged; the signal is observability/seam only.
   */
  readonly nansen?: NansenSignalProvider;
  /**
   * Optional **Elfa social-sentiment signal** (P3.1): a read-only provider whose
   * current value (live snapshot or deterministic seeded mock) is injected into
   * the runner-up's `context.signals.elfa` (see {@link signalsFor}). Polled once
   * per tick via `maybeRefresh`, which never blocks the tick (a no-op in mock
   * mode). Unset (the default) ⇒ the runner-up's `signals` is `{}`. Even when set,
   * seed strategies ignore `context.signals`, so the arc is unchanged; in mock
   * mode the value is byte-stable, in live mode it is observability/seam only.
   */
  readonly elfa?: ElfaSignalProvider;
  readonly hooks?: RunArcHooks;
}

/** A settled allocation, keyed by the stable seed `agent_id`. */
export interface ArcAllocation {
  readonly agentId: string;
  readonly amount: string;
}

/** The outcome of a full arc run. */
export interface RunArcResult {
  readonly rounds: number;
  readonly ticks: number;
  /** Stable seed ids of agents that floor-crashed during the arc. */
  readonly crashedAgentIds: readonly string[];
  /** The final round's persisted allocations (the end-state of the capital pool). */
  readonly finalAllocations: readonly ArcAllocation[];
}

/**
 * Enforce the single-connection contract (see the module "Concurrency" note).
 * Each round's settle wraps score + route in one `BEGIN…COMMIT`, which is only
 * atomic on a dedicated connection. The shared Neon `Pool` also satisfies
 * `Queryable`, but routes every `.query` to an arbitrary pooled connection — so
 * `BEGIN`, the per-agent writes, and `COMMIT` could each land on a different
 * socket, silently dropping the transaction and permitting a non-conserving
 * partial settle. Reject the bare pool loudly: a pooled *client* (from
 * `pool.connect()`) exposes `release`; the `Pool` itself does not, and a plain
 * test fake exposes neither — so only the shared pool is refused.
 */
function assertDedicatedClient(db: Queryable): void {
  const candidate = db as { connect?: unknown; release?: unknown };
  if (typeof candidate.connect === 'function' && typeof candidate.release !== 'function') {
    throw new TypeError(
      'runArc requires a single-connection client (pool.connect()), not the shared pool: ' +
        'the per-round settle transaction is only atomic on a dedicated connection.',
    );
  }
}

/** Map a validated, typed {@link Intent} to its `intents` table columns. */
function intentToColumns(
  intent: Intent,
  ids: { readonly roundId: string; readonly agentUuid: string; readonly hash: string },
): NewIntent {
  const base: NewIntent = {
    round_id: ids.roundId,
    agent_id: ids.agentUuid,
    intent_hash: ids.hash,
    action: intent.action,
    nonce: intent.nonce,
    ttl: new Date(intent.ttl),
    signature: intent.signature,
    raw_json: intent,
    size: intent.size,
  };
  if (intent.action === 'transfer') {
    return { ...base, target_address: intent.target_address ?? null };
  }
  // open | modify | close all carry market/max_slippage; trades add side/leverage.
  const withTrade: NewIntent = {
    ...base,
    market: intent.market,
    max_slippage: intent.max_slippage,
    tp: intent.tp ?? null,
    sl: intent.sl ?? null,
  };
  // Discriminate on the object (not just `action`) so TS narrows the variant.
  if (intent.action === 'open' || intent.action === 'modify') {
    return { ...withTrade, side: intent.side, leverage: intent.leverage };
  }
  return withTrade;
}

/** Per-round context cached across the round's ticks. */
interface RoundContext {
  readonly index: number;
  readonly id: string;
  /** `agents.id` → current allocation amount (the round's budget basis). */
  readonly allocations: ReadonlyMap<string, string>;
  /** `agents.id` → current agent row (for the denormalized score). */
  readonly agents: ReadonlyMap<string, AgentRow>;
  /**
   * Operator kill switch, read once per round and held stable across its ticks.
   * While active, the referee HALTs every Intent. Read fails open (see
   * {@link readKillSwitchState}).
   */
  readonly killSwitch: KillSwitchState;
}

/** Load (and create if needed) the context for `roundIndex`. */
async function loadRoundContext(
  db: Queryable,
  arc: DemoArc,
  roundIndex: number,
): Promise<RoundContext> {
  const round = await ensureRound(db, roundIndex, `seed/${arc.version}`);
  const prev = await loadPrevAllocations(db, round.id);
  const allocations = new Map(prev.map((p) => [p.agentId, p.amount]));
  const agentRows = await listAgentsByScore(db);
  const agents = new Map(agentRows.map((a) => [a.id, a]));
  const killSwitch = await readKillSwitchState(db);
  return { index: roundIndex, id: round.id, allocations, agents, killSwitch };
}

/** Process one agent at one tick: compose → sign → validate → referee → settle. */
async function processAgentTick(
  db: Queryable,
  arc: DemoArc,
  agentId: string,
  agentUuid: string,
  tick: { readonly index: number; readonly isAttack: boolean },
  round: RoundContext,
  timing: SchedulerTiming,
  validate: ValidateOptions,
  rail: Rail,
  credibilityRail: Rail | undefined,
  nansen: NansenSignalProvider | undefined,
  elfa: ElfaSignalProvider | undefined,
): Promise<void> {
  const agent = getSeedAgent(agentId);
  if (agent === undefined) return;

  const allocation = round.allocations.get(agentUuid) ?? '0';
  const agentRow = round.agents.get(agentUuid);
  const context: Context = {
    agent_id: agentId,
    round_id: round.id,
    markets: arc.ticks[tick.index]?.markets ?? {},
    allocation,
    remaining_budget: allocation,
    score: agentRow === undefined ? CONFIG.scoring.score_0 : Number(agentRow.score_current),
    signals: signalsFor(agentId, { nansen, elfa }),
  };

  const unsigned = await composeIntent({
    arc,
    agent,
    context,
    tickIndex: tick.index,
    tickRateMs: timing.tick_rate_ms,
    isAttack: tick.isAttack,
  });
  const signed = await signIntent(unsigned, agent.privateKey);

  // The virtual clock for this tick — the only `now` the pipeline ever sees.
  const now = new Date(tickInstantMs(arc.baseTimeMs, tick.index, timing.tick_rate_ms));
  const tickValidate: ValidateOptions = { ...validate, now };

  const validated = await validateIntent(signed, tickValidate);
  if (!validated.ok) return; // Structurally invalid: nothing to persist or settle.

  // Reserve the nonce + persist the Intent before the referee runs. The referee
  // re-validates (defense in depth) but is NOT given an `isNonceUsed` probe: the
  // nonce is now reserved in the DB, so probing it would falsely reject this very
  // Intent as a replay. Durable anti-replay is the reservation, not the probe.
  const intentRow = await insertIntentReserving(
    db,
    intentToColumns(validated.intent, {
      roundId: round.id,
      agentUuid,
      hash: validated.intent_hash,
    }),
  );
  if (intentRow === null) return; // Nonce already used (replay): skip silently.

  const state: RefereeState = {
    killSwitch: round.killSwitch,
    agent: {
      allocation,
      remaining_budget: allocation,
      drawdown: '0',
      // An operator per-agent HALT cuts execution here too (rule #1b), mirroring
      // the router's gate-out. Seed agents default to 'active', so the arc stays
      // byte-identical unless an operator explicitly halts one.
      halted: agentRow?.status === 'halted',
    },
  };
  const decision = await runReferee({
    db,
    input: signed,
    ids: { intent_id: intentRow.id, agent_id: agentUuid, round_id: round.id },
    state,
    validate: tickValidate,
  });

  // Only an ALLOW or CLIP reaches the rail; a REJECT/HALT already recorded its
  // `policy_event` and produces no execution/outcome (the drain's path).
  if (decision.decision !== 'ALLOW' && decision.decision !== 'CLIP') return;

  const seedOutcome = arc.outcomes[agentId]?.[tick.index];
  if (seedOutcome === undefined) return;
  const executed = decision.modified_intent ?? validated.intent;
  const { fill } = await settleWithFallback(
    rail,
    { intent: executed, agentId, tickIndex: tick.index, intentHash: validated.intent_hash },
    {
      status: 'filled',
      outcome: seedOutcome,
      rail_order_id: `seed-${agentId}-${tick.index}`,
    },
  );

  const execution = await insertExecution(db, {
    intent_id: intentRow.id,
    status: fill.status,
    rail: 'seed',
    rail_order_id: fill.rail_order_id ?? null,
    request_json: executed,
    response_json: fill.response ?? fill.outcome,
  });
  await insertOutcome(db, {
    agent_id: agentUuid,
    round_id: round.id,
    execution_id: execution.id,
    pnl_realized: fill.outcome.pnl_realized,
    pnl_marked: fill.outcome.pnl_marked,
    capital_at_risk: fill.outcome.capital_at_risk,
    fees: fill.outcome.fees,
    position_delta: fill.outcome.position_delta,
    drawdown: fill.outcome.drawdown,
  });

  // Credibility settlement (P2.1): also settle the same allowed Intent on the
  // live Byreal rail, recording a separate `rail='byreal'` execution+outcome for
  // the verifiable surface. It is best-effort and *excluded from scoring*; a
  // miss or error never affects the deterministic seed settlement above.
  await settleCredibility(db, credibilityRail, {
    intent: executed,
    agentId,
    tickIndex: tick.index,
    intentHash: validated.intent_hash,
    intentId: intentRow.id,
    agentUuid,
    roundId: round.id,
  });
}

/** Inputs to the credibility settlement: the executed Intent plus its row ids. */
interface CredibilitySettleArgs {
  readonly intent: Intent;
  readonly agentId: string;
  readonly tickIndex: number;
  readonly intentHash: string;
  readonly intentId: string;
  readonly agentUuid: string;
  readonly roundId: string;
}

/**
 * Settle an allowed Intent on the optional credibility rail (P2.1) and persist
 * its real fill as a `rail='byreal'` execution + outcome.
 *
 * This is a strict side-channel: it runs *after* the deterministic seed
 * settlement, never mutates it, and is fully guarded — a `null` fill (the rail
 * deferred) or any thrown error is swallowed so the arc never stalls or diverges
 * on a live-venue hiccup. Its outcome rows are excluded from scoring by
 * {@link listSeedOutcomesByAgentRound}, preserving the §3 determinism boundary.
 */
async function settleCredibility(
  db: Queryable,
  rail: Rail | undefined,
  args: CredibilitySettleArgs,
): Promise<void> {
  if (rail === undefined) return;
  try {
    const fill = await rail.execute({
      intent: args.intent,
      agentId: args.agentId,
      tickIndex: args.tickIndex,
      intentHash: args.intentHash,
    });
    if (fill === null) return; // Rail deferred — nothing to record.

    const execution = await insertExecution(db, {
      intent_id: args.intentId,
      status: fill.status,
      rail: 'byreal',
      rail_order_id: fill.rail_order_id ?? null,
      request_json: args.intent,
      response_json: fill.response ?? fill.outcome,
    });
    await insertOutcome(db, {
      agent_id: args.agentUuid,
      round_id: args.roundId,
      execution_id: execution.id,
      pnl_realized: fill.outcome.pnl_realized,
      pnl_marked: fill.outcome.pnl_marked,
      capital_at_risk: fill.outcome.capital_at_risk,
      fees: fill.outcome.fees,
      position_delta: fill.outcome.position_delta,
      drawdown: fill.outcome.drawdown,
    });
  } catch (err) {
    // The credibility rail is best-effort: a live-rail outage/timeout/parse miss
    // — or a failed DB write of the byreal row — must NOT stall the deterministic
    // arc. The seed settlement already stands and the score is unaffected, so we
    // degrade silently. We still emit an operator signal (name only, never the
    // intent payload or credentials) so a persistently failing rail or a DB write
    // fault is observable rather than vanishing without trace.
    const name = err instanceof Error ? err.name : 'unknown';
    console.error(`[byreal] credibility settle failed (seed settlement stands): ${name}`);
  }
}

/**
 * Settle a round inside one transaction: score every agent, fire the attestation
 * seam, then route capital for the next round. Returns the threaded router state
 * and the set of crashed `agents.id`.
 */
async function settleRound(
  db: Queryable,
  arc: DemoArc,
  settleTickIndex: number,
  roundIndex: number,
  totalRounds: number,
  round: RoundContext,
  setup: ArcSetup,
  routerState: RouterState,
  hooks: RunArcHooks | undefined,
): Promise<{ routerState: RouterState; crashed: Set<string> }> {
  await db.query('BEGIN');
  try {
    const crashed = new Set<string>();
    for (const agent of SEED_AGENTS) {
      const uuid = setup.agentsBySeedId.get(agent.id)?.id;
      if (uuid === undefined) continue;
      // Seed-only read: the Byreal credibility rail (P2.1) may have written
      // `rail='byreal'` outcomes for this agent/round, but the deterministic
      // score must never see them (the §3 determinism boundary).
      const outcomes = await listSeedOutcomesByAgentRound(db, uuid, round.id);
      const events = await listPolicyEventsByAgentRound(db, uuid, round.id);
      const inputs = deriveScoreInputs(outcomes, events);
      const { result } = await recordScore({ db, agentId: uuid, roundId: round.id, inputs });
      if (result.crashed) crashed.add(uuid);
      await hooks?.onScored?.({
        agentId: agent.id,
        roundId: round.id,
        scoreR: result.score_r,
        crashed: result.crashed,
      });
      await hooks?.onAttest?.({
        db,
        agent: {
          seedId: agent.id,
          uuid,
          onchainId: setup.agentsBySeedId.get(agent.id)?.agent_id_onchain ?? null,
        },
        roundId: round.id,
        result,
        inputs,
        outcomes,
        policyEvents: events,
      });
    }

    let nextState = routerState;
    const nextIndex = roundIndex + 1;
    if (nextIndex < totalRounds) {
      const nextRound = await ensureRound(db, nextIndex, `seed/${arc.version}`);
      const agentRows = await listAgentsByScore(db);
      const routerAgents = deriveRouterAgents(agentRows, { crashedAgentIds: crashed });
      const prev = await loadPrevAllocations(db, round.id);
      const trigger = crashed.size > 0 ? 'crash' : 'settle';
      const routed = await recordRoute({
        db,
        roundId: nextRound.id,
        agents: routerAgents,
        prev,
        state: { tick: settleTickIndex, cooldownUntilTick: routerState.cooldownUntilTick },
        trigger,
      });
      nextState = routed.result.state;
    }

    await db.query('COMMIT');
    return { routerState: nextState, crashed };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/**
 * Run the full demo arc against `db`. Idempotent setup, then a single forward
 * pass over the tick plan; returns the crashed agents and the final allocation
 * end-state. `db` must be a single-connection client (see the module note).
 */
export async function runArc(
  db: Queryable,
  arc: DemoArc,
  options: RunArcOptions = {},
): Promise<RunArcResult> {
  assertDedicatedClient(db);
  const timing = options.timing ?? CONFIG.timing;
  const validate: ValidateOptions = { resolveSigner: resolveSeedSigner, ...options.validate };
  const rail =
    options.rail ??
    createSeedRail((agentId, tickIndex) => {
      const outcome = arc.outcomes[agentId]?.[tickIndex];
      if (outcome === undefined) {
        throw new RangeError(`seed rail: no fill for ${agentId} at tick ${tickIndex}`);
      }
      return outcome;
    });

  const setup = await setupArc(
    db,
    arc,
    options.owner === undefined ? {} : { owner: options.owner },
  );
  const plan = planTicks(arc.totalTicks, timing);
  const totalRounds = roundCount(arc.totalTicks, timing);

  let routerState = setup.routerState;
  const crashedUuids = new Set<string>();
  let round = await loadRoundContext(db, arc, 0);

  for (const tick of plan) {
    if (tick.roundIndex !== round.index) {
      round = await loadRoundContext(db, arc, tick.roundIndex);
    }

    // Fire-and-forget: may start a detached Nansen/Elfa refresh on its slow
    // cadence. Never awaited — the tick must not block on the network (P2.2/P3.1
    // invariant). Elfa's `maybeRefresh` is a no-op in mock mode.
    options.nansen?.maybeRefresh(tick.index);
    options.elfa?.maybeRefresh(tick.index);

    for (const agent of SEED_AGENTS) {
      const uuid = setup.agentsBySeedId.get(agent.id)?.id;
      if (uuid === undefined) continue;
      const scripted = tick.index === arc.attack.atTick && agent.id === arc.attack.targetAgentId;
      const armed = !scripted && agent.id === arc.attack.targetAgentId && consumeAttackArm();
      await processAgentTick(
        db,
        arc,
        agent.id,
        uuid,
        { index: tick.index, isAttack: scripted || armed },
        round,
        timing,
        validate,
        rail,
        options.credibilityRail,
        options.nansen,
        options.elfa,
      );
    }

    if (tick.isRoundSettle) {
      const settled = await settleRound(
        db,
        arc,
        tick.index,
        tick.roundIndex,
        totalRounds,
        round,
        setup,
        routerState,
        options.hooks,
      );
      routerState = settled.routerState;
      for (const uuid of settled.crashed) crashedUuids.add(uuid);
    }

    await options.hooks?.onTick?.({
      index: tick.index,
      roundIndex: tick.roundIndex,
      isRoundSettle: tick.isRoundSettle,
    });
  }

  const uuidToSeedId = new Map(
    [...setup.agentsBySeedId.entries()].map(([seedId, row]) => [row.id, seedId]),
  );
  const lastRound = await loadRoundContext(db, arc, totalRounds - 1);
  const finalAllocations = await loadPrevAllocations(db, lastRound.id);

  return {
    rounds: totalRounds,
    ticks: arc.totalTicks,
    crashedAgentIds: [...crashedUuids].map((uuid) => uuidToSeedId.get(uuid) ?? uuid),
    finalAllocations: finalAllocations.map((a) => ({
      agentId: uuidToSeedId.get(a.agentId) ?? a.agentId,
      amount: a.amount,
    })),
  };
}
