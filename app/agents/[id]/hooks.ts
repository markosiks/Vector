'use client';

import useSWR from 'swr';

import type { AgentDetailDto } from '@/lib/api/dto';

/**
 * Client data layer for the Agent-detail screen (P2.3).
 *
 * A single `useSWR` polls `GET /api/agents/{id}` at the app-wide `ui_poll_ms`
 * cadence (inherited from the provider), so the EWMA curve, the referee table,
 * and the outcomes all advance together each round without a socket.
 *
 * The default app fetcher collapses every non-2xx to one opaque error; here we
 * need to tell a *malformed/unknown id* (`400`/`404` — show a "not found" state,
 * never retry into a tight loop) apart from a *transient dependency failure*
 * (`503` — keep polling). So this hook uses a local fetcher that preserves the
 * HTTP status on the thrown error, and disables retry for the 4xx case.
 */

/** An error that carries the HTTP status of a failed read, for UI branching. */
export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`request failed with status ${status}`);
    this.name = 'HttpError';
  }
}

async function statusAwareFetcher(resource: string): Promise<AgentDetailDto> {
  const res = await fetch(resource);
  if (!res.ok) throw new HttpError(res.status);
  return (await res.json()) as AgentDetailDto;
}

export interface AgentDetailResult {
  readonly data: AgentDetailDto | undefined;
  readonly error: HttpError | undefined;
  readonly isLoading: boolean;
  /** The id was malformed (`400`) or matched no agent (`404`) — a terminal miss. */
  readonly notFound: boolean;
}

export function useAgentDetail(id: string): AgentDetailResult {
  const { data, error, isLoading } = useSWR<AgentDetailDto, HttpError>(
    `/api/agents/${encodeURIComponent(id)}`,
    statusAwareFetcher,
    {
      // A 400/404 is a stable fact about the id; do not hammer the API retrying it.
      shouldRetryOnError: (err: HttpError) => !(err.status === 404 || err.status === 400),
    },
  );
  const notFound = error instanceof HttpError && (error.status === 404 || error.status === 400);
  return { data, error, isLoading, notFound };
}
