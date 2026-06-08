import type { Rail, RailFill, RailRequest } from '@/lib/replay/rail';

import { buildPositionListCommand, buildSettlementCommand } from './command';
import type { ByrealCredentials } from './credentials';
import { parseEnvelope } from './envelope';
import {
  createMemoryIdempotencyStore,
  type IdempotencyStore,
} from './idempotency';
import { buildOutcome, findPosition, parseOrderResult } from './parse';
import { runByrealCli, type ByrealCliResult } from './cli';

/**
 * The Byreal Perps CLI execution rail (P2.1).
 *
 * Settles an *already-allowed* Intent (only ALLOW/CLIP Intents ever reach a rail
 * — the orchestrator gates on the referee verdict before calling `execute`) on
 * the real Byreal/Hyperliquid testnet venue, and maps the result onto Vector's
 * `executions`/`outcomes` shape. It is the **credibility** layer (§3): its
 * verifiable PnL is shown alongside the demo but never feeds the deterministic
 * score, and on *any* miss it returns `null`/throws so the caller degrades
 * silently to the seeded fill — the arc never stalls.
 *
 * The adapter is the sole holder of the scoped venue credentials (they flow only
 * into the CLI child env) and is idempotent by `intent_hash` (no double orders).
 */

/** The CLI runner, injected so tests can drive the adapter without a subprocess. */
export type ByrealCliRunner = typeof runByrealCli;

/** Dependencies for {@link createByrealRail}. */
export interface ByrealRailDeps {
  readonly credentials: ByrealCredentials;
  /** CLI runner; defaults to the real subprocess invoker. */
  readonly runCli?: ByrealCliRunner;
  /** Idempotency store; defaults to a process-local map. */
  readonly idempotency?: IdempotencyStore;
  /** Per-command timeout (ms). Default 10s. */
  readonly timeoutMs?: number;
  /** Explicit CLI entry path; else package-resolved. */
  readonly cliPath?: string;
  /**
   * Read the resulting position after a fill to enrich the outcome with marked
   * PnL / capital-at-risk. Default true; a read failure never fails the settle.
   */
  readonly readPosition?: boolean;
  /**
   * Permit `mainnet` credentials. Default false: constructing a rail against
   * mainnet without this is a loud error, so the rail can never place real-money
   * orders by misconfiguration (P2.1 is testnet-scoped).
   */
  readonly allowMainnet?: boolean;
}

/** A rail-side settlement failure (non-success envelope, parse miss, …). */
export class ByrealRailError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'ByrealRailError';
    this.code = code;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Build a Byreal execution {@link Rail}.
 *
 * @throws Error when given `mainnet` credentials without `allowMainnet` — a
 *   deliberate safety boundary, surfaced at construction rather than mid-arc.
 */
export function createByrealRail(deps: ByrealRailDeps): Rail {
  if (deps.credentials.network === 'mainnet' && deps.allowMainnet !== true) {
    throw new Error(
      'byreal rail: refusing mainnet credentials; set allowMainnet to trade real funds',
    );
  }

  const runCli = deps.runCli ?? runByrealCli;
  const store = deps.idempotency ?? createMemoryIdempotencyStore();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const readPosition = deps.readPosition ?? true;
  const runOptions = {
    credentials: deps.credentials,
    timeoutMs,
    ...(deps.cliPath === undefined ? {} : { cliPath: deps.cliPath }),
  };

  /** Best-effort position read; never throws (a miss leaves the outcome zeroed). */
  async function readOpenPosition(coin: string): Promise<ReturnType<typeof findPosition>> {
    try {
      const res: ByrealCliResult = await runCli(buildPositionListCommand(), runOptions);
      const envelope = parseEnvelope(res.stdout);
      if (!envelope.success) return undefined;
      return findPosition(envelope.data, coin);
    } catch {
      return undefined;
    }
  }

  return {
    async execute(request: RailRequest): Promise<RailFill | null> {
      const { intent, intentHash } = request;

      // Not expressible on the Byreal rail (transfer, unmapped market, limit,
      // no-op modify) ⇒ defer to the deterministic seed fallback.
      const command = buildSettlementCommand(intent);
      if (command === null) return null;

      // Idempotency: a repeat of the same canonical Intent reuses the first fill,
      // so a retry/re-run never places a second order.
      if (intentHash !== undefined) {
        const cached = await store.get(intentHash);
        if (cached !== undefined) return cached;
      }

      const res = await runCli(command.argv, runOptions);
      const envelope = parseEnvelope(res.stdout);
      if (!envelope.success) {
        throw new ByrealRailError(
          envelope.error?.message ?? 'byreal order failed',
          envelope.error?.code,
        );
      }

      const order = parseOrderResult(envelope.data);
      const position = readPosition ? await readOpenPosition(command.market.coin) : undefined;

      const outcome = buildOutcome({
        order,
        position,
        isClose: intent.action === 'close',
        ...(intent.action === 'open' ? { openSide: intent.side } : {}),
      });

      const fill: RailFill = {
        status: order.status,
        outcome,
        rail_order_id: order.orderId,
        response: envelope,
      };

      if (intentHash !== undefined) await store.set(intentHash, fill);
      return fill;
    },
  };
}
