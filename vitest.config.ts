import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Mirror the `@/* -> apps/web/src/*` path alias from `apps/web/tsconfig.json`
 * so Vitest can import route handlers / server modules by the same specifier
 * Next.js uses. Only the `@/` prefix is rewritten, so workspace packages such
 * as `@openpic/contracts` are left alone.
 */
const webSrc = fileURLToPath(new URL("./apps/web/src/", import.meta.url));

/**
 * Per-test budget for the `integration` project, in ms (ADR-0841).
 *
 * Vitest's 5 000 ms default sat only 1.26x above the slowest *passing* case of
 * a full `integration` run, so a worker under Mongo/CPU contention reddened an
 * unrelated spec with `Test timed out in 5000ms` on a tree that reads green on
 * the next run. The budget below is sized from a measured full run (2026-11-17,
 * 1452 cases / 139 files at `cbab1f0f`): p50 166 ms, p99 1 905 ms, slowest
 * passing case 3 953 ms — 30 000 ms is ~15.7x p99 and ~7.6x that maximum, and
 * the same ceiling the two specs that already pin their own budget
 * (`notification-seed`, `identity-hooks`) use.
 *
 * This is a ceiling for contention, not a performance gate: no assertion is
 * relaxed by it, and the `unit` project keeps the 5 000 ms default.
 */
const INTEGRATION_TEST_TIMEOUT_MS = 30_000;

/**
 * Per-hook budget for the `integration` project, in ms (ADR-0841 §Decision 4).
 *
 * Hooks were left on Vitest's 10 000 ms default when the case budget above was
 * raised, and a hook red of the same class has since been observed: a full run
 * at trunk `88d65749` failed `uploads-batch-status.test.ts` with
 * `Error: Hook timed out in 10000ms` in a `beforeEach` whose body is a
 * 21-collection `deleteMany` sweep — a hook that measures 15–42 ms in-hook and
 * that a whole full run finishes under 1 000 ms (145 files / 1 530 cases,
 * `hookTimeout: 1_000`, green). The violation is a descheduled worker over one
 * `MongoMemoryReplSet`, the same contention that sized the case budget, not
 * hook work that grew.
 *
 * So hooks are sized against the same ceiling as the cases they sit between:
 * 30 000 ms, the `integration` case budget, and comfortably inside the
 * 35 000 ms `MONGO_READY_HOOK_TIMEOUT_MS` the database-backed `beforeAll`s
 * already pass — the number is not new in this harness. A hook that passes an
 * explicit budget keeps its own value; this is the default those hooks that
 * carry none inherit.
 *
 * This is a ceiling for contention, not a performance gate: no assertion is
 * relaxed by it, and the `unit` project keeps the 10 000 ms default.
 */
const INTEGRATION_HOOK_TIMEOUT_MS = 30_000;

export default defineConfig({
  resolve: {
    alias: [{ find: /^@\//, replacement: webSrc }],
  },
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["packages/contracts/src/**/*.test.ts", "apps/web/src/**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/test/integration/**"],
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["apps/web/src/test/integration/**/*.test.ts"],
          setupFiles: ["apps/web/src/test/integration/setup.ts"],
          globalSetup: ["apps/web/src/test/integration/global-setup.ts"],
          testTimeout: INTEGRATION_TEST_TIMEOUT_MS,
          hookTimeout: INTEGRATION_HOOK_TIMEOUT_MS,
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: [
        "packages/contracts/src/**/*.ts",
        "apps/web/src/app/api/**/*.ts",
        "apps/web/src/server/**/*.ts",
      ],
      exclude: ["**/*.test.ts", "**/__tests__/**", "**/test/**"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
        "apps/web/src/server/domain/**": {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        "apps/web/src/server/services/**": {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
      },
    },
  },
});
