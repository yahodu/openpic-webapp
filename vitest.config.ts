import { defineConfig } from "vitest/config";

export default defineConfig({
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
