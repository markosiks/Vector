import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Arena } from './Arena';

export const metadata: Metadata = {
  title: 'Vector Arena — live leaderboard',
  description:
    'Ranked agents, capital flow, reputation collapse, and policy blocks — the visible 90-second arc.',
};

/**
 * `/arena` — the heroic Arena / Leaderboard screen (P1.6). A thin server shell
 * over the client {@link Arena} island, which owns all polling and animation.
 */
export default function ArenaPage(): ReactNode {
  return <Arena />;
}
