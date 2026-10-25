import { fileURLToPath } from "node:url";

import { ESLint, Linter, RuleTester, type Rule } from "eslint";
import { builtinRules } from "eslint/use-at-your-own-risk";
import { describe, expect, it } from "vitest";

/**
 * Unit contract — the C6 content-import boundary on the dunning module (OP-111
 * U3, contract §10.2.1; ADR-0500).
 *
 * Invariant C6 is the single most important rule of the billing lane: *"the
 * dunning worker module may import **only** the `subscriptions` repository"*, so
 * no dunning bug can reach user content. §10.2.1 makes it structural rather than
 * a review habit — an ESLint `no-restricted-imports` boundary on the dunning
 * module forbidding the `events`, `eventImages`, `mediaAssets`, `imageFaces`,
 * `faceMatches` and `selfies` repositories.
 *
 * This spec therefore drives the repository's **real** flat config: for the
 * dunning module's path it resolves the config with
 * `ESLint.calculateConfigForFile(path)` and feeds the *resolved*
 * `no-restricted-imports` options into a `RuleTester` run of the core rule. The
 * assertions are behavioural — a forbidden import is reported, a permitted one
 * is not — and no `eslint.config.mjs` source text is snapshotted. Resolving the
 * config first is deliberate (the `novu-import-boundary.test.ts` / ADR-0074
 * §AC1 precedent): the config sets `parserOptions.projectService`, so linting a
 * synthetic path through `lintText` yields only a parsing error, while
 * `no-restricted-imports` is a core, non-type-aware rule whose per-path options
 * are exactly what `eslint.config.mjs` produces.
 *
 * ## The boundary this spec pins
 *
 * The GREEN declares, in `eslint.config.mjs`, a config object scoped to the
 * dunning module — placed **after** the `apps/web/src/server/**` object, which
 * also sets `no-restricted-imports` and would otherwise replace these patterns
 * (flat config *replaces* a rule's options; ADR-0074 §"Implementation
 * caveat") — carrying a pattern group that forbids the six content repository
 * namespaces. Because the billing lane may reach only its own collections, the
 * dunning module's specifier form of each namespace is what the group must name:
 * the bare `@/server/repos/<namespace>` alias, plus the same alias with a
 * trailing segment so a nested module in the namespace cannot slip through.
 *
 * ## RED today
 *
 * The dunning module and the boundary both do not exist yet, so the resolved
 * options for `apps/web/src/server/billing/jobs/dunning.ts` carry only the
 * logging/Novu patterns, every forbidden-import case reports **nothing**, and
 * the run fails `Should have 1 error but had 0`. The companion cases below fail
 * with `expected [] to have a length greater than 0` — i.e. because the boundary
 * is absent, not because of a parsing error.
 *
 * ## Assumptions recorded in the handoff (ADR-0500)
 *
 * - The six content collections have **no** repository module on the trunk
 *   (`@/server/repos` is the generic, tenant-stamping layer), so the group is a
 *   *preventive* boundary over the canonical `@/server/repos/<collection>`
 *   specifier the events / face-matching lanes will introduce. §10.2.1's own
 *   list names collections (`imageFaces`, `selfies`) that do not exist yet, so a
 *   forward-looking path boundary is the only enforceable reading.
 * - The permitted cases are the *subscriptions* repository and the repos barrel:
 *   a boundary written as a blanket `@/server/repos/**` ban would also block the
 *   one repository the dunning module is allowed to import, so precision is part
 *   of the contract.
 * - A CommonJS `require` and a dynamically interpolated `import()` are out of
 *   scope: `no-restricted-imports` is an ESM import/export rule over literal
 *   specifiers, and the sibling `no-direct-collection-access` rule already bans
 *   reaching the driver directly.
 */

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));

/** The dunning module the boundary is scoped to. */
const DUNNING_MODULE = "apps/web/src/server/billing/jobs/dunning.ts";

/**
 * The resolved `no-restricted-imports` options governing `filePath`.
 *
 * @param filePath - Repo-relative path whose resolved config is read.
 * @returns The rule's options (`[]` when the config declares none), exactly as
 *   `eslint.config.mjs` resolves them for that path.
 */
async function resolvedBoundaryOptions(filePath: string): Promise<readonly unknown[]> {
  const eslint = new ESLint({ cwd: repoRoot });
  const config = await eslint.calculateConfigForFile(`${repoRoot}${filePath}`);
  const entry = config?.rules?.["no-restricted-imports"];
  const [, ...options] = Array.isArray(entry) ? entry : [];
  return options;
}

const BOUNDARY_OPTIONS = await resolvedBoundaryOptions(DUNNING_MODULE);

/**
 * The rule ids that flag `code` when linted as `filePath` under the repository's
 * real configuration.
 *
 * @param filePath - Repo-relative path whose resolved config governs the lint.
 * @param code - Synthetic source to lint.
 * @returns The ids of the rules that reported a problem.
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

/** The core rule, resolved by name so no rule implementation is re-declared. */
const restrictedImportsRule: Rule.RuleModule = (() => {
  // `builtinRules` (the `eslint/use-at-your-own-risk` entrypoint, deprecated for
  // consumers) is the only supported way to hand a core rule to a flat-config
  // `RuleTester`, which needs a rule *module*: the rule it returns is the very
  // rule the shipped config configures, which is what this spec must run.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const rule = builtinRules.get("no-restricted-imports");
  if (rule === undefined) {
    throw new Error("eslint does not export the core no-restricted-imports rule");
  }
  return rule;
})();

const CONTENT_IMPORT = 'import { repository } from "@/server/repos/events";';

describe("the dunning module's C6 content-import boundary (U3)", () => {
  it("the dunning module's resolved config reports a content repository import", async () => {
    // Act
    const ruleIds = await reportedRuleIds(DUNNING_MODULE, CONTENT_IMPORT);

    // Assert — the boundary's absence is the diagnosis: with no config object
    // scoped to the dunning module the resolved options carry only the
    // logging/Novu patterns and nothing is reported.
    expect(ruleIds).toContain("no-restricted-imports");
  });
});

ruleTester.run("no-restricted-imports (dunning C6 boundary)", restrictedImportsRule, {
  valid: [
    {
      name: "the dunning module may import the subscription repository",
      code: 'import { subscriptionsRepository } from "@/server/repos/subscriptions";',
      filename: `${repoRoot}${DUNNING_MODULE}`,
      options: BOUNDARY_OPTIONS,
    },
    {
      name: "the dunning module may import the repository barrel",
      code: 'import { tenantRepo, platformRepo } from "@/server/repos";',
      filename: `${repoRoot}${DUNNING_MODULE}`,
      options: BOUNDARY_OPTIONS,
    },
    {
      name: "the dunning module may emit domain events",
      code: 'import { emitDomainEvent } from "@/server/domain/domain-events";',
      filename: `${repoRoot}${DUNNING_MODULE}`,
      options: BOUNDARY_OPTIONS,
    },
  ],
  invalid: [
    {
      name: "the dunning module must not import the events repository",
      code: 'import { repository } from "@/server/repos/events";',
      filename: `${repoRoot}${DUNNING_MODULE}`,
      options: BOUNDARY_OPTIONS,
      errors: [{ message: /restricted from being used/ }],
    },
    {
      name: "the dunning module must not import the eventImages repository",
      code: 'import { repository } from "@/server/repos/eventImages";',
      filename: `${repoRoot}${DUNNING_MODULE}`,
      options: BOUNDARY_OPTIONS,
      errors: [{ message: /restricted from being used/ }],
    },
    {
      name: "the dunning module must not import the mediaAssets repository",
      code: 'import { repository } from "@/server/repos/mediaAssets";',
      filename: `${repoRoot}${DUNNING_MODULE}`,
      options: BOUNDARY_OPTIONS,
      errors: [{ message: /restricted from being used/ }],
    },
    {
      name: "the dunning module must not import the imageFaces repository",
      code: 'import { repository } from "@/server/repos/imageFaces";',
      filename: `${repoRoot}${DUNNING_MODULE}`,
      options: BOUNDARY_OPTIONS,
      errors: [{ message: /restricted from being used/ }],
    },
    {
      name: "the dunning module must not import the faceMatches repository",
      code: 'import { repository } from "@/server/repos/faceMatches";',
      filename: `${repoRoot}${DUNNING_MODULE}`,
      options: BOUNDARY_OPTIONS,
      errors: [{ message: /restricted from being used/ }],
    },
    {
      name: "the dunning module must not import the selfies repository",
      code: 'import { repository } from "@/server/repos/selfies";',
      filename: `${repoRoot}${DUNNING_MODULE}`,
      options: BOUNDARY_OPTIONS,
      errors: [{ message: /restricted from being used/ }],
    },
  ],
});
