import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';

/**
 * Environment schema + pure parser for Vector.
 *
 * This module is deliberately side-effect free and contains **no** `server-only`
 * guard, so it can be unit/fuzz tested directly. The eager, server-only entry
 * point that reads `process.env` lives in `env.ts`.
 *
 * Security invariants:
 * - Required variables are validated; a missing or malformed one is a
 *   deterministic rejection, never a silent default.
 * - Error messages reference variable **names and reasons only** — never the
 *   offending value — so secrets can never leak into logs.
 */

/** Upper bound on any single connection/URL value; rejects pathological input. */
const MAX_URL_LEN = 4_096;

const postgresUrl = z
  .string()
  .trim()
  .min(1)
  .max(MAX_URL_LEN)
  .refine(
    (value) => {
      try {
        const { protocol } = new URL(value);
        return protocol === 'postgres:' || protocol === 'postgresql:';
      } catch {
        return false;
      }
    },
    { message: 'must be a postgres:// or postgresql:// connection string' },
  );

const rpcUrl = z
  .string()
  .trim()
  .min(1)
  .max(MAX_URL_LEN)
  .refine(
    (value) => {
      try {
        const { protocol } = new URL(value);
        return (
          protocol === 'http:' || protocol === 'https:' || protocol === 'ws:' || protocol === 'wss:'
        );
      } catch {
        return false;
      }
    },
    { message: 'must be an http(s) or ws(s) URL' },
  );

/**
 * A servable http(s) base URL. Unlike {@link rpcUrl} it rejects ws(s): the only
 * consumer ({@link buildFeedbackUri}) emits an on-chain `feedbackURI` that must
 * be fetchable over HTTP, so a websocket scheme is never valid here.
 */
const httpUrl = z
  .string()
  .trim()
  .min(1)
  .max(MAX_URL_LEN)
  .refine(
    (value) => {
      try {
        const { protocol } = new URL(value);
        return protocol === 'http:' || protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'must be an http(s) URL' },
  );

/** A non-empty secret string with a sane length bound. */
const secret = z.string().trim().min(1).max(MAX_URL_LEN);

/**
 * A 0x-prefixed 32-byte hex EVM private key, as expected by viem.
 * Validates format at startup so a misconfigured key fails fast with a clear
 * config error rather than an opaque on-chain write failure.
 */
const evmPrivateKey = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte hex EVM private key');

/**
 * The environment schema. Only `DATABASE_URL` is required at P0.1 (the health
 * check needs it). Chain/signal/operator values are validated **if present** so
 * a malformed value fails fast, but they remain optional until their stage.
 */
export const envSchema = z.object({
  /** Neon Postgres connection string. Required. */
  DATABASE_URL: postgresUrl,
  /** Mantle testnet RPC URL. Optional until on-chain stages; validated if set. */
  MANTLE_TESTNET_RPC_URL: rpcUrl.optional(),
  /** Nansen API key (P2.2). Secret. Optional until its stage. */
  NANSEN_API_KEY: secret.optional(),
  /** Elfa API key (P3.1). Secret. Optional until its stage. */
  ELFA_API_KEY: secret.optional(),
  /** Owner key that registers agents in the Identity Registry. Secret. Optional until its stage. */
  OPERATOR_PRIVATE_KEY: evmPrivateKey.optional(),
  /**
   * Attestor key that authors feedback writes. Secret. Optional until its stage.
   * MUST resolve to a different address than OPERATOR_PRIVATE_KEY: the registry
   * rejects feedback from an agent's owner/operator (self-feedback). The
   * distinctness invariant is enforced both here (superRefine, C-04) and at the
   * client (`assertDistinctSigners`) as defence-in-depth.
   */
  ATTESTOR_PRIVATE_KEY: evmPrivateKey.optional(),
  /**
   * Absolute public base URL this deployment serves from, e.g.
   * `https://vector.app`. Used to build the on-chain `feedbackURI` for the
   * off-chain attestation detail (P1.8). Non-secret. Optional until the write
   * path needs it; validated as an http(s) URL if set.
   */
  PUBLIC_BASE_URL: httpUrl.optional(),
  /**
   * Byreal Perps CLI scoped session/agent key (P2.1). Secret. Optional: when
   * absent the Byreal credibility rail is **disabled** and the demo runs purely
   * on the deterministic seed rail (the default, byte-identical arc). When set,
   * the {@link import('@/lib/rail/byreal').loadByrealCredentials} loader is the
   * sole holder of this value — it is injected into the CLI subprocess via the
   * `BYREAL_PERPS_AGENT_KEY` child env and never logged, returned to agents, or
   * sent to the client.
   */
  BYREAL_PERPS_AGENT_KEY: secret.optional(),
  /**
   * Byreal Perps wallet address the scoped key authorizes (P2.1). Required
   * together with `BYREAL_PERPS_AGENT_KEY` for the rail to enable; validated as
   * a 0x-prefixed 20-byte EVM address if present. Non-secret (a public address),
   * but only meaningful paired with the key.
   */
  BYREAL_PERPS_WALLET_ADDRESS: z
    .string()
    .trim()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte EVM address')
    .optional(),
  /**
   * Network the Byreal rail is allowed to trade on (P2.1). Defaults to
   * `testnet`. This is a *safety boundary*: the rail refuses to enable on
   * `mainnet` unless this is explicitly set, so a misconfigured deployment can
   * never place real-money orders by accident (the spec scopes P2.1 to a funded
   * **testnet** account).
   */
  BYREAL_PERPS_NETWORK: z.enum(['testnet', 'mainnet']).optional(),
  /**
   * Absolute path to the Byreal CLI executable (its bundled `dist/index.cjs`),
   * resolved against the installed `@byreal-io/byreal-perps-cli`. Optional: the
   * adapter falls back to the package's `bin` resolution. Validated as a
   * non-empty bounded string if present.
   */
  BYREAL_PERPS_CLI_PATH: z.string().trim().min(1).max(MAX_URL_LEN).optional(),
  /**
   * Shared operator-console bearer secret (P2.4). Secret. Optional and
   * **fail-closed**: when unset the operator console and every mutating
   * `/api/operator/*` route are disabled (403) — a deployment never exposes the
   * kill-switch/attack controls without an explicitly configured token. A
   * 24-char floor keeps a weak/guessable token from being accepted; the value is
   * only ever compared in constant time and never logged or sent to the client.
   */
  OPERATOR_CONSOLE_TOKEN: z.string().trim().min(24).max(MAX_URL_LEN).optional(),
  /** Deployed commit SHA surfaced by `/api/health`. Non-secret, optional. */
  GIT_COMMIT: z.string().trim().max(MAX_URL_LEN).optional(),
}).superRefine((data, ctx) => {
  // C-04: OPERATOR and ATTESTOR must resolve to different EVM addresses.
  // Checked here (after hex format is already validated) so a same-key pair
  // fails at startup with a clear config error rather than an opaque on-chain
  // rejection at first transaction time.
  if (data.OPERATOR_PRIVATE_KEY !== undefined && data.ATTESTOR_PRIVATE_KEY !== undefined) {
    const operatorAddr = privateKeyToAccount(
      data.OPERATOR_PRIVATE_KEY as `0x${string}`,
    ).address.toLowerCase();
    const attestorAddr = privateKeyToAccount(
      data.ATTESTOR_PRIVATE_KEY as `0x${string}`,
    ).address.toLowerCase();
    if (operatorAddr === attestorAddr) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ATTESTOR_PRIVATE_KEY'],
        message:
          'ATTESTOR_PRIVATE_KEY must resolve to a different address than OPERATOR_PRIVATE_KEY (self-feedback is rejected by the registry)',
      });
    }
  }
});

/** The validated environment shape. */
export type Env = z.infer<typeof envSchema>;

/** Thrown when env validation fails. Message lists names + reasons, never values. */
export class EnvValidationError extends Error {
  public readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/**
 * Validate an environment source. Returns the typed env on success; throws
 * {@link EnvValidationError} with a redacted, human-readable summary on failure.
 *
 * @param source A map of env variables, e.g. `process.env`.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (result.success) {
    return result.data;
  }

  const issues = result.error.issues.map((issue) => {
    const name = issue.path.join('.') || '(root)';
    return `${name}: ${issue.message}`;
  });
  throw new EnvValidationError(issues);
}
