import { createMDX } from 'fumadocs-mdx/next';

/** @type {import('next').NextConfig} */
const config = {
  transpilePackages: ['@wahooks/shared-types'],
  async redirects() {
    return [
      {
        source: '/install',
        destination: 'https://raw.githubusercontent.com/dhruvyad/wahooks/main/cli/install.sh',
        permanent: false,
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: '/ingest/static/:path*',
        destination: 'https://us-assets.i.posthog.com/static/:path*',
      },
      {
        source: '/ingest/:path*',
        destination: 'https://us.i.posthog.com/:path*',
      },
      {
        source: '/ingest/decide',
        destination: 'https://us.i.posthog.com/decide',
      },
    ];
  },
};

const withMDX = createMDX();

export default withMDX(config);
