import type { ReactNode } from 'react';
import { source } from '@/lib/docs-source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';

export default function DocsRootLayout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{
        title: (
          <span className="inline-flex items-center gap-2">
            <img src="/logo.svg" alt="" className="h-6 w-6" />
            <span>WAHooks</span>
          </span>
        ),
        url: '/docs',
      }}
      githubUrl="https://github.com/dhruvyad/wahooks"
    >
      {children}
    </DocsLayout>
  );
}
