import { defineConfig } from "@playwright/test";

/**
 * Playwright config with two API projects (OP-85):
 *
 *   - `api` drives a real `next start` server in `APP_ENV=e2e` on port 3000
 *     (the existing suite plus the e2e half of E1/E2).
 *   - `api-production` drives a second standalone server in
 *     `APP_ENV=production` on port 3001, so the test-only OTP route guard can
 *     be proven against a real production configuration (E2).
 *
 * Both servers share the single `.next/standalone` build produced by `pnpm
 * build`; `APP_ENV` is a runtime variable, not a build-time one.
 */
const E2E_PORT = "3000";
const PRODUCTION_PORT = "3001";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  webServer: [
    {
      // The launcher boots a MongoDB replica set for the readiness probe and
      // then starts the standalone server (see `e2e/start-server.mjs`).
      command: "node e2e/start-server.mjs",
      url: `http://127.0.0.1:${E2E_PORT}/api/v1/health`,
      env: { APP_ENV: "e2e", PORT: E2E_PORT, HOSTNAME: "127.0.0.1" },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // The production-flavoured launcher for the route-guard project (E2).
      command: "node e2e/start-production-server.mjs",
      url: `http://127.0.0.1:${PRODUCTION_PORT}/api/v1/health`,
      env: { APP_ENV: "production", PORT: PRODUCTION_PORT, HOSTNAME: "127.0.0.1" },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: "api",
      testIgnore: /auth-production\.spec\.ts/,
      use: {
        baseURL: `http://127.0.0.1:${E2E_PORT}`,
        extraHTTPHeaders: { accept: "application/json" },
      },
    },
    {
      name: "api-production",
      testMatch: /auth-production\.spec\.ts/,
      use: {
        baseURL: `http://127.0.0.1:${PRODUCTION_PORT}`,
        extraHTTPHeaders: { accept: "application/json" },
      },
    },
  ],
});
