import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import security from "eslint-plugin-security";
import tseslint from "typescript-eslint";

import noDirectCollectionAccess from "./eslint-rules/no-direct-collection-access.mjs";

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
      // The custom rule module itself is plain JS executed by the ESLint
      // loader, outside the TypeScript project (like the e2e launcher below).
      "eslint-rules/**",
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
            {
              group: ["novu", "@novu/*"],
              message:
                "Import Novu only inside the Novu adapter (src/server/adapters/novu) or the scripts/novu admin CLI; elsewhere depend on the MessageTransport port.",
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
            {
              group: ["novu", "@novu/*"],
              message:
                "Import Novu only inside the Novu adapter (src/server/adapters/novu) or the scripts/novu admin CLI; elsewhere depend on the MessageTransport port.",
            },
          ],
        },
      ],
    },
  },
  {
    // The Novu adapter is the one module allowed to import the vendor SDK.
    // Flat config replaces a rule's options when a later matching object sets
    // the same rule, so this restores the logging boundary *without* the Novu
    // patterns for the adapter (and only the adapter).
    files: ["apps/web/src/server/adapters/novu/**"],
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
    // Cron jobs write `domainEvents`; the fan-out consumer delivers. A job must
    // therefore never reach for a notification or delivery adapter directly, so
    // the `defineCronJob` contract stays free of a notification dependency
    // (contract §10.2, ADR-0028 §1). The logging boundary from the server rule
    // above is repeated here because a later matching config object replaces the
    // whole `no-restricted-imports` setting.
    files: ["apps/web/src/server/jobs/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/server/logging/**", "@/server/logging/*"],
              message: "Import only the Logger port from @/server/logging.",
            },
            {
              group: [
                "**/server/notifications/**",
                "@/server/notifications/*",
                "**/server/adapters/**",
                "@/server/adapters/*",
              ],
              message:
                "Cron jobs write domainEvents; the fan-out consumer delivers notifications, so a job must not import a notification or delivery adapter.",
            },
            {
              group: ["novu", "@novu/*"],
              message:
                "Import Novu only inside the Novu adapter (src/server/adapters/novu) or the scripts/novu admin CLI; elsewhere depend on the MessageTransport port.",
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
  {
    // False-positive exemption for the OP-94 fan-out specs only. They build a
    // partial `RecipientRepository` double and assert with
    // `expect(repository.listEventRoleMembers).toHaveBeenCalled…`, which extracts
    // the method reference without calling it and so can never lose `this`.
    // Scoped to these two files so `@typescript-eslint/unbound-method` keeps
    // guarding every other spec.
    files: [
      "apps/web/src/server/notifications/fan-out.test.ts",
      "apps/web/src/test/integration/notification-fan-out.test.ts",
    ],
    rules: {
      "@typescript-eslint/unbound-method": "off",
    },
  },
  {
    // Tenant isolation invariant (OP-77): only the repository layer
    // (`src/server/repos/**`) and the db folder (`src/server/db/**`) may call
    // `db.collection(...)`. Everywhere else must obtain a scoped handle from
    // `tenantRepo`/`platformRepo`, so a filter can never omit `tenantId`.
    //
    // Registration scope is deliberately limited to `apps/web/src/**`: that is
    // where the application's tenant-scoped query paths live, and the rule
    // exempts non-app driver use by *not* being registered there. The one-off
    // admin process `scripts/db/ensure-indexes.ts` drives `db.collection(...)`
    // legitimately for index maintenance, and `packages/contracts` is type-only
    // and never touches the driver, so neither should be bound by this rule.
    files: ["apps/web/src/**/*.ts", "apps/web/src/**/*.tsx"],
    plugins: {
      openpic: {
        rules: { "no-direct-collection-access": noDirectCollectionAccess },
      },
    },
    rules: {
      "openpic/no-direct-collection-access": "error",
    },
  },
  prettier
);
