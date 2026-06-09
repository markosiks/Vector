import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { isAuthenticatedServer, isOperatorConfigured } from '@/lib/operator/auth';
import { OperatorConsole } from './OperatorConsole';
import { OperatorLogin } from './OperatorLogin';
import styles from './operator.module.css';

export const metadata: Metadata = {
  title: 'Vector — Operator Console',
  description: 'Operator safety controls: global HALT, per-agent HALT, scripted attack.',
};

// Always dynamic: the rendered branch depends on the request's session cookie.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * `/operator` — the kill-switch console (P2.4). A server shell that gates on the
 * session: when the console is unconfigured it renders a disabled notice; an
 * unauthenticated request gets the login card; an authenticated operator gets
 * the live console island. The mutating routes re-verify the session on every
 * request — this gate is the UX, not the security boundary.
 */
export default async function OperatorPage(): Promise<ReactNode> {
  if (!isOperatorConfigured()) {
    return (
      <main className={styles.loginScreen}>
        <div className={styles.loginCard}>
          <h1 className={styles.loginTitle}>Operator Console</h1>
          <p className={styles.loginHint}>
            Disabled: no <code>OPERATOR_CONSOLE_TOKEN</code> is configured for this deployment.
          </p>
        </div>
      </main>
    );
  }
  if (!(await isAuthenticatedServer())) {
    return <OperatorLogin />;
  }
  return <OperatorConsole />;
}
