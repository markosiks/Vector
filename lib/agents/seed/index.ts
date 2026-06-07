import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';

import type { Decide } from '@/lib/intent/types';

import { createTradeStrategy, type SeedStrategyParams } from './strategies';

/**
 * The seed-agent roster for the demo spine (architecture.txt §6.5).
 *
 * These are Vector's own deterministic agents that populate the arc: stable ids,
 * fixed signing keys, and pure {@link Decide} strategies. The roster is the
 * single source of truth for "who runs in the demo", consumed by the seed arc
 * (`seed/`), the orchestrator, and the validator's signer resolver.
 *
 * ## Keys are demo-only, by design
 *
 * The private keys below are **fixed, public, throwaway** keys checked into the
 * repo on purpose. This is safe — and is the whole thesis of Vector — because an
 * agent's key only authorizes *Intents*, never funds: every Intent still passes
 * the referee, and a seed agent holds no capital it can move (a `transfer` to a
 * non-whitelisted address is always REJECTed, §6.3 rule #3). A leaked seed key
 * can therefore only forge a seed agent's *proposal* in our own demo, which the
 * firewall gates anyway. Fixed keys are what make the signed Intent bytes — and
 * thus the arc — byte-reproducible. They must never be reused for anything that
 * custodies value.
 */

/** Stable Intent `agent_id` of the leader (the agent the attack targets). */
export const SEED_LEADER_ID = 'seed-leader';
/** Stable Intent `agent_id` of the runner-up (capital reroutes here on the crash). */
export const SEED_RUNNER_UP_ID = 'seed-2';

/** A seed agent: stable identity, fixed signer, and its pure decision strategy. */
export interface SeedAgent {
  /** Stable Intent `agent_id` (also the agent's `display_name`). */
  readonly id: string;
  /** Human-facing display name (mirrors `id`). */
  readonly displayName: string;
  /** Fixed demo signing key (see file header — never custodies value). */
  readonly privateKey: Hex;
  /** Address recovered from {@link privateKey}; the authorized Intent signer. */
  readonly signer: Address;
  /** Frozen trading parameters. */
  readonly strategy: SeedStrategyParams;
  /** Pure, deterministic decision function. */
  readonly decide: Decide;
}

/** Assemble a {@link SeedAgent}, deriving its signer address from the key. */
function makeSeedAgent(id: string, privateKey: Hex, strategy: SeedStrategyParams): SeedAgent {
  return {
    id,
    displayName: id,
    privateKey,
    signer: privateKeyToAccount(privateKey).address,
    strategy,
    decide: createTradeStrategy(strategy),
  };
}

/**
 * The leader trades the largest clean position and climbs to the top of the
 * leaderboard — then attempts the drain that collapses its reputation.
 */
const SEED_LEADER = makeSeedAgent(SEED_LEADER_ID, `0x${'01'.repeat(32)}`, {
  market: 'BTC-PERP',
  side: 'long',
  size: '8000',
  leverage: '4',
  max_slippage: '0.005',
});

/**
 * The runner-up trades a smaller, steady position; it stays eligible throughout
 * and inherits the leader's capital when the drain is blocked.
 */
const SEED_RUNNER_UP = makeSeedAgent(SEED_RUNNER_UP_ID, `0x${'02'.repeat(32)}`, {
  market: 'BTC-PERP',
  side: 'long',
  size: '3000',
  leverage: '2',
  max_slippage: '0.005',
});

/** The full seed roster, in a stable order (leader first). */
export const SEED_AGENTS: readonly SeedAgent[] = [SEED_LEADER, SEED_RUNNER_UP];

/** Look up a seed agent by its stable Intent `agent_id`. */
export function getSeedAgent(agentId: string): SeedAgent | undefined {
  return SEED_AGENTS.find((a) => a.id === agentId);
}

/**
 * Resolve a seed agent's authorized signer address — a drop-in
 * `ValidateOptions.resolveSigner` for the validator/referee. Returns `null` for
 * an unknown agent so the Intent is rejected at the signature stage.
 */
export function resolveSeedSigner(agentId: string): Address | null {
  return getSeedAgent(agentId)?.signer ?? null;
}

export { createTradeStrategy, type SeedStrategyParams } from './strategies';
