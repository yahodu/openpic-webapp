import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  reactStrictMode: true,
  transpilePackages: ["@openpic/contracts"],
  // Lint is a dedicated gate (`pnpm lint`, run separately in CI). Running it a
  // second time inside `next build` only couples the build to spec-file style
  // and makes `next start`/Playwright impossible to reach.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
