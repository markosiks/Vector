/**
 * The Intent contract (architecture.txt §8): Vector's single trust boundary.
 * Typed, signed Intents in — validated decisions out. See `docs/intent-contract.md`.
 */

export type {
  Address,
  Context,
  Decide,
  Hex,
  Intent,
  IntentNumericInput,
  IntentSigner,
  MarketQuote,
  Signals,
  UnsignedIntent,
  UnsignedIntentInput,
} from './types';
export { isTradeAction } from './types';

export {
  canonicalPayload,
  intentHash,
  normalizeDecimal,
  normalizeNonce,
  normalizeTimestamp,
  stableStringify,
} from './canonical';

export {
  intentJsonSchema,
  signedIntentSchema,
  unsignedIntentJsonSchema,
  unsignedIntentSchema,
} from './schema';

export { signerAddress, signIntent } from './sign';
export { recoverIntentSigner, verifyIntentSignature } from './verify';
export {
  createNonceGuard,
  validateIntent,
  type ValidateOptions,
  type ValidationFailure,
  type ValidationResult,
  type ValidationStage,
  type ValidationSuccess,
} from './validate';
