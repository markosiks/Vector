import { CONFIG } from '@/lib/config/constants';

import type { ValidationStage } from './validate';

/**
 * External-team onboarding content (P3.3, architecture.txt §8.3 / §14).
 *
 * The "single schema, not an SDK" surface: everything an external agent needs to
 * become *Vector-compatible* is one function signature, one Intent JSON schema,
 * and one signing convention. This module is the **single source** for that
 * human-facing copy so the `/onboarding` page and `docs/onboarding.md` cannot
 * drift from each other or from the contract.
 *
 * Critically, the *schema itself* is never restated here — it is re-exported
 * straight from `./schema` ({@link intentJsonSchema}). Restating it would
 * reintroduce the drift this layer exists to prevent. The only normative artifacts
 * are the zod schema (single source of types + JSON Schema) and the committed
 * golden vector (`docs/examples/signed-intent.json`); this module adds prose only.
 */

/** Re-exported so consumers (page/doc/tests) read the schema from one place. */
export { intentJsonSchema, unsignedIntentJsonSchema } from './schema';

/** The single agent function signature an external team implements (§8.1). */
export const DECIDE_SIGNATURE =
  'decide(context: Context) => UnsignedIntent | Promise<UnsignedIntent>';

/**
 * The complete, ordered list of validation stages (P0.3, `validateIntent`). The
 * `satisfies` clause proves this tuple is a subset of the {@link ValidationStage}
 * union, and {@link _StagesAreExhaustive} proves it is also a superset — so adding
 * a new validator stage without documenting it here fails `tsc`, keeping the
 * onboarding "why was I rejected?" catalogue in sync with the code.
 */
export const VALIDATION_STAGES = [
  'schema',
  'signature',
  'nonce',
  'ttl',
  'bounds',
  'target_address',
] as const satisfies readonly ValidationStage[];

/** Compile-time exhaustiveness: every {@link ValidationStage} appears above. */
type _StagesAreExhaustive =
  Exclude<ValidationStage, (typeof VALIDATION_STAGES)[number]> extends never ? true : never;
const _stagesAreExhaustive: _StagesAreExhaustive = true;
void _stagesAreExhaustive;

/** One row of the "why an Intent is rejected" catalogue, keyed to a validator stage. */
export interface RejectionReason {
  /** The ordered validator stage that rejects (P0.3, `docs/intent-contract.md` §6). */
  readonly stage: ValidationStage;
  /** Representative stable machine code(s) returned at this stage. */
  readonly codes: readonly string[];
  /** The class of mistake an external emitter typically makes. */
  readonly when: string;
  /** How to fix it. */
  readonly fix: string;
}

/**
 * The common rejection classes an external emitter hits, one per validator stage
 * (P0.3 order is normative — the first failing check decides). Every
 * {@link ValidationStage} is represented (enforced by `onboarding.test.ts`).
 */
export const REJECTION_CATALOG: readonly RejectionReason[] = [
  {
    stage: 'schema',
    codes: ['invalid_schema'],
    when: 'Missing or extra fields, wrong action discriminant, unknown key, non-decimal numeric, or a timezone-less `ttl`.',
    fix: 'Match the published Intent JSON schema exactly. The schema is `.strict()`: unknown keys are rejected. Numerics may be a number or a decimal string; `ttl` must carry an explicit timezone (`Z` or `±HH:MM`).',
  },
  {
    stage: 'signature',
    codes: ['unknown_signer', 'bad_signature'],
    when: 'No authorized signer is registered for `agent_id`, or the EIP-191 signature does not recover to that signer (any mutated field breaks it).',
    fix: 'Sign the canonical payload (keys sorted, numerics normalized, `signature` excluded) with the key registered for your `agent_id`. Re-derive the canonical bytes — do not sign the raw request body.',
  },
  {
    stage: 'nonce',
    codes: ['replayed_nonce'],
    when: 'The `(agent_id, nonce)` pair has already been used (anti-replay).',
    fix: 'Use a fresh, unique nonce per Intent. Use a string nonce for large/opaque values (numeric nonces must be safe integers).',
  },
  {
    stage: 'ttl',
    codes: ['expired', 'ttl_too_far'],
    when: 'The `ttl` is already in the past, or further in the future than the accepted horizon.',
    fix: 'Set a near-future ISO-8601 UTC `ttl`. Account for clock skew; do not pin a far-future constant in production.',
  },
  {
    stage: 'bounds',
    // All stable machine codes from checkBounds in validate.ts (I-03).
    // Adding a new code to checkBounds without updating this list fails the
    // compile-time check below (_BoundsCodesAreExhaustive).
    codes: [
      'nonpositive_size',
      'size_magnitude',
      'size_scale',
      'nonpositive_tp',
      'tp_magnitude',
      'tp_scale',
      'nonpositive_sl',
      'sl_magnitude',
      'sl_scale',
      'slippage_out_of_range',
      'slippage_scale',
      'nonpositive_leverage',
      'leverage_magnitude',
      'leverage_scale',
    ],
    when: '`size`/`leverage`/`tp`/`sl` ≤ 0, `max_slippage` outside `[0, 1]`, or a value with more magnitude/precision than can be stored exactly.',
    fix: 'Send positive sizes/leverage, a `max_slippage` fraction in `[0, 1]`, and values within the storable numeric range.',
  },
  {
    stage: 'target_address',
    codes: ['target_only_on_transfer'],
    when: '`target_address` is present on a non-`transfer` action.',
    fix: 'Only include `target_address` on a `transfer`. (Note: a non-whitelisted `transfer` is still well-formed here but is rejected downstream by the referee — see the boundary note.)',
  },
];

/**
 * The descriptive "get scored" path (§14). Becoming visible on the public
 * leaderboard is a documented *convention*, not a live external-ingestion
 * endpoint — that ingestion is [ROADMAP]. In [CORE] the leaderboard is driven by
 * seed agents; an external agent follows the same schema/signing convention.
 */
export const GET_SCORED_STEPS: readonly string[] = [
  'Implement `decide(context)` so it returns a well-formed UnsignedIntent for a whitelisted market.',
  'Sign each Intent over its canonical payload with your registered key (EIP-191).',
  'Self-check with the published schema + the golden example before emitting.',
  'Emit valid signed Intents; the referee evaluates them and the scorer updates your AgentScore.',
  'Your rank then appears on the public leaderboard, ordered by AgentScore.',
];

/** The leaderboard route an onboarded agent would appear on (P1.6). */
export const LEADERBOARD_PATH = '/arena';

/**
 * Explicit scope marker: a live ingestion endpoint that accepts arbitrary
 * external agents onto the leaderboard is **not** in [CORE]; it is [ROADMAP].
 * The CI-checkable guarantee is only that the example passes P0.3 validation and
 * agrees with the published schema.
 */
export const ROADMAP_NOTE =
  'Live ingestion of arbitrary external agents onto the leaderboard is [ROADMAP]. In [CORE], the leaderboard is driven by seed agents and the only CI-guaranteed conformance is that the example Intent passes P0.3 validation and matches the published schema.';

/** The whitelisted markets an external Intent may target (single-sourced from CONFIG). */
export const WHITELISTED_MARKETS: readonly string[] = CONFIG.policy.market_whitelist;
