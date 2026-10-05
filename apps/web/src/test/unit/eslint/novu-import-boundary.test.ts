import { ESLint, type Linter } from "eslint";
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
 * real flat config through the ESLint API on synthetic sources, so it fails
 * when the boundary is missing and passes when it is present — without a
 * snapshot of the config file's text.
 */

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));

/** Lint a synthetic source file against the repository's real flat config. */
async function lintSynthetic(filePath: string, code: string): Promise<Linter.LintMessage[]> {
  const eslint = new ESLint({ cwd: repoRoot });
  const results = await eslint.lintText(code, { filePath: `${repoRoot}${filePath}` });
  return results[0]?.messages ?? [];
}

/** The ids of the rules that flagged the synthetic source. */
function reportedRuleIds(messages: readonly Linter.LintMessage[]): string[] {
  return messages
    .map((message) => message.ruleId)
    .filter((ruleId): ruleId is string => ruleId !== null);
}

describe("Novu SDK import boundary (AC1)", () => {
  it("reports a scoped Novu SDK import from a server service module", async () => {
    // Act
    const messages = await lintSynthetic(
      "apps/web/src/server/services/notification-sender.ts",
      'import { Novu } from "@novu/node";\n'
    );

    // Assert
    expect(reportedRuleIds(messages)).toContain("no-restricted-imports");
  });

  it("reports the bare novu package import from a route handler", async () => {
    // Act
    const messages = await lintSynthetic(
      "apps/web/src/app/api/v1/notifications/route.ts",
      'import Novu from "novu";\n'
    );

    // Assert
    expect(reportedRuleIds(messages)).toContain("no-restricted-imports");
  });

  it("reports a scoped Novu SDK import from a domain module", async () => {
    // Act
    const messages = await lintSynthetic(
      "apps/web/src/server/domain/notification.ts",
      'import { Workflow } from "@novu/api";\n'
    );

    // Assert
    expect(reportedRuleIds(messages)).toContain("no-restricted-imports");
  });

  it("does not report a Novu SDK import inside the Novu adapter", async () => {
    // Act
    const messages = await lintSynthetic(
      "apps/web/src/server/adapters/novu/novu-transport.ts",
      'import { Novu } from "@novu/node";\n'
    );

    // Assert
    expect(reportedRuleIds(messages)).not.toContain("no-restricted-imports");
  });

  it("does not report a Novu SDK import inside the scripts/novu admin CLI", async () => {
    // Act
    const messages = await lintSynthetic(
      "scripts/novu/upsert-workflows.ts",
      'import { Novu } from "@novu/node";\n'
    );

    // Assert
    expect(reportedRuleIds(messages)).not.toContain("no-restricted-imports");
  });
});
