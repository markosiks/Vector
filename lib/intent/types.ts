import type { Address } from 'viem';

import type { IntentAction } from '@/lib/db/schema';

/**
 * The Intent contract — Vector's single trust boundary (architecture.txt §8).
 *
 * An agent's `decide(context)` may only *propose* an {@link UnsignedIntentInput};
 * it holds no credentials and cannot move funds. The harness signs the canonical
 * payload (`lib/intent/sign.ts`) and the referee validates the resulting
 * {@link Intent} (`lib/intent/validate.ts`). Because only this typed shape — not
 * the agent's prompt or free text — ever crosses the boundary, prompt injection
 * cannot bypass the gate (boundary B1, §5.3).
 *
 * The Intent shapes themselves are defined by the zod schemas in `./schema` and
 * re-exported here; this module owns the surrounding agent-interface types.
 */

export type { Address, Hex } from 'viem';

export type { Intent, IntentInput, UnsignedIntent, UnsignedIntentInput } from './schema';

/** A numeric Intent field on input: a finite JS number or a decimal string. */
export type IntentNumericInput = number | string;

/** Narrow guard: does this action carry a `side`/`leverage`? */
export const isTradeAction = (action: IntentAction): action is 'open' | 'modify' =>
  action === 'open' || action === 'modify';

// --- Agent interface contract (§8.1) -----------------------------------------

/** A point-in-time market quote provided in {@link Context}. */
export interface MarketQuote {
  readonly price: string;
  readonly ts: string;
}

/**
 * Read-only external signals slot. Populated by P1.4, consumed by P2.2 (Nansen)
 * and P3.1 (Elfa). Signals are visible only inside `decide`; they never reach
 * execution (trust boundary: read-only into `context`).
 */
export interface Signals {
  readonly nansen?: unknown;
  readonly elfa?: unknown;
}

/**
 * The read-only input to `decide` (§8.1), provided by Vector. The agent gets no
 * execution credentials and no ability to move funds — it can only return an
 * unsigned Intent.
 */
export interface Context {
  readonly agent_id: string;
  readonly round_id: string;
  /** Current market snapshot, keyed by market symbol (seeded or live). */
  readonly markets: Readonly<Record<string, MarketQuote>>;
  /** Capital currently allocated to the agent (canonical decimal string). */
  readonly allocation: string;
  /** Remaining spend budget this round (canonical decimal string). */
  readonly remaining_budget: string;
  /** Current AgentScore in [0, 100]. */
  readonly score: number;
  /** Optional external signals (P1.4 fills this slot). */
  readonly signals?: Signals;
}

/**
 * The single agent function signature (§8.1). Fixed here as a type only; seed
 * strategies are implemented in P1.4. An agent is "Vector-compatible" iff it can
 * emit one valid signed Intent for a whitelisted market (§8.3).
 */
export type Decide = (
  context: Context,
) => import('./schema').UnsignedIntentInput | Promise<import('./schema').UnsignedIntentInput>;

/** Address of an Intent's authorized signer (checked during validation). */
export type IntentSigner = Address;
