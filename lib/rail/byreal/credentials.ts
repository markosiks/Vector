import 'server-only';

import { ENV } from '@/lib/config/env';

/**
 * Sole-custody loader for the Byreal rail's scoped credentials (P2.1, B2/B4).
 *
 * The `server-only` import makes it a build error to pull this module into a
 * client bundle. This is the *only* place the scoped session key is read; the
 * value flows from here into the CLI subprocess env ({@link import('./cli')})
 * and nowhere else — never into a response DTO, an agent's `context`, a log
 * line, or an `executions.response_json` payload. Agents propose Intents; they
 * never see or hold the key that settles them (boundary B2), and the cross-chain
 * settlement seam (B4) is the rail's concern alone.
 */

/** The rail's scoped venue credentials + the network it is allowed to trade on. */
export interface ByrealCredentials {
  /** Scoped session/agent key, injected as the CLI's `BYREAL_PERPS_AGENT_KEY`. */
  readonly agentKey: string;
  /** Wallet address the key authorizes (`BYREAL_PERPS_WALLET_ADDRESS`). */
  readonly walletAddress: string;
  /** Network the rail may trade on. `mainnet` requires explicit opt-in. */
  readonly network: 'testnet' | 'mainnet';
}

/**
 * Load the Byreal credentials from the validated env, or return `null` when the
 * rail is **disabled** (no scoped key configured). A `null` return is the normal,
 * safe default: the demo then runs purely on the deterministic seed rail.
 *
 * Enabling requires *both* the scoped key and the wallet address. The network
 * defaults to `testnet`; selecting `mainnet` is a deliberate, explicit act
 * (`BYREAL_PERPS_NETWORK=mainnet`) so a deployment can never place real-money
 * orders by misconfiguration — P2.1 is scoped to a funded testnet account.
 *
 * @throws Error when the key is set without a wallet address (a half-configured
 *   rail is a deployment error, not a silent disable, so it surfaces loudly).
 */
export function loadByrealCredentials(): ByrealCredentials | null {
  const agentKey = ENV.BYREAL_PERPS_AGENT_KEY;
  if (agentKey === undefined) return null;

  const walletAddress = ENV.BYREAL_PERPS_WALLET_ADDRESS;
  if (walletAddress === undefined) {
    throw new Error(
      'byreal credentials: BYREAL_PERPS_AGENT_KEY is set but BYREAL_PERPS_WALLET_ADDRESS is missing; ' +
        'both are required to enable the rail',
    );
  }

  const network = ENV.BYREAL_PERPS_NETWORK ?? 'testnet';
  return { agentKey, walletAddress, network };
}
