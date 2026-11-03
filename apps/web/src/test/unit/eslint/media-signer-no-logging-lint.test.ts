import { ESLint, Linter } from "eslint";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * OP-113 round-1 follow-up (ADR-0584) — the lint half of the "signed URLs are
 * never logged" pin.
 *
 * `test/unit/media-signer-never-logs.test.ts` proves behaviourally that the
 * signer emits nothing. This spec proves the repository's **real** ESLint
 * config also reddens before that behaviour can regress: a `console.*` call in
 * the signer module is a `no-console` error, and an import of the logging
 * **internals** (`@/server/logging/*`) is a `no-restricted-imports` error on
 * that path. Both are driven through the config resolved for
 * `apps/web/src/server/media/signer.ts`, exactly as
 * `test/unit/eslint/novu-import-boundary.test.ts` does — resolving the config
 * first sidesteps `parserOptions.projectService` (a synthetic path yields only
 * a parsing error under `lintText`) while `no-console` /
 * `no-restricted-imports` are core, non-type-aware rules whose per-path options
 * are precisely what `eslint.config.mjs` produces.
 *
 * ## Honest boundary (recorded in ADR-0584)
 *
 * The resolved config deliberately **permits** the `@/server/logging` barrel
 * (the `Logger` port — that is the point of the "Import only the Logger port
 * from `@/server/logging`" message), so the "no logger at all" property for the
 * signer rests on the behavioural spec, not on lint. A future **route** lane
 * that calls `sign` is visible to neither pin: ADR-0584 records what it must
 * do (never pass a signed URL to `requestLogger`; log counts at debug only).
 */

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));

/** The signer module the no-logging boundary is scoped to. */
const SIGNER_MODULE = "apps/web/src/server/media/signer.ts";

/**
 * Report the rule ids that flag `code` when linted as `filePath` under the
 * repository's real configuration, limited to the two no-logging rules.
 *
 * @param filePath - Repo-relative path whose resolved config governs the lint.
 * @param code - Synthetic source to lint.
 * @returns The ids of the rules that reported a problem (rule-less parsing
 *   messages are excluded).
 */
async function reportedRuleIds(filePath: string, code: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: repoRoot });
  const config = await eslint.calculateConfigForFile(`${repoRoot}${filePath}`);

  const restrictedImports = config?.rules?.["no-restricted-imports"];
  const noConsole = config?.rules?.["no-console"];

  const linter = new Linter({ configType: "flat" });
  const messages = linter.verify(
    code,
    [
      {
        files: ["**/*.ts"],
        languageOptions: { parser: config?.languageOptions?.parser },
        rules: {
          ...(restrictedImports === undefined
            ? {}
            : { "no-restricted-imports": restrictedImports }),
          ...(noConsole === undefined ? {} : { "no-console": noConsole }),
        },
      },
    ],
    `${repoRoot}${filePath}`
  );

  return messages
    .map((message) => message.ruleId)
    .filter((ruleId): ruleId is string => ruleId !== null);
}

describe("the media signer's no-logging lint boundary (OP-113 follow-up, ADR-0584)", () => {
  it("flags a console.* call in the signer module as a no-console error", async () => {
    // Act — the exact leak shape the behavioural pin exists for.
    const ruleIds = await reportedRuleIds(SIGNER_MODULE, "console.log(url);\n");

    // Assert — the repo's own config makes a console sink in the signer a lint
    // error, so CI reddens before the behaviour pin even runs.
    expect(ruleIds).toContain("no-console");
  });

  it("flags an import of logging internals in the signer module as a no-restricted-imports error", async () => {
    // Act — the internals import the server-wide boundary forbids.
    const ruleIds = await reportedRuleIds(
      SIGNER_MODULE,
      'import { createLogger } from "@/server/logging/create-logger";\n'
    );

    // Assert — `@/server/logging/*` is restricted at the signer's path.
    expect(ruleIds).toContain("no-restricted-imports");
  });
});
