'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { isActivePath } from '@/lib/site/nav';

import styles from './site-nav.module.css';

/** The in-app destinations, in display order. */
const SCREENS: readonly { href: string; label: string }[] = [
  { href: '/arena', label: 'Arena' },
  { href: '/attestations', label: 'Attestations' },
  { href: '/onboarding', label: 'Onboarding' },
  { href: '/operator', label: 'Operator' },
  { href: '/health', label: 'Health' },
];

export interface SiteNavProps {
  /** Explorer URL of the deployed merit-registry contract (server-resolved). */
  readonly contractUrl: string;
  /** The public GitHub repository URL. */
  readonly repoUrl: string;
}

/**
 * The global navigation bar (rendered by the root layout on every screen).
 * Pure chrome: highlights the active screen from the pathname and exposes the
 * two external credibility links (GitHub source, contract on the explorer).
 */
export function SiteNav({ contractUrl, repoUrl }: SiteNavProps): ReactNode {
  const pathname = usePathname() ?? '/';

  return (
    <nav className={styles.nav} aria-label="Primary">
      <Link href="/" className={styles.brand}>
        <svg
          className={styles.brandMark}
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M3 4h5l4 10 4-10h5l-8 17z" fill="#2b6cff" />
        </svg>
        Vector
      </Link>

      <span className={styles.links}>
        {SCREENS.map(({ href, label }) => (
          <Link
            key={href}
            href={href}
            className={`${styles.link} ${isActivePath(pathname, href) ? styles.linkActive : ''}`}
            aria-current={isActivePath(pathname, href) ? 'page' : undefined}
          >
            {label}
          </Link>
        ))}
      </span>

      <span className={styles.spacer} />

      <span className={styles.external}>
        <a
          className={styles.externalLink}
          href={repoUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub ↗
        </a>
        <a
          className={styles.externalLink}
          href={contractUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Contract ↗
        </a>
      </span>
    </nav>
  );
}
