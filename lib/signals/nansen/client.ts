import { z } from 'zod';

import type { NansenNetflow, NansenSignal } from './types';

/**
 * Typed client for a *single* Nansen Smart Money endpoint (P2.2): the
 * `netflows` query, which reports net USD flow by smart-money wallets per token.
 *
 * Scope is deliberately one call (§3 / MVP): no pagination, no Token God Mode,
 * no backtesting. The client is transport-only and *pure with respect to its
 * deps* — the API key, base URL, `fetch` implementation, and clock are all
 * injected — so it is fully unit-testable without a network or `server-only`
 * import. The secret-loading wrapper lives in `./load` (`server-only`).
 *
 * Failure model: every reachable failure maps to one of the typed errors below,
 * which the provider (`./provider`) catches and degrades to the last cached
 * snapshot (fail-open). The client never returns partial or guessed data: a
 * response it cannot confidently normalize is a {@link NansenParseError}.
 */

/** The one endpoint path this client speaks to (appended to the base URL). */
export const NANSEN_NETFLOWS_PATH = '/api/v1/smart-money/netflows';

/** Default per-request wall-clock timeout. */
const DEFAULT_TIMEOUT_MS = 5_000;

/** Hard cap on the raw response body we will buffer + parse (bounds memory). */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Hard cap on normalized rows kept from a response (bounds downstream work). */
const DEFAULT_MAX_ROWS = 50;

/** Base class for every Nansen client failure. */
export class NansenClientError extends Error {}

/** The request exceeded its wall-clock timeout and was aborted. */
export class NansenTimeoutError extends NansenClientError {
  constructor(public readonly timeoutMs: number) {
    super(`nansen request timed out after ${timeoutMs}ms`);
    this.name = 'NansenTimeoutError';
  }
}

/** Nansen returned `429` — rate-limited / out of credits for this window. */
export class NansenRateLimitError extends NansenClientError {
  constructor(public readonly retryAfterMs?: number) {
    super('nansen rate-limited (HTTP 429)');
    this.name = 'NansenRateLimitError';
  }
}

/** Nansen returned a non-2xx, non-429 status. */
export class NansenHttpError extends NansenClientError {
  constructor(public readonly status: number) {
    super(`nansen responded with HTTP ${status}`);
    this.name = 'NansenHttpError';
  }
}

/** The response body was not valid JSON, too large, or not a shape we can map. */
export class NansenParseError extends NansenClientError {
  constructor(reason: string) {
    super(`nansen response could not be parsed: ${reason}`);
    this.name = 'NansenParseError';
  }
}

/** The minimal client surface the provider depends on. */
export interface NansenClient {
  /** Fetch and normalize one smart-money snapshot, or throw a typed error. */
  fetchSignal(): Promise<NansenSignal>;
}

/** Dependencies for {@link createNansenClient}. All transport is injectable. */
export interface NansenClientDeps {
  /** Nansen API key. Sent in the `apiKey` header only; never logged. */
  readonly apiKey: string;
  /** API base URL (non-secret); supplied from `CONFIG.nansen.endpoint`. */
  readonly endpoint: string;
  /** `fetch` implementation; defaults to the global. Injected for tests. */
  readonly fetchImpl?: typeof fetch;
  /** Per-request timeout in ms (default {@link DEFAULT_TIMEOUT_MS}). */
  readonly timeoutMs?: number;
  /** Clock for `fetchedAtMs` stamping; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Max normalized rows to keep (default {@link DEFAULT_MAX_ROWS}). */
  readonly maxRows?: number;
  /** Request body sent to the netflows endpoint. A safe minimal default is used. */
  readonly requestBody?: unknown;
}

/**
 * A finite numeric value as a string. Accepts a JS number or a string; rejects
 * `NaN`/`Infinity` and non-numeric text. Stored as-reported (no float reparse)
 * to honour the project's "numeric is exact" invariant.
 */
const numericString = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const s = typeof v === 'number' ? String(v) : v.trim();
  // Reject empties and anything Number() can't turn into a finite value.
  if (s.length === 0 || !Number.isFinite(Number(s))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not a finite number' });
    return z.NEVER;
  }
  return s;
});

/**
 * One netflows row. Tolerant by design: Nansen's exact keys vary by API
 * version, so the netflow value is read from any of several known aliases and
 * descriptive fields are optional. Unknown keys are ignored (`passthrough`),
 * never trusted.
 */
const netflowRowSchema = z
  .object({
    chain: z.string().min(1).optional(),
    tokenAddress: z.string().min(1).optional(),
    token_address: z.string().min(1).optional(),
    address: z.string().min(1).optional(),
    symbol: z.string().min(1).optional(),
    tokenSymbol: z.string().min(1).optional(),
    netflowUsd: numericString.optional(),
    netflow_usd: numericString.optional(),
    netflow: numericString.optional(),
    volumeUsd: numericString.optional(),
  })
  .passthrough();

/** Pull the array of rows out of the several envelope shapes Nansen may use. */
function extractRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload !== null && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    for (const key of ['data', 'result', 'results', 'rows'] as const) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  throw new NansenParseError('no rows array in response envelope');
}

/** Normalize one parsed row to {@link NansenNetflow}, or `null` to drop it. */
function normalizeRow(raw: unknown): NansenNetflow | null {
  const parsed = netflowRowSchema.safeParse(raw);
  if (!parsed.success) return null;
  const r = parsed.data;
  const netflowUsd = r.netflowUsd ?? r.netflow_usd ?? r.netflow ?? r.volumeUsd;
  if (netflowUsd === undefined) return null; // No usable signal value: drop the row.

  const chain = r.chain;
  const tokenAddress = r.tokenAddress ?? r.token_address ?? r.address;
  const symbol = r.symbol ?? r.tokenSymbol;
  return {
    ...(chain === undefined ? {} : { chain }),
    ...(tokenAddress === undefined ? {} : { tokenAddress }),
    ...(symbol === undefined ? {} : { symbol }),
    netflowUsd,
  };
}

/** Read the body as text under a hard byte cap, then `JSON.parse`. */
async function readJsonBounded(res: Response): Promise<unknown> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new NansenParseError(`response too large (${declared} bytes)`);
  }
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new NansenParseError(`response too large (${text.length} bytes)`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new NansenParseError('invalid JSON');
  }
}

/**
 * Build a Nansen netflows client. The returned {@link NansenClient.fetchSignal}
 * performs exactly one bounded HTTP round-trip and normalizes the result, or
 * rejects with one of the typed errors above.
 */
export function createNansenClient(deps: NansenClientDeps): NansenClient {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const maxRows = deps.maxRows ?? DEFAULT_MAX_ROWS;
  const url = new URL(NANSEN_NETFLOWS_PATH, deps.endpoint).toString();
  // A minimal, generic netflows query. Overridable but never required so the
  // demo can run without venue-specific tuning.
  const body = deps.requestBody ?? { parameters: {} };

  async function fetchSignal(): Promise<NansenSignal> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Secret lives only in this header, for this request. Never logged.
          apiKey: deps.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new NansenTimeoutError(timeoutMs);
      }
      throw new NansenClientError(err instanceof Error ? err.message : 'network error');
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      const header = res.headers.get('retry-after');
      const retryAfterMs =
        header !== null && Number.isFinite(Number(header)) ? Number(header) * 1_000 : undefined;
      throw new NansenRateLimitError(retryAfterMs);
    }
    if (!res.ok) throw new NansenHttpError(res.status);

    const payload = await readJsonBounded(res);
    const rows = extractRows(payload);
    const netflows: NansenNetflow[] = [];
    for (const row of rows) {
      if (netflows.length >= maxRows) break;
      const normalized = normalizeRow(row);
      if (normalized !== null) netflows.push(normalized);
    }

    return {
      source: 'nansen',
      endpoint: NANSEN_NETFLOWS_PATH,
      fetchedAtMs: now(),
      netflows,
    };
  }

  return { fetchSignal };
}
