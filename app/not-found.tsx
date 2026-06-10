import Link from 'next/link';
import type { ReactNode } from 'react';

import styles from './error-screen.module.css';

/** `/404` — themed not-found screen with a route back into the demo surfaces. */
export default function NotFound(): ReactNode {
  return (
    <main className={styles.screen}>
      <div className={styles.card}>
        <p className={styles.code}>404</p>
        <h1 className={styles.title}>This route never crossed the boundary</h1>
        <p className={styles.hint}>
          The page you asked for does not exist. The live surfaces are the Arena, the Attestation
          Log, and the agent-detail screens.
        </p>
        <div className={styles.actions}>
          <Link href="/arena" className={styles.primary}>
            Watch the Arena →
          </Link>
          <Link href="/" className={styles.secondary}>
            Home
          </Link>
        </div>
      </div>
    </main>
  );
}
