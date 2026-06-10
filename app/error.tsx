'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import styles from './error-screen.module.css';

/**
 * Root error boundary. Renders a themed recovery screen and offers a reset;
 * never echoes the error message itself (it may carry internal detail) — the
 * digest is enough to correlate with server logs.
 */
export default function ErrorScreen({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}): ReactNode {
  return (
    <main className={styles.screen}>
      <div className={styles.card}>
        <p className={styles.code}>500</p>
        <h1 className={styles.title}>Something tripped the breaker</h1>
        <p className={styles.hint}>
          An unexpected error interrupted this screen.
          {error.digest ? ` Digest: ${error.digest}.` : ''} Try again, or head back to the Arena.
        </p>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} onClick={() => reset()}>
            Try again
          </button>
          <Link href="/arena" className={styles.secondary}>
            Watch the Arena →
          </Link>
        </div>
      </div>
    </main>
  );
}
