import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { INTENT_SIDE } from '@/lib/db/schema';

import { normalizeDecimal, normalizeNonce, normalizeTimestamp } from './canonical';

/**
 * Structural (schema-level) validation of an Intent — step (a) of the ordered
 * validator (architecture.txt §6.3 / §8.2).
 *
 * Responsibility boundary: this layer checks *shape and type* only — required
 * fields per action, enum membership, finite/decimal numbers, parseable
 * timestamps, hex signatures. It deliberately does **not** check value ranges
 * (e.g. `size > 0`) or domain policy (whitelist, caps, fresh-wallet): numeric
 * bounds are a later validator step and policy belongs to the referee (P1.1).
 * Keeping range/policy out of the schema is what makes the validator's
 * "first failing check decides" ordering observable.
 *
 * Numeric and timestamp fields accept a number or string and are normalized to
 * canonical strings on parse, so the parsed Intent is already canonical for
 * hashing and signing.
 */

/** A finite, decimal numeric field, normalized to a canonical decimal string. */
const numericField = z.union([z.number(), z.string()]).transform((v, ctx) => {
  try {
    return normalizeDecimal(v);
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: err instanceof Error ? err.message : 'invalid numeric',
    });
    return z.NEVER;
  }
});

/** A string/integer nonce, normalized to a canonical string. */
const nonceField = z.union([z.string(), z.number()]).transform((v, ctx) => {
  try {
    return normalizeNonce(v);
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: err instanceof Error ? err.message : 'invalid nonce',
    });
    return z.NEVER;
  }
});

/** An ISO-8601 string or epoch-ms timestamp, normalized to ISO-8601 UTC. */
const ttlField = z.union([z.string(), z.number()]).transform((v, ctx) => {
  try {
    return normalizeTimestamp(v);
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: err instanceof Error ? err.message : 'invalid timestamp',
    });
    return z.NEVER;
  }
});

/** EIP-191 ECDSA signature: `0x` + 65 bytes. (ERC-1271 variable length is ROADMAP.) */
const signatureField = z
  .string()
  .regex(/^0x[0-9a-fA-F]{130}$/, 'signature must be 0x-prefixed 65-byte hex')
  .transform((s) => s as `0x${string}`);

/**
 * Fields common to every action. `target_address` is structurally optional on
 * all actions; the "only on transfer" rule is enforced by the validator's
 * target-address step, not here (so that check stays observable in ordering).
 */
const baseShape = {
  agent_id: z.string().min(1),
  nonce: nonceField,
  ttl: ttlField,
  target_address: z.string().min(1).optional(),
} as const;

const tradeShape = {
  market: z.string().min(1),
  side: z.enum(INTENT_SIDE),
  size: numericField,
  leverage: numericField,
  max_slippage: numericField,
  tp: numericField.optional(),
  sl: numericField.optional(),
} as const;

const closeShape = {
  market: z.string().min(1),
  size: numericField,
  max_slippage: numericField,
  tp: numericField.optional(),
  sl: numericField.optional(),
} as const;

const transferShape = {
  size: numericField,
} as const;

const openVariant = { action: z.literal('open'), ...baseShape, ...tradeShape } as const;
const modifyVariant = { action: z.literal('modify'), ...baseShape, ...tradeShape } as const;
const closeVariant = { action: z.literal('close'), ...baseShape, ...closeShape } as const;
const transferVariant = { action: z.literal('transfer'), ...baseShape, ...transferShape } as const;

/** Unsigned Intent (agent-authored, pre-signature). Strict: unknown keys rejected. */
export const unsignedIntentSchema = z.discriminatedUnion('action', [
  z.object(openVariant).strict(),
  z.object(modifyVariant).strict(),
  z.object(closeVariant).strict(),
  z.object(transferVariant).strict(),
]);

/** Signed Intent (carries the EIP-191 signature). Strict: unknown keys rejected. */
export const signedIntentSchema = z.discriminatedUnion('action', [
  z.object({ ...openVariant, signature: signatureField }).strict(),
  z.object({ ...modifyVariant, signature: signatureField }).strict(),
  z.object({ ...closeVariant, signature: signatureField }).strict(),
  z.object({ ...transferVariant, signature: signatureField }).strict(),
]);

/**
 * JSON Schema for the signed Intent — the one-page conformance artifact for
 * external teams (§8.3). Describes the accepted wire shape (number-or-string
 * numerics, action-discriminated required fields).
 */
export const intentJsonSchema = zodToJsonSchema(signedIntentSchema, {
  name: 'Intent',
  $refStrategy: 'none',
});

/** JSON Schema for the unsigned Intent (what `decide` returns). */
export const unsignedIntentJsonSchema = zodToJsonSchema(unsignedIntentSchema, {
  name: 'UnsignedIntent',
  $refStrategy: 'none',
});

// --- Inferred types (the schema is the single source of truth) ---------------

/**
 * Unsigned Intent as accepted on the wire / returned by `decide` (§8.2 minus
 * signature). Numerics accept `number | string`, nonce `string | number`, ttl an
 * ISO string or epoch-ms; all are normalized on parse.
 */
export type UnsignedIntentInput = z.input<typeof unsignedIntentSchema>;

/** A parsed, normalized unsigned Intent (canonical numeric/timestamp strings). */
export type UnsignedIntent = z.infer<typeof unsignedIntentSchema>;

/** A signed Intent on the wire. */
export type IntentInput = z.input<typeof signedIntentSchema>;

/** A parsed, normalized, signed Intent (bound to its issuer by `signature`). */
export type Intent = z.infer<typeof signedIntentSchema>;
