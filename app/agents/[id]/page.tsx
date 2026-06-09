import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { AgentDetail } from './AgentDetail';

export const metadata: Metadata = {
  title: 'Vector — Agent detail',
  description:
    'EWMA score history, score composition, referee decisions, and outcomes for an agent.',
};

/**
 * `/agents/{id}` — the Agent-detail screen (P2.3). A thin server shell that
 * unwraps the dynamic `id` (Next 15 passes it as a promise) and hands it to the
 * client {@link AgentDetail} island, which owns fetching, polling, and the
 * not-found/empty states. The id is not validated here — the read API is the
 * single source of truth on whether it resolves.
 */
export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<ReactNode> {
  const { id } = await params;
  return <AgentDetail agentId={id} />;
}
