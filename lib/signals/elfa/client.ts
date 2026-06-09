import { z } from 'zod';

import type { ElfaSentiment, ElfaSignal } from './types';

/**
 * Typed client for a *single* Elfa endpoint (P3.1): the trending-tokens
 * aggregation, which reports social sentiment / mindshare per token.
 *
 * Scope is deliberately one call (§3 / MVP): no pagination, no multi-source
 * fusion, no auto-triggers. The client is transport-only and *pure with respect
 * to its deps* — the API key, base URL, `fetch` implementation, and clock are
 * all injected — so it is fully unit-testable without a network or `server-only`
 * import. The secret-loading wrapper lives in `./load` (`server-only`).
 *
 * Failure model: every reachable failure maps to one of the typed errors below,
 * which the provider (`./provider`) catches and degrades from (fail-open to the
 * last live snapshot or the seeded mock). The client never returns partial or
 * guessed data: a response it cannot confidently normalize is an
 * {@link ElfaParseError}.
 */

/**
 * The one endpoint path this client speaks to (appended to the base URL).
 * Elfa v2 trending-tokens aggregation surfaces per-token mentions + sentiment.
 */
export const ELFA_TRENDING_PATH = '/v2/aggregations/trending-tokens';

/** Default per-request wall-clock timeout. */
const DEFAULT_TIMEOUT_MS = 5_000;

/** Hard cap on the raw response body we will buffer + parse (bounds memory). */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Hard cap on normalized rows kept from a response (bounds downstream work). */
const DEFAULT_MAX_ROWS = 50;

/**
 * Hard cap on raw rows *scanned* while normalizing — independent of how many
 * survive. Without it, a hostile/compromised upstream can send a 2 MiB array of
 * unusable rows and force a long run of synchronous `safeParse` calls that
 * starves the event loop. The fetch is detached so the tick is never blocked,
 * but the whole process would still stall; this bound keeps the scan cheap.
 */
const MAX_ROWS_SCANNED = 5_000;

/** Base class for every Elfa client failure. */
export class ElfaClientError extends Error {}

/** The request exceeded its wall-clock timeout and was aborted. */
export class ElfaTimeoutError extends ElfaClientError {
  constructor(public readonly timeoutMs: number) {
    super(`elfa request timed out after ${timeoutMs}ms`);
    this.name = 'ElfaTimeoutError';
  }
}

/** Elfa returned `429` — rate-limited / out of credits for this window. */
export class ElfaRateLimitError extends ElfaClientError {
  constructor(public readonly retryAfterMs?: number) {
    super('elfa rate-limited (HTTP 429)');
    this.name = 'ElfaRateLimitError';
  }
}

/**
 * Elfa returned `402 Payment Required` — the x402 USDC-on-Base payment path was
 * not satisfied (no key + no settled payment). Modeled distinctly from a generic
 * HTTP error so the provider/observability can tell "credit/payment" apart from
 * "server fault"; both still degrade fail-open.
 */
export class ElfaPaymentRequiredError extends ElfaClientError {
  constructor() {
    super('elfa requires payment (HTTP 402)');
    this.name = 'ElfaPaymentRequiredError';
  }
}

/** Elfa returned a non-2xx, non-429, non-402 status. */
export class ElfaHttpError extends ElfaClientError {
  constructor(public readonly status: number) {
    super(`elfa responded with HTTP ${status}`);
    this.name = 'ElfaHttpError';
  }
}

/** The response body was not valid JSON, too large, or not a shape we can map. */
export class ElfaParseError extends ElfaClientError {
  constructor(reason: string) {
    super(`elfa response could not be parsed: ${reason}`);
    this.name = 'ElfaParseError';
  }
}

/** The minimal client surface the provider depends on. */
export interface ElfaClient {
  /** Fetch and normalize one sentiment snapshot, or throw a typed error. */
  fetchSignal(): Promise<ElfaSignal>;
}

/** Dependencies for {@link createElfaClient}. All transport is injectable. */
export interface ElfaClientDeps {
  /** Elfa API key. Sent in the `x-elfa-api-key` header only; never logged. */
  readonly apiKey: string;
  /** API base URL (non-secret); supplied from `CONFIG.elfa.endpoint`. */
  readonly endpoint: string;
  /** `fetch` implementation; defaults to the global. Injected for tests. */
  readonly fetchImpl?: typeof fetch;
  /** Per-request timeout in ms (default {@link DEFAULT_TIMEOUT_MS}). */
  readonly timeoutMs?: number;
  /** Clock for `fetchedAtMs` stamping; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Max normalized rows to keep (default {@link DEFAULT_MAX_ROWS}). */
  readonly maxRows?: number;
}

/**
 * A finite numeric value as a string. Accepts a JS number or a string; rejects
 * `NaN`/`Infinity` and non-numeric text. Stored as-reported (no float reparse)
 * to honour the project's "numeric is exact" invariant.
 */
const numericString = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const s = typeof v === 'number' ? String(v) : v.trim();
  if (s.length === 0 || !Number.isFinite(Number(s))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not a finite number' });
    return z.NEVER;
  }
  return s;
});

/**
 * One sentiment row. Tolerant by design: Elfa's exact keys vary by API version,
 * so the sentiment value is read from any of several known aliases and
 * descriptive fields are optional. Unknown keys are ignored (`passthrough`),
 * never trusted.
 */
const sentimentRowSchema = z
  .object({
    symbol: z.string().min(1).optional(),
    tokenSymbol: z.string().min(1).optional(),
    token: z.string().min(1).optional(),
    tokenAddress: z.string().min(1).optional(),
    token_address: z.string().min(1).optional(),
    address: z.string().min(1).optional(),
    sentiment: numericString.optional(),
    sentimentScore: numericString.optional(),
    sentiment_score: numericString.optional(),
    score: numericString.optional(),
    mentions: numericString.optional(),
    mentionsCount: numericString.optional(),
    mentions_count: numericString.optional(),
    mindshare: numericString.optional(),
  })
  .passthrough();

/** Pull the array of rows out of the several envelope shapes Elfa may use. */
function extractRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload !== null && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    for (const key of ['data', 'result', 'results', 'rows', 'tokens'] as const) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
    // Elfa v2 sometimes nests the array one level deeper, e.g. `{ data: { items: [...] } }`.
    const data = obj.data;
    if (data !== null && typeof data === 'object') {
      const inner = data as Record<string, unknown>;
      for (const key of ['items', 'tokens', 'results', 'rows'] as const) {
        if (Array.isArray(inner[key])) return inner[key] as unknown[];
      }
    }
  }
  throw new ElfaParseError('no rows array in response envelope');
}

/** Normalize one parsed row to {@link ElfaSentiment}, or `null` to drop it. */
function normalizeRow(raw: unknown): ElfaSentiment | null {
  const parsed = sentimentRowSchema.safeParse(raw);
  if (!parsed.success) return null;
  const r = parsed.data;
  const sentiment = r.sentiment ?? r.sentimentScore ?? r.sentiment_score ?? r.score;
  if (sentiment === undefined) return null; // No usable signal value: drop the row.

  const symbol = r.symbol ?? r.tokenSymbol ?? r.token;
  const tokenAddress = r.tokenAddress ?? r.token_address ?? r.address;
  const mentions = r.mentions ?? r.mentionsCount ?? r.mentions_count;
  return {
    ...(symbol === undefined ? {} : { symbol }),
    ...(tokenAddress === undefined ? {} : { tokenAddress }),
    sentiment,
    ...(mentions === undefined ? {} : { mentions }),
    ...(r.mindshare === undefined ? {} : { mindshare: r.mindshare }),
  };
}

/** Largest `Retry-After` we will report (ms). Clamps a hostile/huge header. */
const MAX_RETRY_AFTER_MS = 5 * 60 * 1_000;

/**
 * Parse a `Retry-After` header (delta-seconds) into a sane positive ms value,
 * or `undefined`. Rejects non-finite/negative input and clamps absurd values so
 * a compromised upstream cannot inject a multi-year or negative delay.
 */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
}

/** Read the body as text under a hard byte cap, then `JSON.parse`. */
async function readJsonBounded(res: Response): Promise<unknown> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new ElfaParseError(`response too large (${declared} bytes)`);
  }
  const text = await res.text();
  // Measure UTF-8 byte length (not UTF-16 code-unit `.length`) so the memory
  // bound holds for multi-byte payloads.
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_RESPONSE_BYTES) {
    throw new ElfaParseError(`response too large (${bytes} bytes)`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ElfaParseError('invalid JSON');
  }
}

/**
 * Build an Elfa trending-tokens client. The returned
 * {@link ElfaClient.fetchSignal} performs exactly one bounded HTTP round-trip
 * and normalizes the result, or rejects with one of the typed errors above.
 */
export function createElfaClient(deps: ElfaClientDeps): ElfaClient {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const maxRows = deps.maxRows ?? DEFAULT_MAX_ROWS;
  const url = new URL(ELFA_TRENDING_PATH, deps.endpoint).toString();

  async function fetchSignal(): Promise<ElfaSignal> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // One try spans the *entire* round-trip — connect, status checks, AND body
    // read — so the timeout/abort covers a slow-drip body, not just the headers.
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        // Single-endpoint credentialed call: never follow a redirect, which
        // could resend the key header to an attacker-controlled origin.
        redirect: 'error',
        headers: {
          accept: 'application/json',
          // Secret lives only in this header, for this request. Never logged.
          'x-elfa-api-key': deps.apiKey,
        },
        signal: controller.signal,
      });

      if (res.status === 429) {
        throw new ElfaRateLimitError(parseRetryAfterMs(res.headers.get('retry-after')));
      }
      if (res.status === 402) throw new ElfaPaymentRequiredError();
      if (!res.ok) throw new ElfaHttpError(res.status);

      const payload = await readJsonBounded(res);
      const rows = extractRows(payload);
      const sentiments: ElfaSentiment[] = [];
      let scanned = 0;
      for (const row of rows) {
        if (sentiments.length >= maxRows || scanned >= MAX_ROWS_SCANNED) break;
        scanned += 1;
        const normalized = normalizeRow(row);
        if (normalized !== null) sentiments.push(normalized);
      }

      return {
        source: 'elfa',
        origin: 'live',
        endpoint: ELFA_TRENDING_PATH,
        fetchedAtMs: now(),
        sentiments,
      };
    } catch (err) {
      if (err instanceof ElfaClientError) throw err; // Already typed; keep it.
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ElfaTimeoutError(timeoutMs);
      }
      throw new ElfaClientError(err instanceof Error ? err.message : 'network error');
    } finally {
      clearTimeout(timer);
    }
  }

  return { fetchSignal };
}
