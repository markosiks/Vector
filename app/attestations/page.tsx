import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Attestations } from './Attestations';

export const metadata: Metadata = {
  title: 'Vector — Attestation Log',
  description:
    'ERC-8004 attestations mirrored from Mantle Sepolia, reconciling optimistic writes to on-chain confirmation.',
};

/**
 * `/attestations` — the Attestation Log screen (P2.3). A thin server shell over
 * the client {@link Attestations} island, which owns all polling and paging.
 */
export default function AttestationsPage(): ReactNode {
  return <Attestations />;
}
