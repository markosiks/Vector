import type { Address, Hex } from 'viem';

import { intentHash } from './canonical';
import { signedIntentSchema } from './schema';
import type { Intent } from './types';
import { verifyIntentSignature } from './verify';

/**
 * The Intent validator — Vector's gate (architecture.txt §6.3, §8).
 *
 * A pure, side-effect-free function over its inputs and injected dependencies.
 * Checks run in a fixed order and the **first failing check decides** the result
 * and reason; later checks never run. Order (§4.4 / §6.3):
 *
 *   (a) schema validity      — structural shape & types
 *   (b) signature validity   — recovered signer == agent's authorized signer
 *   (c) nonce freshness      — anti-replay
 *   (d) ttl not expired      — with optional clock-skew tolerance
 *   (e) numeric bounds       — domain ranges (sign/unit-interval)
 *   (f) target-address policy — present only for `transfer`
 *
 * Everything here is *structural*; trading policy (whitelist, size/leverage
 * caps, fresh-wallet/drain block, budget) is the referee's job (P1.1). This
 * separation is why prompt injection cannot pass: only a typed, signed Intent
 * reaches the gate, and the gate is deterministic.
 */

/** The ordered stage at which validation failed. */
export type ValidationStage =
  | 'schema'
  | 'signature'
  | 'nonce'
  | 'ttl'
  | 'bounds'
  | 'target_address';

export interface ValidationSuccess {
  readonly ok: true;
  /** The parsed, normalized Intent. */
  readonly intent: Intent;
  /** KECCAK-256 of the canonical payload (for the `intents` row). */
  readonly intent_hash: Hex;
}

export interface ValidationFailure {
  readonly ok: false;
  readonly stage: ValidationStage;
  /** Stable machine code, e.g. `replayed_nonce`. */
  readonly code: string;
  readonly message: string;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

export interface ValidateOptions {
  /**
   * Resolve the agent's authorized signer address. Returning `null`/`undefined`
   * means the agent has no known signer and the Intent is rejected at the
   * signature stage.
   */
  resolveSigner: (
    agentId: string,
  ) => Address | null | undefined | Promise<Address | null | undefined>;
  /**
   * Has this `(agentId, nonce)` already been used? Pure read; the durable
   * anti-replay guarantee (atomic reserve / unique index) is the caller's, e.g.
   * via {@link createNonceGuard} or a DB constraint.
   */
  isNonceUsed?: (agentId: string, nonce: string) => boolean | Promise<boolean>;
  /** Reference time for ttl checks (injectable for deterministic tests). */
  now?: Date;
  /** Clock-skew tolerance: an Intent is expired only past `ttl + skew`. */
  clockSkewMs?: number;
  /** Optional cap on how far in the future `ttl` may be (anti-stale-flood). */
  maxTtlHorizonMs?: number;
}

const fail = (stage: ValidationStage, code: string, message: string): ValidationFailure => ({
  ok: false,
  stage,
  code,
  message,
});

/** True iff a canonical decimal string is strictly greater than zero. */
const isPositive = (d: string): boolean => d !== '0' && !d.startsWith('-');

/**
 * True iff a canonical decimal string lies in the closed interval [0, 1].
 *
 * Compares on the canonical string directly — never via `Number()` — so the
 * full precision of the signed/hashed bytes is honoured in the gate (a float
 * conversion would round e.g. `"1.0000000000000001"` down to `1` and admit a
 * value strictly greater than 1). Canonical form has a single `"0"`, no trailing
 * fraction zeros, and a leading `-` for negatives, so [0, 1] is exactly: the
 * integer part is `0` (any fraction, all < 1) or the value is exactly `"1"`.
 */
const inUnitInterval = (d: string): boolean => {
  if (d.startsWith('-')) return false;
  const dot = d.indexOf('.');
  const intPart = dot === -1 ? d : d.slice(0, dot);
  if (intPart === '0') return true;
  return intPart === '1' && dot === -1;
};

/**
 * Per-field *storability* bounds derived from each `numeric(p, s)` column of the
 * persisted `intents` row (migration 0001). Both halves of `numeric(p, s)` are
 * guarded so a value the gate admits is one Postgres can store *exactly*:
 *
 *  - {@link STORABLE_SCALE} (= `s`): a value with more fraction digits than `s`
 *    is silently *rounded* on INSERT, diverging the stored row from the
 *    signed/hashed Intent and breaking the "numeric is exact, never through a
 *    float" invariant.
 *  - {@link STORABLE_INT_DIGITS} (= `p − s`): a value whose integer part exceeds
 *    `p − s` overflows the column and the INSERT throws Postgres `22003
 *    numeric_value_out_of_range`.
 *
 * The magnitude bound is a *storability* guard, NOT the firewall's policy clip.
 * The firewall CLIPs an in-range size down to a safe trade cap (architecture.txt
 * §6.5) — but that clip runs in the referee *after* the raw Intent is persisted
 * (orchestrator persists at the reserve, then runs the referee), so a value too
 * large to even be stored never reaches the clip: it aborts the persisting
 * INSERT with an uncaught `22003`. Rejecting it here turns that crash into a
 * clean, deterministic `*_magnitude` rejection at the gate, exactly as the scale
 * guard does for fraction digits. The two never overlap: a clip changes
 * magnitude but never adds fraction digits, and a storable-magnitude value is
 * still free to be clipped downstream. (The canonical form's generic 80-digit
 * cap in canonical.ts is an amplification-DoS guard, unrelated to storability.)
 */
const STORABLE_SCALE = {
  size: 18, // numeric(38, 18)
  tp: 18, // numeric(38, 18)
  sl: 18, // numeric(38, 18)
  leverage: 6, // numeric(12, 6)
  max_slippage: 6, // numeric(12, 6)
} as const satisfies Record<string, number>;

/** Per-field integer-digit budget (`p − s`) of each persisted `numeric(p, s)` column. */
const STORABLE_INT_DIGITS = {
  size: 20, // numeric(38, 18)
  tp: 20, // numeric(38, 18)
  sl: 20, // numeric(38, 18)
  leverage: 6, // numeric(12, 6)
  max_slippage: 6, // numeric(12, 6)
} as const satisfies Record<keyof typeof STORABLE_SCALE, number>;

/**
 * Count of fraction digits in a canonical decimal string. Canonical form carries
 * no trailing fraction zeros, so this is the exact count of significant digits
 * the column would have to store.
 */
const fractionDigits = (d: string): number => {
  const dot = d.indexOf('.');
  return dot === -1 ? 0 : d.length - dot - 1;
};

/**
 * Count of integer-part digits in a canonical decimal string. Sign-agnostic; a
 * bare `"0"` counts as zero (it stores in any column), and canonical form has no
 * leading integer zeros, so this is the exact integer width Postgres must store.
 */
const integerDigits = (d: string): number => {
  const s = d.startsWith('-') ? d.slice(1) : d;
  const dot = s.indexOf('.');
  const intPart = dot === -1 ? s : s.slice(0, dot);
  return intPart === '0' ? 0 : intPart.length;
};

/** True iff `value` has finer fractional scale than its column can store exactly. */
const exceedsScale = (field: keyof typeof STORABLE_SCALE, value: string): boolean =>
  fractionDigits(value) > STORABLE_SCALE[field];

/** True iff `value`'s integer magnitude is too large to store in its column. */
const exceedsMagnitude = (field: keyof typeof STORABLE_INT_DIGITS, value: string): boolean =>
  integerDigits(value) > STORABLE_INT_DIGITS[field];

/** Step (e): domain bounds on the normalized numeric fields. */
function checkBounds(intent: Intent): ValidationFailure | null {
  if (!isPositive(intent.size)) {
    return fail('bounds', 'nonpositive_size', 'size must be greater than zero');
  }
  if (exceedsMagnitude('size', intent.size)) {
    return fail('bounds', 'size_magnitude', 'size is too large to be stored');
  }
  if (exceedsScale('size', intent.size)) {
    return fail('bounds', 'size_scale', 'size has more fraction digits than can be stored exactly');
  }
  if ('tp' in intent && intent.tp !== undefined) {
    if (!isPositive(intent.tp)) {
      return fail('bounds', 'nonpositive_tp', 'tp must be greater than zero');
    }
    if (exceedsMagnitude('tp', intent.tp)) {
      return fail('bounds', 'tp_magnitude', 'tp is too large to be stored');
    }
    if (exceedsScale('tp', intent.tp)) {
      return fail('bounds', 'tp_scale', 'tp has more fraction digits than can be stored exactly');
    }
  }
  if ('sl' in intent && intent.sl !== undefined) {
    if (!isPositive(intent.sl)) {
      return fail('bounds', 'nonpositive_sl', 'sl must be greater than zero');
    }
    if (exceedsMagnitude('sl', intent.sl)) {
      return fail('bounds', 'sl_magnitude', 'sl is too large to be stored');
    }
    if (exceedsScale('sl', intent.sl)) {
      return fail('bounds', 'sl_scale', 'sl has more fraction digits than can be stored exactly');
    }
  }
  if ('max_slippage' in intent) {
    if (!inUnitInterval(intent.max_slippage)) {
      return fail('bounds', 'slippage_out_of_range', 'max_slippage must be within [0, 1]');
    }
    if (exceedsScale('max_slippage', intent.max_slippage)) {
      return fail(
        'bounds',
        'slippage_scale',
        'max_slippage has more fraction digits than can be stored exactly',
      );
    }
  }
  if (intent.action === 'open' || intent.action === 'modify') {
    if (!isPositive(intent.leverage)) {
      return fail('bounds', 'nonpositive_leverage', 'leverage must be greater than zero');
    }
    if (exceedsMagnitude('leverage', intent.leverage)) {
      return fail('bounds', 'leverage_magnitude', 'leverage is too large to be stored');
    }
    if (exceedsScale('leverage', intent.leverage)) {
      return fail(
        'bounds',
        'leverage_scale',
        'leverage has more fraction digits than can be stored exactly',
      );
    }
  }
  return null;
}

export async function validateIntent(
  input: unknown,
  opts: ValidateOptions,
): Promise<ValidationResult> {
  // (a) schema validity
  const parsed = signedIntentSchema.safeParse(input);
  if (!parsed.success) {
    return fail('schema', 'invalid_schema', parsed.error.issues[0]?.message ?? 'invalid intent');
  }
  const intent = parsed.data;
  const hash = intentHash(intent);

  // (b) signature validity (bound to the agent's authorized signer)
  const signer = await opts.resolveSigner(intent.agent_id);
  if (!signer) {
    return fail('signature', 'unknown_signer', `no authorized signer for agent ${intent.agent_id}`);
  }
  if (!(await verifyIntentSignature(intent, signer))) {
    return fail('signature', 'bad_signature', 'signature does not match the authorized signer');
  }

  // (c) nonce freshness (anti-replay)
  if (opts.isNonceUsed && (await opts.isNonceUsed(intent.agent_id, intent.nonce))) {
    return fail('nonce', 'replayed_nonce', 'nonce has already been used');
  }

  // (d) ttl not expired
  const now = (opts.now ?? new Date()).getTime();
  const ttlMs = Date.parse(intent.ttl);
  const skew = opts.clockSkewMs ?? 0;
  if (now > ttlMs + skew) {
    return fail('ttl', 'expired', 'intent ttl has expired');
  }
  if (opts.maxTtlHorizonMs !== undefined && ttlMs - now > opts.maxTtlHorizonMs) {
    return fail('ttl', 'ttl_too_far', 'intent ttl is too far in the future');
  }

  // (e) numeric bounds
  const bounds = checkBounds(intent);
  if (bounds) return bounds;

  // (f) target-address policy: present only for transfer
  if (intent.target_address !== undefined && intent.action !== 'transfer') {
    return fail(
      'target_address',
      'target_only_on_transfer',
      'target_address is allowed only on a transfer',
    );
  }

  return { ok: true, intent, intent_hash: hash };
}

/**
 * In-memory anti-replay guard with an atomic reserve. `reserve` returns `true`
 * only for the first caller to claim a `(agentId, nonce)` pair; concurrent
 * claims of the same nonce yield exactly one winner. Production uses the
 * `intents` unique index as the durable equivalent; this guard is for the
 * deterministic backbone and tests.
 */
export function createNonceGuard() {
  const used = new Set<string>();
  const key = (agentId: string, nonce: string) => JSON.stringify([agentId, nonce]);
  return {
    has: (agentId: string, nonce: string): boolean => used.has(key(agentId, nonce)),
    reserve: (agentId: string, nonce: string): boolean => {
      const k = key(agentId, nonce);
      if (used.has(k)) return false;
      used.add(k);
      return true;
    },
  };
}
