import { createMDX } from 'fumadocs-mdx/next';

/** @type {import('next').NextConfig} */
const config = {
  transpilePackages: ['@wahooks/shared-types'],
};

const withMDX = createMDX();

export default withMDX(config);
