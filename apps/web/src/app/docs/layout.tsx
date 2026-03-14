import type { ReactNode } from 'react';
import { source } from '@/lib/docs-source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';

export default function DocsRootLayout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{ title: 'WAHooks' }}
    >
      {children}
    </DocsLayout>
  );
}
