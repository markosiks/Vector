'use client';

import useSWR from 'swr';

import type { AttackResultDto, OperatorStateDto } from '@/lib/api/dto';
import type { AgentStatus } from '@/lib/db/schema';

/**
 * Client data + mutation hooks for the operator console.
 *
 * Reads poll `/api/operator/state` at the app-wide `ui_poll_ms` cadence (set in
 * `app/providers.tsx`) so a toggle made elsewhere converges within one poll.
 * Mutations are plain `POST`s; the session cookie rides along automatically
 * (same-origin), and each resolves by revalidating the state so the UI reflects
 * the committed truth rather than an optimistic guess.
 */

export interface OperatorState {
  data: OperatorStateDto | undefined;
  error: unknown;
  isLoading: boolean;
  refresh: () => Promise<unknown>;
}

/** The console hydration feed. A 401/403 surfaces as `error` (re-login / disabled). */
export function useOperatorState(): OperatorState {
  const { data, error, isLoading, mutate } = useSWR<OperatorStateDto>('/api/operator/state');
  return { data, error, isLoading, refresh: () => mutate() };
}

/** Shared JSON POST that throws the server's error code on a non-2xx. */
async function postJson<T>(url: string, body: unknown): Promise<T | null> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const code = await res
      .json()
      .then((b: { error?: { code?: string } }) => b.error?.code ?? `http_${res.status}`)
      .catch(() => `http_${res.status}`);
    throw new Error(code);
  }
  // 204 (login/logout) has no body.
  if (res.status === 204) return null;
  return (await res.json()) as T;
}

/** Log in with the shared operator token. Throws on an invalid token. */
export async function login(token: string): Promise<void> {
  await postJson('/api/operator/session', { token });
}

/** Log out (clear the session cookie). */
export async function logout(): Promise<void> {
  await fetch('/api/operator/session', { method: 'DELETE' });
}

/** Toggle the global kill switch. */
export async function setKillSwitch(active: boolean, reason: string | null): Promise<void> {
  await postJson('/api/operator/kill-switch', { active, reason });
}

/** Set one agent's operator status (per-agent HALT control). */
export async function setAgentStatus(id: string, status: AgentStatus): Promise<void> {
  await postJson(`/api/operator/agents/${id}/status`, { status });
}

/** Fire the scripted drain at the current leader. `key` is the per-click uuid. */
export async function fireAttack(key: string): Promise<AttackResultDto> {
  const result = await postJson<AttackResultDto>('/api/operator/attack', {
    idempotency_key: key,
  });
  if (result === null) throw new Error('empty_attack_response');
  return result;
}
