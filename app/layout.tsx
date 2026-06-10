import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { GITHUB_REPO_URL, meritRegistryExplorerUrl } from '@/lib/site/links';

import { Providers } from './providers';
import { SiteNav } from './SiteNav';
import './globals.css';

/** The canonical public origin; overridable per deployment, never a secret. */
const BASE_URL = process.env.PUBLIC_BASE_URL ?? 'https://vector-namegobon.vercel.app';

const TITLE = 'Vector — merit layer for autonomous capital on Mantle';
const DESCRIPTION =
  'Bounded-execution referee + deterministic AgentScore + reputation-weighted capital routing, anchored on-chain via ERC-8004 on Mantle Sepolia.';

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    default: TITLE,
    template: '%s · Vector',
  },
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: '/',
    siteName: 'Vector',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
  },
};

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <body>
        <SiteNav contractUrl={meritRegistryExplorerUrl()} repoUrl={GITHUB_REPO_URL} />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
