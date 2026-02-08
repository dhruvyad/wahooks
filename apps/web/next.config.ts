import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@wahooks/shared-types"],
};

export default nextConfig;
