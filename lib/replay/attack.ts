import { compareDecimal, normalizeDecimal } from '@/lib/intent/canonical';
import type { UnsignedIntentInput } from '@/lib/intent/types';

/**
 * The canned "drain to attacker" Intent (architecture.txt §6.5, §5.3).
 *
 * This is the demo's load-bearing adversarial input: a `transfer` of the agent's
 * capital to a fresh, non-whitelisted wallet. It is a *real* signed Intent that
 * runs through the *real* referee — only its timing is scripted. Referee rule #3
 * (`fresh_wallet_transfer_block`) REJECTs it `hard` and feeds `drain_r` into
 * scoring, which floor-crashes the agent and reroutes its capital to the honest
 * runner-up. Nothing here softens or special-cases the block; the firewall does
 * the work.
 *
 * The harness stamps the authoritative `nonce`/`ttl` (like any other Intent), so
 * the placeholders match the seed strategies' convention.
 */

/** Placeholder anti-replay fields; the harness re-stamps both before signing. */
const PLACEHOLDER_NONCE = '0';
const PLACEHOLDER_TTL = '2099-01-01T00:00:00.000Z';

/** A token positive drain size used when the agent currently holds no capital. */
const MIN_DRAIN_SIZE = '1';

/** Inputs to {@link buildDrainIntent}. */
export interface DrainIntentParams {
  /** Stable `agent_id` of the agent issuing the drain (the compromised leader). */
  readonly agentId: string;
  /** Fresh-wallet destination — must be non-whitelisted for the block to fire. */
  readonly attackerAddress: string;
  /**
   * Amount to drain (canonical decimal). Typically the agent's whole allocation;
   * clamped up to a positive token amount so the Intent clears the validator's
   * `size > 0` bound even if the agent currently holds zero capital.
   */
  readonly size: string;
}

/**
 * Build the unsigned canonical drain Intent. The size is the agent's allocation
 * (or a positive token amount when that is zero), the destination is the canned
 * attacker wallet, and the action is the only fund-moving action, `transfer`.
 */
export function buildDrainIntent(params: DrainIntentParams): UnsignedIntentInput {
  const requested = normalizeDecimal(params.size);
  const size = compareDecimal(requested, '0') > 0 ? requested : MIN_DRAIN_SIZE;

  return {
    action: 'transfer',
    agent_id: params.agentId,
    target_address: params.attackerAddress,
    size,
    nonce: PLACEHOLDER_NONCE,
    ttl: PLACEHOLDER_TTL,
  };
}
