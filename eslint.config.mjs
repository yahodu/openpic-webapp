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
      "**/.worktrees/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/next-env.d.ts",
      "**/.husky/**",
      "eslint.config.mjs",
      // Plain-JS e2e server launcher: run by Node directly, outside the
      // TypeScript project, so it is not covered by the type-aware parser.
      "apps/web/e2e/*.mjs",
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
    // The logger stdout adapter is the single console exemption, and the
    // logging internals are allowed to import each other.
    files: ["apps/web/src/server/logging/**"],
    rules: { "no-console": "off", "no-restricted-imports": "off" },
  },
  {
    // Config is the single process.env exemption.
    files: ["apps/web/src/server/config/**"],
    rules: { "no-restricted-properties": "off" },
  },
  {
    // Import boundary: route handlers must not reach into adapters directly,
    // and nobody outside the logging folder may import its internals — only
    // the `Logger` port from `@/server/logging`.
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
            {
              group: ["**/server/logging/**", "@/server/logging/*"],
              message: "Import only the Logger port from @/server/logging.",
            },
          ],
        },
      ],
    },
  },
  {
    // Same logging boundary for the rest of the server tree.
    files: ["apps/web/src/server/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/server/logging/**", "@/server/logging/*"],
              message: "Import only the Logger port from @/server/logging.",
            },
          ],
        },
      ],
    },
  },
  {
    // Domain and service code must read time through the injected `Clock`
    // port (OP-72), never the ambient wall clock — that is what makes those
    // layers deterministic in tests.
    files: ["apps/web/src/server/domain/**", "apps/web/src/server/services/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date']",
          message: "Use the Clock port, not `new Date()`.",
        },
        {
          selector: "MemberExpression[object.name='Date'][property.name='now']",
          message: "Use the Clock port, not `Date.now()`.",
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
      // Spec authors annotate complex array types as `Array<T>` / `readonly T[]`
      // for readability; the stylistic preference must not fail the build.
      "@typescript-eslint/array-type": "off",
      // `Response.json()` / Playwright's `response.json()` are typed `any`, so
      // asserting on parsed envelopes trips the unsafe-* rules. That is inherent
      // to testing an HTTP response, not a defect in the spec.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },
  prettier
);
