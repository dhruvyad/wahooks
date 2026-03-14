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
};

const withMDX = createMDX();

export default withMDX(config);
