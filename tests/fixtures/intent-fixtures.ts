import { signerAddress } from '@/lib/intent/sign';
import type { UnsignedIntentInput } from '@/lib/intent/types';

/**
 * Deterministic fixtures for the Intent contract tests (architecture.txt §8).
 *
 * Two fixed accounts (an authorized issuer and an impostor) plus canonical
 * sample inputs. ECDSA signing is deterministic (RFC 6979), so a signed Intent
 * built from these is byte-stable across runs — the basis for the golden
 * vectors and the emitter/verifier compatibility checks.
 */

/** The authorized issuer key for tests (well-known Anvil account #0). */
export const TEST_PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
export const TEST_SIGNER = signerAddress(TEST_PK);

/** An impostor key (well-known Anvil account #1) for negative signature tests. */
export const OTHER_PK =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
export const OTHER_SIGNER = signerAddress(OTHER_PK);

/** A ttl comfortably in the future for happy-path validation. */
export const farFutureTtl = (now = Date.now()): string =>
  new Date(now + 60 * 60 * 1000).toISOString();

/** A canonical valid `open` Intent input. */
export const validOpenInput = (overrides: Partial<UnsignedIntentInput> = {}): UnsignedIntentInput =>
  ({
    action: 'open',
    agent_id: 'agent-001',
    market: 'BTC-PERP',
    side: 'long',
    size: 1000,
    leverage: 3,
    max_slippage: 0.01,
    nonce: '1',
    ttl: farFutureTtl(),
    ...overrides,
  }) as UnsignedIntentInput;

/** A canonical valid `close` Intent input. */
export const validCloseInput = (
  overrides: Partial<UnsignedIntentInput> = {},
): UnsignedIntentInput =>
  ({
    action: 'close',
    agent_id: 'agent-001',
    market: 'ETH-PERP',
    size: 500,
    max_slippage: 0.02,
    nonce: '2',
    ttl: farFutureTtl(),
    ...overrides,
  }) as UnsignedIntentInput;

/** A `transfer` Intent input (structurally valid; the referee rejects drains). */
export const transferInput = (overrides: Partial<UnsignedIntentInput> = {}): UnsignedIntentInput =>
  ({
    action: 'transfer',
    agent_id: 'agent-001',
    size: 250,
    target_address: '0x000000000000000000000000000000000000dEaD',
    nonce: '3',
    ttl: farFutureTtl(),
    ...overrides,
  }) as UnsignedIntentInput;

/** A resolver that authorizes only {@link TEST_SIGNER} for every agent. */
export const resolveTestSigner = () => TEST_SIGNER;
