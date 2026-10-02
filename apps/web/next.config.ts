import path from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

/**
 * Pin the standalone file-tracing root to the repository root.
 *
 * Without this, Next infers the workspace root from the nearest lockfile; when
 * the app is built from a git worktree nested inside the main checkout it
 * selects the outer lockfile and mirrors the whole `.worktrees/<id>` path into
 * `standalone/`, so `standalone/apps/web/server.js` — the entry the Playwright
 * e2e config launches — would not exist. Pinning it keeps the standalone layout
 * independent of where the checkout lives.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: repoRoot,
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
