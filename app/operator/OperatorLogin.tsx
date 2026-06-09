'use client';

import { useState, type FormEvent, type ReactNode } from 'react';

import { login } from './hooks';
import styles from './operator.module.css';

/**
 * The operator login card. Posts the shared token to `/api/operator/session`;
 * the server validates it in constant time and sets the httpOnly session cookie.
 * On success it reloads so the server component re-renders the console with a
 * valid session. The token is never persisted client-side beyond the keystroke.
 */
export function OperatorLogin(): ReactNode {
  const [token, setToken] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (pending || token.length === 0) return;
    setPending(true);
    setError(null);
    try {
      await login(token);
      // Reload: the server page re-evaluates the cookie and renders the console.
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'login_failed');
      setPending(false);
    }
  }

  return (
    <main className={styles.loginScreen}>
      <form className={styles.loginCard} onSubmit={onSubmit}>
        <h1 className={styles.loginTitle}>Operator Console</h1>
        <p className={styles.loginHint}>Enter the operator token to access kill-switch controls.</p>
        <input
          className={styles.tokenInput}
          type="password"
          value={token}
          autoComplete="off"
          placeholder="Operator token"
          aria-label="Operator token"
          onChange={(e) => setToken(e.target.value)}
        />
        <button
          className={styles.primaryBtn}
          type="submit"
          disabled={pending || token.length === 0}
        >
          {pending ? 'Authenticating…' : 'Unlock console'}
        </button>
        {error !== null && (
          <p className={styles.loginError} role="alert">
            {error === 'invalid_token' ? 'Invalid token.' : `Login failed (${error}).`}
          </p>
        )}
      </form>
    </main>
  );
}
