import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import security from "eslint-plugin-security";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/next-env.d.ts",
      "**/.husky/**",
      "eslint.config.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  security.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Never log with console.* outside the stdout logger adapter.
      "no-console": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Never read process.env outside src/server/config.
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message: "Read environment variables only in src/server/config.",
        },
      ],
    },
  },
  {
    // The logger stdout adapter is the single console exemption.
    files: ["apps/web/src/server/logging/**"],
    rules: { "no-console": "off" },
  },
  {
    // Config is the single process.env exemption.
    files: ["apps/web/src/server/config/**"],
    rules: { "no-restricted-properties": "off" },
  },
  {
    // Import boundary: route handlers must not reach into adapters directly.
    files: ["apps/web/src/app/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/server/adapters/**", "@/server/adapters/*"],
              message: "Route handlers must depend on services, not adapters.",
            },
          ],
        },
      ],
    },
  },
  {
    // Tests, mocks, e2e and config files: process.env is legitimate, and
    // type-aware strictness is relaxed where the harness needs it.
    files: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/test/**",
      "**/mocks/**",
      "**/e2e/**",
      "**/*.config.ts",
      "**/*.config.mjs",
      "**/instrumentation.ts",
      "next.config.ts",
    ],
    rules: {
      "no-restricted-properties": "off",
    },
  },
  prettier
);
