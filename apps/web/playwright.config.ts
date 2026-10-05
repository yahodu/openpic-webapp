import { defineConfig } from "@playwright/test";

import { E2E_BASE_URL, E2E_PORT, PRODUCTION_BASE_URL, PRODUCTION_PORT } from "./e2e/ports";

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
 *
 * Playwright has no per-project `webServer`, so the production server is only
 * booted when the `api-production` project is part of the run: an `api`-only
 * run must not pay for a second standalone server plus a second
 * `MongoMemoryReplSet`. The project selection is read from the CLI arguments,
 * defaulting to "boot it" when no `--project`/`-p` filter is given.
 */

/** Collect every project name selected on the command line. */
function selectedProjects(): string[] {
  const args = process.argv.slice(2);
  const selected: string[] = [];

  for (const [i, arg] of args.entries()) {
    if (arg === "--project" || arg === "-p") {
      selected.push(args.at(i + 1) ?? "");
    } else if (arg.startsWith("--project=")) {
      selected.push(arg.slice("--project=".length));
    } else if (arg.startsWith("-p=")) {
      selected.push(arg.slice("-p=".length));
    }
  }

  return selected;
}

/** True when the run includes the `api-production` project (or every project). */
function runsProductionProject(): boolean {
  const selected = selectedProjects();
  return selected.length === 0 || selected.includes("api-production");
}

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
      url: `${E2E_BASE_URL}/api/v1/health`,
      env: { APP_ENV: "e2e", PORT: E2E_PORT, HOSTNAME: "127.0.0.1" },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    // The production-flavoured launcher for the route-guard project (E2). It is
    // never reused (`reuseExistingServer: false`): the readiness probe would
    // happily answer from a stale server started with the wrong `APP_ENV`,
    // which is exactly what this guard test must not accept.
    ...(runsProductionProject()
      ? [
          {
            command: "node e2e/start-production-server.mjs",
            url: `${PRODUCTION_BASE_URL}/api/v1/health`,
            env: { APP_ENV: "production", PORT: PRODUCTION_PORT, HOSTNAME: "127.0.0.1" },
            reuseExistingServer: false,
            timeout: 120_000,
          },
        ]
      : []),
  ],
  projects: [
    {
      name: "api",
      testIgnore: /auth-production\.spec\.ts/,
      use: {
        baseURL: E2E_BASE_URL,
        extraHTTPHeaders: { accept: "application/json" },
      },
    },
    {
      name: "api-production",
      testMatch: /auth-production\.spec\.ts/,
      use: {
        baseURL: PRODUCTION_BASE_URL,
        extraHTTPHeaders: { accept: "application/json" },
      },
    },
  ],
});
