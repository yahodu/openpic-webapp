import { defineConfig } from "@playwright/test";

/**
 * Playwright `api` project: drives a real `next start` server through the
 * `request` fixture. The server runs with `APP_ENV=e2e`, which is what arms
 * the guarded MSW node handlers in `instrumentation.ts`.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: "http://127.0.0.1:3000",
    extraHTTPHeaders: { accept: "application/json" },
  },
  webServer: {
    command: "node .next/standalone/apps/web/server.js",
    url: "http://127.0.0.1:3000/api/v1/health",
    env: { APP_ENV: "e2e", PORT: "3000", HOSTNAME: "127.0.0.1" },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
