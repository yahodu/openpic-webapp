import { ESLint, Linter } from "eslint";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * AC1 — the Novu SDK import boundary.
 *
 * `docs/CONVENTIONS.md` §7 / ADR-0001 keep the vendor behind the adapter port:
 * the Novu SDK may be imported **only** by the Novu adapter
 * (`apps/web/src/server/adapters/novu/**`) and the admin scripts that configure
 * Novu (`scripts/novu/**`). Everywhere else domain, service, route and job code
 * depends on the vendor-neutral `MessageTransport` port, so a provider swap is
 * one adapter file.
 *
 * `eslint.config.mjs` must therefore register a `no-restricted-imports` boundary
 * for the `@novu/*` packages and the bare `novu` package. This spec drives the
 * repository's **real** flat config: for each probed path it resolves the config
 * with `ESLint.calculateConfigForFile(path)` and then executes the resolved
 * `no-restricted-imports` rule over synthetic source. That keeps the check
 * behavioural — it runs the real rule with the per-path options the real config
 * produces — without requiring a synthetic file to exist in a TypeScript
 * project. (Under `parserOptions.projectService: true`, `lintText` on a
 * non-project path yields only a parsing error, and the type-aware rules cannot
 * run without parser services; resolving the config first and running just the
 * syntactic boundary rule sidesteps both, and no `eslint.config.mjs` source text
 * is snapshotted.)
 *
 * The spec is RED until the boundary exists — today the resolved options carry
 * no Novu pattern for any probed path, so a Novu import is not reported.
 */

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));

/**
 * Report the rule ids that flag `code` when linted as `filePath` under the
 * repository's real ESLint configuration.
 *
 * @param filePath - Repo-relative path whose resolved config governs the lint.
 * @param code - Synthetic source to lint.
 * @returns The ids of the rules that reported a problem (parsing/other
 *   rule-less messages are excluded).
 */
async function reportedRuleIds(filePath: string, code: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: repoRoot });
  const config = await eslint.calculateConfigForFile(`${repoRoot}${filePath}`);
  const boundary = config?.rules?.["no-restricted-imports"];

  const linter = new Linter({ configType: "flat" });
  const messages = linter.verify(
    code,
    [
      {
        files: ["**/*.ts"],
        languageOptions: { parser: config?.languageOptions?.parser },
        rules: boundary === undefined ? {} : { "no-restricted-imports": boundary },
      },
    ],
    `${repoRoot}${filePath}`
  );

  return messages
    .map((message) => message.ruleId)
    .filter((ruleId): ruleId is string => ruleId !== null);
}

describe("Novu SDK import boundary (AC1)", () => {
  it("reports a scoped Novu SDK import from a server service module", async () => {
    // Act
    const ruleIds = await reportedRuleIds(
      "apps/web/src/server/services/notification-sender.ts",
      'import { Novu } from "@novu/node";\n'
    );

    // Assert
    expect(ruleIds).toContain("no-restricted-imports");
  });

  it("reports the bare novu package import from a route handler", async () => {
    // Act
    const ruleIds = await reportedRuleIds(
      "apps/web/src/app/api/v1/notifications/route.ts",
      'import Novu from "novu";\n'
    );

    // Assert
    expect(ruleIds).toContain("no-restricted-imports");
  });

  it("reports a scoped Novu SDK import from a domain module", async () => {
    // Act
    const ruleIds = await reportedRuleIds(
      "apps/web/src/server/domain/notification.ts",
      'import { Workflow } from "@novu/api";\n'
    );

    // Assert
    expect(ruleIds).toContain("no-restricted-imports");
  });

  it("does not report a Novu SDK import inside the Novu adapter", async () => {
    // Act
    const ruleIds = await reportedRuleIds(
      "apps/web/src/server/adapters/novu/novu-transport.ts",
      'import { Novu } from "@novu/node";\n'
    );

    // Assert
    expect(ruleIds).not.toContain("no-restricted-imports");
  });

  it("does not report a Novu SDK import inside the scripts/novu admin CLI", async () => {
    // Act
    const ruleIds = await reportedRuleIds(
      "scripts/novu/upsert-workflows.ts",
      'import { Novu } from "@novu/node";\n'
    );

    // Assert
    expect(ruleIds).not.toContain("no-restricted-imports");
  });
});
