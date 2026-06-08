import { SEED_AGENTS } from '../agents/seed';

/**
 * Operator-assigned on-chain agent identifiers (P1.7, task 5 provenance note).
 *
 * An ERC-8004 Reputation Registry keys all feedback by `agentId`, a `uint256`
 * that is the **ERC-721 tokenId in the Identity Registry**. The canonical
 * Identity Registry is live on Mantle Sepolia, but minting/registering agents
 * there is ROADMAP and out of P1.7 scope. To remove the ambiguity of "where
 * does the agentId for a P1.8 feedback write come from" without pulling the
 * Identity Registry forward, the operator deterministically assigns each seed
 * agent a stable id from the frozen roster order and stamps it into
 * `agents.agent_id_onchain`.
 *
 * IMPORTANT (documented, not silently assumed): these are operator-namespaced
 * provenance ids. A `giveFeedback` write against the *canonical* registry
 * additionally requires that `agentId` be a registered tokenId in the canonical
 * Identity Registry. Until that registration lands (or Vector deploys its own
 * registry pair), P1.8 must either register these ids or run against a
 * Vector-owned instance. See docs/erc8004-registry.md §"agentId provenance".
 */

/** Deterministic on-chain id for a seed agent: its 1-based roster position. */
function onchainIdForIndex(index: number): string {
  return String(index + 1);
}

/** One operator assignment: the seed agent's stable id → its on-chain agentId. */
export interface OnchainIdAssignment {
  /** Stable Intent `agent_id` / `display_name` of the seed agent. */
  readonly agentId: string;
  /** Operator-assigned `agent_id_onchain` (decimal `uint256` string). */
  readonly agentIdOnchain: string;
}

/**
 * The full, deterministic operator assignment for the seed roster, in roster
 * order. This is the single source consumed when seeding `agents.agent_id_onchain`.
 */
export function seedOnchainIdAssignments(): readonly OnchainIdAssignment[] {
  return SEED_AGENTS.map((agent, index) => ({
    agentId: agent.id,
    agentIdOnchain: onchainIdForIndex(index),
  }));
}

/**
 * Resolve the operator-assigned on-chain agentId for a seed agent, or `null`
 * for an unknown agent (so callers can reject rather than invent an id).
 */
export function onchainAgentId(agentId: string): string | null {
  const index = SEED_AGENTS.findIndex((a) => a.id === agentId);
  return index === -1 ? null : onchainIdForIndex(index);
}
