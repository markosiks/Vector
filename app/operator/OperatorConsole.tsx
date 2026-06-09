'use client';

import { useState, type ReactNode } from 'react';

import type { AttackResultDto, LeaderboardEntryDto } from '@/lib/api/dto';
import { fireAttack, logout, setAgentStatus, setKillSwitch, useOperatorState } from './hooks';
import styles from './operator.module.css';

/**
 * The operator safety console (P2.4 §11.1): a global HALT switch, per-agent HALT
 * toggles, the scripted-attack button, and the audit feed. Every control is
 * disabled while its request is in flight (the double-click guard), and the view
 * re-hydrates from `/api/operator/state` after each mutation so it always shows
 * committed truth. The buttons only flip server state; the referee and router
 * enforce the consequences.
 */
export function OperatorConsole(): ReactNode {
  const { data, error, isLoading, refresh } = useOperatorState();
  const [busy, setBusy] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [attack, setAttack] = useState<AttackResultDto | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // A 401/403 from the state feed means the session expired or the console was
  // disabled — fall back to a reload so the server page re-gates.
  if (error !== undefined && data === undefined) {
    return (
      <main className={styles.screen}>
        <p className={styles.banner} role="alert">
          Session expired or console unavailable.{' '}
          <button className={styles.linkBtn} onClick={() => window.location.reload()}>
            Reload
          </button>
        </p>
      </main>
    );
  }

  async function run(label: string, fn: () => Promise<void>): Promise<void> {
    if (busy !== null) return;
    setBusy(label);
    setActionError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'action_failed');
    } finally {
      setBusy(null);
    }
  }

  const killActive = data?.kill_switch.active ?? false;

  return (
    <main className={styles.screen}>
      <header className={styles.header}>
        <h1 className={styles.title}>Operator Console</h1>
        <button
          className={styles.linkBtn}
          onClick={() => void logout().finally(() => window.location.reload())}
        >
          Sign out
        </button>
      </header>

      {actionError !== null && (
        <p className={styles.banner} role="alert">
          Action failed: {actionError}
        </p>
      )}
      {isLoading && data === undefined && <p className={styles.muted}>Loading…</p>}

      {/* Global HALT */}
      <section className={`${styles.panel} ${killActive ? styles.panelHalted : ''}`}>
        <div className={styles.panelHead}>
          <h2 className={styles.panelTitle}>Global HALT</h2>
          <span className={killActive ? styles.statusHalted : styles.statusActive}>
            {killActive ? 'HALTED — all execution frozen' : 'Running'}
          </span>
        </div>
        <p className={styles.muted}>
          Freezes execution for every agent through the referee (rule #1) and gates all capital out.
        </p>
        <div className={styles.row}>
          <input
            className={styles.reasonInput}
            type="text"
            value={reason}
            placeholder="Reason (optional)"
            aria-label="Halt reason"
            onChange={(e) => setReason(e.target.value)}
            disabled={killActive}
          />
          {killActive ? (
            <button
              className={styles.resumeBtn}
              disabled={busy !== null}
              onClick={() => void run('kill', () => setKillSwitch(false, null))}
            >
              {busy === 'kill' ? 'Resuming…' : 'Resume all'}
            </button>
          ) : (
            <button
              className={styles.haltBtn}
              disabled={busy !== null}
              onClick={() =>
                void run('kill', () =>
                  setKillSwitch(true, reason.trim() === '' ? null : reason.trim()),
                )
              }
            >
              {busy === 'kill' ? 'Halting…' : 'HALT everything'}
            </button>
          )}
        </div>
        {data?.kill_switch.reason !== null && data?.kill_switch.reason !== undefined && (
          <p className={styles.muted}>Reason: {data.kill_switch.reason}</p>
        )}
      </section>

      {/* Scripted attack */}
      <section className={styles.panel}>
        <div className={styles.panelHead}>
          <h2 className={styles.panelTitle}>Scripted attack</h2>
        </div>
        <p className={styles.muted}>
          Injects the canonical drain into the current leader through the real referee. Expected
          outcome: <strong>REJECT (fresh_wallet_transfer_block)</strong>, or HALT if a stop is
          active.
        </p>
        <button
          className={styles.attackBtn}
          disabled={busy !== null}
          onClick={() =>
            void run('attack', async () => {
              const result = await fireAttack(crypto.randomUUID());
              setAttack(result);
            })
          }
        >
          {busy === 'attack' ? 'Injecting…' : 'Inject drain attack'}
        </button>
        {attack !== null && (
          <p className={styles.attackResult} role="status">
            → {attack.decision} / {attack.severity} · rule <code>{attack.rule_fired}</code> on{' '}
            <strong>{attack.target_display_name}</strong>
            {attack.duplicate ? ' (idempotent retry)' : ''}
          </p>
        )}
      </section>

      {/* Per-agent HALT */}
      <section className={styles.panel}>
        <div className={styles.panelHead}>
          <h2 className={styles.panelTitle}>Agents</h2>
        </div>
        <ul className={styles.agentList}>
          {(data?.agents ?? []).map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              busy={busy === `agent:${agent.id}`}
              disabled={busy !== null}
              onToggle={(next) =>
                void run(`agent:${agent.id}`, () => setAgentStatus(agent.id, next))
              }
            />
          ))}
        </ul>
      </section>

      {/* Audit feed */}
      <section className={styles.panel}>
        <div className={styles.panelHead}>
          <h2 className={styles.panelTitle}>Audit log</h2>
        </div>
        <ul className={styles.auditList}>
          {(data?.recent_actions ?? []).map((a) => (
            <li key={a.id} className={styles.auditRow}>
              <span className={styles.auditKind}>{a.kind}</span>
              <span className={styles.auditDetail}>{JSON.stringify(a.detail)}</span>
              <time className={styles.auditTime}>
                {new Date(a.created_at).toLocaleTimeString()}
              </time>
            </li>
          ))}
          {(data?.recent_actions ?? []).length === 0 && (
            <li className={styles.muted}>No operator actions yet.</li>
          )}
        </ul>
      </section>
    </main>
  );
}

function AgentRow({
  agent,
  busy,
  disabled,
  onToggle,
}: {
  agent: LeaderboardEntryDto;
  busy: boolean;
  disabled: boolean;
  onToggle: (next: 'active' | 'halted') => void;
}): ReactNode {
  const halted = agent.status === 'halted';
  return (
    <li className={styles.agentRow}>
      <span className={styles.agentName}>{agent.display_name}</span>
      <span className={halted ? styles.badgeHalted : styles.badge}>{agent.status}</span>
      <button
        className={halted ? styles.resumeBtn : styles.haltBtn}
        disabled={disabled}
        onClick={() => onToggle(halted ? 'active' : 'halted')}
      >
        {busy ? '…' : halted ? 'Resume' : 'HALT'}
      </button>
    </li>
  );
}
