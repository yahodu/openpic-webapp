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
  /**
   * Route the test-only OTP read-back endpoint.
   *
   * The contract path is `/api/v1/__test__/otp`, but Next.js treats an
   * underscore-prefixed segment (`__test__`) as a *private folder* and excludes
   * it from routing, so a route file placed there is never served. A rewrite
   * maps the public path onto a normal handler; the handler itself is what
   * enforces the `test`/`e2e`-only guard (and answers `404` everywhere else).
   */
  rewrites() {
    return Promise.resolve([
      {
        source: "/api/v1/__test__/otp",
        destination: "/api/v1/test-support/otp",
      },
    ]);
  },
  // Lint is a dedicated gate (`pnpm lint`, run separately in CI). Running it a
  // second time inside `next build` only couples the build to spec-file style
  // and makes `next start`/Playwright impossible to reach.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
