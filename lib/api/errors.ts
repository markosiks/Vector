/**
 * Error model for the read API.
 *
 * Every request resolves to exactly one of three deterministic outcomes: a
 * typed result, a client error (`4xx`, the caller's fault — validated and safe
 * to echo), or a server/dependency error (`5xx`, never echoing internals). This
 * module names the client errors and classifies everything else, so a route
 * handler can `throw` an {@link ApiError} for the expected cases and let
 * {@link classifyError} collapse any unexpected throw into a safe `503`/`500`
 * without leaking a stack trace, a query, or the database connection string.
 */

/** A client error with a stable machine code and a safe, user-facing message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 400 — the request's query/path was malformed. The message is safe to echo. */
export class BadRequestError extends ApiError {
  constructor(message = 'Bad request', code = 'bad_request') {
    super(400, code, message);
    this.name = 'BadRequestError';
  }
}

/** 401 — the request lacks a valid operator session (missing/invalid credential). */
export class UnauthorizedError extends ApiError {
  constructor(message = 'Operator authentication required', code = 'unauthorized') {
    super(401, code, message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * 403 — the operator console is not configured for this deployment, so the
 * controls are disabled outright (no `OPERATOR_CONSOLE_TOKEN`). Distinct from
 * 401: there is no credential that could ever succeed here.
 */
export class ForbiddenError extends ApiError {
  constructor(message = 'Operator console is disabled', code = 'operator_disabled') {
    super(403, code, message);
    this.name = 'ForbiddenError';
  }
}

/** 404 — a well-formed identifier referenced a row that does not exist. */
export class NotFoundError extends ApiError {
  constructor(message = 'Not found', code = 'not_found') {
    super(404, code, message);
    this.name = 'NotFoundError';
  }
}

/** 429 — the client has exceeded the allowed request rate. */
export class TooManyRequestsError extends ApiError {
  constructor(message = 'Too many requests', code = 'too_many_requests') {
    super(429, code, message);
    this.name = 'TooManyRequestsError';
  }
}

/** The stable JSON error body. Only `code` + `message` ever cross the boundary. */
export interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

/** A classified error: the HTTP status and the body that is safe to return. */
export interface ClassifiedError {
  readonly status: number;
  readonly body: ErrorBody;
}

/**
 * Postgres `SQLSTATE` class 08 (connection exception) + admin-shutdown / too-many
 * codes, and the node/libuv socket errnos the Neon driver surfaces when the
 * backend is unreachable. A throw carrying one of these is a *dependency*
 * outage, not a bug, so it maps to `503` (retryable) rather than `500`.
 */
const DB_UNAVAILABLE_CODES = new Set<string>([
  // Postgres connection-exception class.
  '08000',
  '08003',
  '08006',
  '08001',
  '08004',
  '08007',
  '08P01',
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  // node / libuv socket errnos.
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/** True iff `err` looks like the database being unreachable rather than a bug. */
export function isDbUnavailable(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && DB_UNAVAILABLE_CODES.has(code);
}

/**
 * Map any thrown value to a safe HTTP outcome.
 *
 * - {@link ApiError} → its own status/code/message (already curated, safe).
 * - a connection failure ({@link isDbUnavailable}) → `503`, generic message.
 * - anything else → `500`, generic message. The original error is **not**
 *   echoed: an unexpected throw can carry a query, a row, or the connection
 *   string, none of which may reach the client.
 */
export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof ApiError) {
    return { status: err.status, body: { error: { code: err.code, message: err.message } } };
  }
  if (isDbUnavailable(err)) {
    return {
      status: 503,
      body: { error: { code: 'service_unavailable', message: 'Service temporarily unavailable' } },
    };
  }
  return {
    status: 500,
    body: { error: { code: 'internal_error', message: 'Internal server error' } },
  };
}
