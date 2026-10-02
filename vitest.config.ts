import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Mirror the `@/* -> apps/web/src/*` path alias from `apps/web/tsconfig.json`
 * so Vitest can import route handlers / server modules by the same specifier
 * Next.js uses. Only the `@/` prefix is rewritten, so workspace packages such
 * as `@openpic/contracts` are left alone.
 */
const webSrc = fileURLToPath(new URL("./apps/web/src/", import.meta.url));

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
