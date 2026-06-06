import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Vector — merit layer for autonomous capital on Mantle',
  description:
    'Bounded-execution referee + reputation scoring + reputation-weighted capital routing.',
};

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
