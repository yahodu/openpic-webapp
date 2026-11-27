import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { documentedNamesOf, tableRowsOf } from "../../test/helpers/configuration-documentation";

/**
 * Section 7 of OP-70: `.env.example` is the operator-facing documentation of
 * the configuration contract, so every key `rawSchema` reads must be present
 * there, and every template key must carry a **table row** in
 * `docs/Configuration.md`.
 *
 * Both sides are derived from the real tree, never from a hand-maintained
 * literal: the key list comes from `apps/web/src/server/config/env.ts`, the
 * documented names come from the markdown of `docs/Configuration.md`, so a key
 * added to the schema, a row deleted from the doc or a typo in either file
 * fails here (finding F2 of the review of PR #985).
 *
 * Two scopes are pinned deliberately (findings F2-a and F2-b of the review of
 * PR #987): direction 1 reads the doc's **table rows** — a prose mention is not
 * documentation of an operator setting — and the token pattern accepts
 * one-character names, so a short documented name cannot hide from direction 2.
 * The two parsers those scopes share live in
 * `apps/web/src/test/helpers/configuration-documentation.ts`.
 *
 * Records: ADR-0992 (`docs/adr/ADR-0992-op101-config-template-doc-pins.md`),
 * ADR-0995 (`docs/adr/ADR-0995-op101-config-row-scope-and-short-name-pins.md`).
 */
const PROCESS_MANAGED_NAMES: readonly string[] = [
  "MONGO_TEST_URI",
  "E2E_PORT",
  "PRODUCTION_PORT",
  "HOSTNAME",
];

/**
 * Names the CI runner sets rather than the app or the operator: `CI` turns on
 * Playwright retries and the GitHub reporter, so the doc keeps its row while it
 * belongs in neither `.env.example` nor `rawSchema`.
 */
const RUNNER_MANAGED_NAMES: readonly string[] = ["CI"];

/**
 * Read one repository file as UTF-8 text.
 *
 * The path is resolved relative to this spec, so the suite asserts against the
 * real tree (`adr-numbering.test.ts` is the precedent) instead of a fixture.
 *
 * @param relativePath - Path from this spec's directory to the file to read.
 * @returns The file's contents.
 */
function readRepositoryFile(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

/**
 * Extract the keys of the `rawSchema` zod object from `env.ts`.
 *
 * The block is sliced from its `z.object({` opener to the first `});` line and
 * every `KEY:` entry is matched, so a new schema key is pinned without editing
 * this spec. A missing block, a missing closing line or an empty block throws:
 * a silent empty list would make every derived case below vacuous.
 *
 * @param envSource - Contents of `apps/web/src/server/config/env.ts`.
 * @returns The schema's key names, in declaration order.
 */
function schemaKeysOf(envSource: string): string[] {
  const opener = "const rawSchema = z.object({";
  const start = envSource.indexOf(opener);
  if (start === -1) {
    throw new Error(`env.ts no longer declares \`${opener}\``);
  }

  const end = envSource.indexOf("\n});", start);
  if (end === -1) {
    throw new Error("env.ts's rawSchema block has no closing `});` line");
  }

  const block = envSource.slice(start + opener.length, end);
  const keys = [...block.matchAll(/^\s+([A-Z][A-Z0-9_]+):/gm)].map(([, key = ""]) => key);
  if (keys.length === 0) {
    throw new Error("env.ts's rawSchema block declares no `KEY:` entries");
  }

  return keys;
}

/**
 * Extract the active `KEY=` assignments of `.env.example`.
 *
 * Only uncommented line-leading assignments count: a key parked behind `#` is
 * not part of the template an operator copies.
 *
 * @param template - Contents of `.env.example`.
 * @returns The template's key names, in file order.
 */
function templateKeysOf(template: string): string[] {
  const keys = [...template.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map(([, key = ""]) => key);
  if (keys.length === 0) {
    throw new Error(".env.example declares no `KEY=` line");
  }

  return keys;
}

const ENV_SOURCE = readRepositoryFile("./env.ts");
const TEMPLATE = readRepositoryFile("../../../../../.env.example");
const CONFIGURATION_DOCUMENTATION = readRepositoryFile("../../../../../docs/Configuration.md");

const SCHEMA_KEYS = schemaKeysOf(ENV_SOURCE);
const TEMPLATE_KEYS = templateKeysOf(TEMPLATE);
const CONFIGURATION_TABLE_ROWS = tableRowsOf(CONFIGURATION_DOCUMENTATION);
const DOCUMENTED_NAMES = documentedNamesOf(CONFIGURATION_DOCUMENTATION);
const ROW_DOCUMENTED_NAMES = documentedNamesOf(CONFIGURATION_TABLE_ROWS.join("\n"));

describe(".env.example against the configuration schema", () => {
  it.each(SCHEMA_KEYS)("documents the %s key that rawSchema declares", (key) => {
    expect(TEMPLATE_KEYS).toContain(key);
  });

  it("derives the schema keys from env.ts rather than a literal", () => {
    expect(SCHEMA_KEYS).toEqual(
      expect.arrayContaining(["APP_ENV", "APP_BASE_URL", "ALLOWED_ORIGINS", "MONGODB_URI"])
    );
  });
});

describe("docs/Configuration.md against .env.example", () => {
  it("mentions every key that .env.example declares", () => {
    const undocumented = TEMPLATE_KEYS.filter((key) => !DOCUMENTED_NAMES.includes(key));

    expect(undocumented).toEqual([]);
  });

  it.each(TEMPLATE_KEYS)("documents the %s key in a Configuration.md table row", (key) => {
    expect(ROW_DOCUMENTED_NAMES).toContain(key);
  });

  it("documents no name outside .env.example except the four process-managed names and CI", () => {
    const unaccounted = DOCUMENTED_NAMES.filter(
      (name) =>
        !TEMPLATE_KEYS.includes(name) &&
        !PROCESS_MANAGED_NAMES.includes(name) &&
        !RUNNER_MANAGED_NAMES.includes(name)
    );

    expect(unaccounted).toEqual([]);
  });

  it("keeps the four process-managed names documented", () => {
    expect(DOCUMENTED_NAMES).toEqual(expect.arrayContaining([...PROCESS_MANAGED_NAMES]));
  });

  it("keeps the two-character CI runner name documented", () => {
    expect(DOCUMENTED_NAMES).toContain("CI");
  });
});

describe("the configuration documentation parsers", () => {
  it.each(["Q", "ZZ", "CI"])("reads the %s name out of a table row", (name) => {
    expect(documentedNamesOf(`| \`${name}\` | probe | all | - | - |`)).toEqual([name]);
  });

  it("reads a row whose first non-space character is a pipe and no other line", () => {
    expect(tableRowsOf("  | `A_B` | indented row |\nprose | not a row\n")).toEqual([
      "  | `A_B` | indented row |",
    ]);
  });

  it("throws when the document carries no table row", () => {
    expect(() => tableRowsOf("# Configuration\n\nNo table here.\n")).toThrow(
      /no markdown table row/
    );
  });

  it("throws when the table rows name no backticked variable", () => {
    expect(() =>
      documentedNamesOf("| Variable | Notes |\n| --- | --- |\n| plain | no code span |\n")
    ).toThrow(/no backticked UPPER_SNAKE variable/);
  });
});
