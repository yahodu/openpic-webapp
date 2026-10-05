/**
 * Shared ports for the Playwright API projects (OP-85).
 *
 * A single source of truth so `playwright.config.ts` and the specs (notably
 * `auth-production.spec.ts`, which probes the e2e server as its positive
 * control) cannot drift apart. `E2E_PORT`/`PRODUCTION_PORT` can be overridden
 * from the environment for CI sharding.
 */
export const E2E_PORT = process.env.E2E_PORT ?? "3000";
export const PRODUCTION_PORT = process.env.PRODUCTION_PORT ?? "3001";

/** The loopback base URL of the `APP_ENV=e2e` server (`api` project). */
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

/** The loopback base URL of the `APP_ENV=production` server (`api-production`). */
export const PRODUCTION_BASE_URL = `http://127.0.0.1:${PRODUCTION_PORT}`;
