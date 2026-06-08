/**
 * On-chain integration: ERC-8004 Reputation Registry on Mantle Sepolia.
 *
 * Re-exports the public surface. Server-only modules (`client.ts`) are
 * imported directly by callers that need them; they are NOT re-exported here
 * because barrel re-exports would drag `server-only` into any consumer.
 */
export {
  TESTNET_REPUTATION_REGISTRY,
  TESTNET_IDENTITY_REGISTRY,
  TESTNET_VALIDATION_REGISTRY,
  MAINNET_REPUTATION_REGISTRY,
  MAINNET_IDENTITY_REGISTRY,
  MANTLE_SEPOLIA_REPUTATION_DEPLOY_BLOCK,
} from './addresses';

export { REPUTATION_REGISTRY_ABI } from './abi/reputation-registry';

export { mantleSepolia } from './mantle-sepolia';

export {
  smokeRead,
  getIdentityRegistry,
  readFeedback,
  getSummary,
  getNewFeedbackEvents,
  REGISTRY_ADDRESS,
  type FeedbackEntry,
  type FeedbackSummary,
} from './reputation-read';

export {
  signFeedbackAuth,
  verifyFeedbackAuth,
  feedbackAuthDigest,
  isAuthExpired,
  type FeedbackAuthorization,
} from './feedback-auth';

export {
  deriveAgentIdOnchain,
  agentRegistryString,
  formatAgentIdOnchain,
  parseAgentIdOnchain,
} from './agent-id';
