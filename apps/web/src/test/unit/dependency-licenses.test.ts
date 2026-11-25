import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Dependency-licence guard — the **durability** half of `ADR-0991` §Decision **D3**. // adr-fixture: consumer row lands with t_8229f552
 *
 * **Why this exists.** D3 answered the owner's precondition ("make sure no
 * tool/package restricts a proprietary licence") by measuring the installed tree
 * once, and §Consequences claimed the CI `audit` check stayed the mechanical guard:
 * "a package with an incompatible license arrives as a red check, not a surprise."
 * It is not one. `pnpm audit` queries the advisory database for **vulnerabilities**
 * and never reads a package's `license` field, and no workflow greps licences
 * either — the single `licen[cs]e` hit in `.github/workflows/*.yml` is
 * `GITLEAKS_LICENSE`. So a GPL, AGPL, SSPL or BUSL dependency used to pass every
 * gate silently, and the licence was discovered (if at all) only when a
 * distribution obligation was already owed.
 *
 * **What is pinned.** The allow-list below is D3's position, expression by
 * expression: the permissive ids; the three dual expressions the measured tree
 * actually contains (`(MIT AND Zlib)` on `pako`, `(BSD-2-Clause OR MIT OR
 * Apache-2.0)` on `rc`, `(MIT OR CC0-1.0)` on `type-fest`); and the weak-copyleft /
 * attribution ids the ADR justified. `LGPL-3.0-or-later` is additionally scoped to
 * the one package D3 names, `@img/sharp-libvips-linux-x64` (reached as
 * `next → sharp`, an unmodified native binary loaded at runtime and not
 * distributed): a *second* LGPL package is a new decision, not an inherited
 * allowance, so it reddens this spec instead of arriving unnoticed.
 *
 * **Matching is by whole normalised expression**, never by splitting on `OR` /
 * `AND`: `(MIT OR GPL-3.0-only)` is refused although one arm is permissive, and a
 * new dual expression fails until a human writes it down here. That is the point —
 * the allow-list is the record, and growing it is a deliberate act.
 *
 * **Hermetic and offline.** The measurement shells out to `pnpm licenses list`
 * exactly as `adr-source-references.test.ts` shells out to `git`: the command reads
 * the already-installed tree and opens no socket. When `node_modules` is absent (a
 * bare worktree, a source tarball) the measured cases skip with a reason instead of
 * failing, because a missing tree is not a licence violation.
 *
 * **Failure output is the finding.** Violations are asserted as
 * `name@version → licence` rows, so a red run names the package to remove or the
 * ADR entry to write; the checker never returns a bare boolean.
 */

/** One `pnpm licenses list --json` entry, reduced to the fields this guard reads. */
export interface LicenceEntry {
  readonly name: string;
  /** The expression the map is keyed by, repeated per entry so a seeded probe carries its own. */
  readonly license?: string | null;
  /** `pnpm`'s shape: every version of this `name` reported under one licence key. */
  readonly versions?: readonly string[];
  /** Accepted so a hand-seeded probe can name a single version without an array. */
  readonly version?: string;
}

/** One package the tree may not ship, as the row a failure message prints. */
export interface LicenceViolation {
  /** `<name>@<version>`, or the bare name when the inventory reported no version. */
  readonly package: string;
  /** The licence expression that failed, normalised. */
  readonly licence: string;
}

/**
 * The expressions D3 permits, written out rather than derived (the record is named
 * in this file's header).
 *
 * Adding an entry is a licensing decision: it says a package under that expression
 * may ship in a proprietary application. Keep the list sorted; `pnpm` reports
 * expressions verbatim, so a dual expression must match this spelling after
 * whitespace normalisation.
 */
export const ALLOWED_LICENCES: readonly string[] = [
  "(BSD-2-Clause OR MIT OR Apache-2.0)",
  "(MIT AND Zlib)",
  "(MIT OR CC0-1.0)",
  "0BSD",
  "Apache-2.0",
  "Artistic-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "ISC",
  "LGPL-3.0-or-later",
  "MIT",
  "MPL-2.0",
  "Python-2.0",
  "Zlib",
];

/**
 * Expressions allowed for **one** package only, with the reason D3 gives.
 *
 * `LGPL-3.0-or-later` is weak copyleft: the relink/replacement obligation is not
 * triggered because the app is deployed as a service and the binary ships
 * unmodified. That reasoning is package-specific, so the allowance is too.
 */
const PACKAGE_SCOPED_ALLOWANCES: Readonly<Record<string, readonly string[]>> = {
  "LGPL-3.0-or-later": ["@img/sharp-libvips-linux-x64"],
};

/** Strong copyleft, source-available and non-commercial families D3 ruled out entirely. */
const FORBIDDEN_LICENCE_FAMILY =
  /^(?:A?GPL-|SSPL-|BUSL-|EUPL-|OSL-|CC-BY-NC|Commons-Clause|Elastic-)/;

function normalizeLicence(expression: string): string {
  return expression.replace(/\s+/g, " ").trim();
}

const ALLOWED = new Set(ALLOWED_LICENCES.map(normalizeLicence));
const SCOPED = new Map(
  Object.entries(PACKAGE_SCOPED_ALLOWANCES).map(([licence, packages]) => [
    normalizeLicence(licence),
    new Set(packages),
  ])
);

/** `name@version → licence`, the row shape every failure message prints. */
export function violationRows(
  inventory: Readonly<Record<string, readonly LicenceEntry[]>>
): string[] {
  return findLicenceViolations(inventory).map(({ package: id, licence }) => `${id} → ${licence}`);
}

/**
 * Every entry whose licence expression is outside the allow-list, in inventory order.
 *
 * The expression is read from the entry when it carries one and from the map key
 * otherwise, so a seeded probe is checked exactly like a measured package. A
 * package-scoped allowance narrows an already-allowed expression; it never widens
 * the list.
 */
export function findLicenceViolations(
  inventory: Readonly<Record<string, readonly LicenceEntry[]>>
): LicenceViolation[] {
  const violations: LicenceViolation[] = [];

  for (const [key, entries] of Object.entries(inventory)) {
    for (const entry of entries) {
      const licence = normalizeLicence(entry.license ?? key);
      const scoped = SCOPED.get(licence);
      const allowed = ALLOWED.has(licence) && (scoped === undefined || scoped.has(entry.name));
      if (allowed) continue;

      const versions = entry.versions?.length
        ? [...entry.versions]
        : entry.version
          ? [entry.version]
          : [];
      const ids =
        versions.length > 0 ? versions.map((version) => `${entry.name}@${version}`) : [entry.name];
      for (const id of ids) violations.push({ package: id, licence });
    }
  }

  return violations;
}

/** Repository root — five levels above this spec, the depth every `test/unit/` spec uses. */
const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

/**
 * pnpm's own marker that the tree was installed into this checkout.
 *
 * One `existsSync` call site, deliberately: the security preset flags every
 * non-literal `fs` argument (`security/detect-non-literal-fs-filename`), so this
 * stays the file's only such call.
 */
const installedTree = existsSync(join(repoRoot, "node_modules", ".modules.yaml"));

const MEASURED_SUITE = "the installed dependency tree, as `pnpm licenses list` reports it";
const SKIPPED_SUITE =
  "the installed dependency tree — SKIPPED: node_modules is not installed, run `pnpm install`";
const SUITE_TITLE = installedTree ? MEASURED_SUITE : SKIPPED_SUITE;

type LicenceScope = "all" | "prod";

const measured = new Map<LicenceScope, Readonly<Record<string, readonly LicenceEntry[]>>>();

/**
 * Read `pnpm licenses list --json` for one scope, once per run.
 *
 * `--prod` restricts the inventory to what ships; the unscoped form also carries
 * the dev-only build tooling, which D3 still refuses to let a copyleft package
 * hide in. The command is local: it walks the installed tree and the workspace's
 * own metadata, and needs no registry access.
 */
export function readLicenceInventory(
  scope: LicenceScope
): Readonly<Record<string, readonly LicenceEntry[]>> {
  const cached = measured.get(scope);
  if (cached) return cached;

  const args = ["licenses", "list", "--json", ...(scope === "prod" ? ["--prod"] : [])];
  let stdout: string;
  try {
    stdout = execFileSync("pnpm", args, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CI: "1", NO_UPDATE_NOTIFIER: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(
      `\`pnpm ${args.join(" ")}\` failed in ${repoRoot}, so the licence inventory cannot be ` +
        `measured: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const parsed = JSON.parse(stdout) as Readonly<Record<string, readonly LicenceEntry[]>>;
  measured.set(scope, parsed);
  return parsed;
}

describe("the D3 licence allow-list for dependencies", () => {
  it.each(ALLOWED_LICENCES)("permits %s without permitting a copyleft family", (expression) => {
    expect(expression).not.toMatch(FORBIDDEN_LICENCE_FAMILY);
  });

  it("keeps the four families D3 ruled out entirely out of the list", () => {
    // Arrange — the ids a future "just make it pass" edit would be tempted to add.
    const forbidden = ["GPL-3.0-only", "AGPL-3.0-only", "SSPL-1.0", "BUSL-1.1"];

    // Act
    const listed = ALLOWED_LICENCES.filter((expression) => forbidden.includes(expression));

    // Assert
    expect(listed).toEqual([]);
  });
});

describe("when a package carries a licence outside the allow-list", () => {
  it.each([
    "GPL-3.0-only",
    "AGPL-3.0-only",
    "SSPL-1.0",
    "BUSL-1.1",
    "EUPL-1.2",
    "OSL-3.0",
    "CC-BY-NC-4.0",
    "UNLICENSED",
    "(MIT OR GPL-3.0-only)",
    "(MIT AND GPL-3.0-only)",
  ])("reports the package, naming it, as %s", (expression) => {
    // Arrange — a synthetic entry in the shape `pnpm licenses list --json` emits.
    const inventory = { [expression]: [{ name: "probe", version: "0.0.0", license: expression }] };

    // Act
    const rows = violationRows(inventory);

    // Assert — the row, not a bare boolean, is the contract.
    expect(rows).toEqual([`probe@0.0.0 → ${expression}`]);
  });

  it("reports LGPL-3.0-or-later on a package D3 did not justify", () => {
    // Arrange — the weak-copyleft allowance is scoped to one native binary.
    const inventory = {
      "LGPL-3.0-or-later": [{ name: "another-native-addon", version: "1.0.0" }],
    };

    // Act
    const rows = violationRows(inventory);

    // Assert — the map key supplies the expression when the entry omits it.
    expect(rows).toEqual(["another-native-addon@1.0.0 → LGPL-3.0-or-later"]);
  });

  it("reports one row per version when a name ships several", () => {
    // Arrange
    const inventory = {
      "GPL-3.0-only": [{ name: "multi", versions: ["1.0.0", "2.0.0"], license: "GPL-3.0-only" }],
    };

    // Act
    const rows = violationRows(inventory);

    // Assert
    expect(rows).toEqual(["multi@1.0.0 → GPL-3.0-only", "multi@2.0.0 → GPL-3.0-only"]);
  });

  it("accepts no entry at all as clean, so a clean tree is an empty row list", () => {
    // Arrange
    const inventory = { MIT: [{ name: "left-pad", version: "1.3.0", license: "MIT" }] };

    // Act
    const rows = violationRows(inventory);

    // Assert
    expect(rows).toEqual([]);
  });
});

describe("when a package carries an allowed licence", () => {
  it.each([
    "MIT",
    "Apache-2.0",
    "ISC",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "0BSD",
    "BlueOak-1.0.0",
    "CC0-1.0",
    "Zlib",
    "MPL-2.0",
    "CC-BY-4.0",
    "CC-BY-3.0",
    "Python-2.0",
    "Artistic-2.0",
    "(MIT AND Zlib)",
    "(BSD-2-Clause OR MIT OR Apache-2.0)",
    "(MIT OR CC0-1.0)",
  ])("ships %s without a violation", (expression) => {
    // Arrange
    const inventory = {
      [expression]: [{ name: "allowed-dep", version: "1.0.0", license: expression }],
    };

    // Act
    const rows = violationRows(inventory);

    // Assert
    expect(rows).toEqual([]);
  });

  it("accepts an expression whose whitespace pnpm reflowed", () => {
    // Arrange — the same dual expression with the spacing a different pnpm may emit.
    const inventory = { "(MIT   AND  Zlib)": [{ name: "pako", version: "1.0.11" }] };

    // Act
    const rows = violationRows(inventory);

    // Assert
    expect(rows).toEqual([]);
  });

  it("accepts LGPL-3.0-or-later for the one native binary D3 names", () => {
    // Arrange
    const inventory = {
      "LGPL-3.0-or-later": [
        { name: "@img/sharp-libvips-linux-x64", version: "1.3.4", license: "LGPL-3.0-or-later" },
      ],
    };

    // Act
    const rows = violationRows(inventory);

    // Assert
    expect(rows).toEqual([]);
  });
});

describe.skipIf(!installedTree)(SUITE_TITLE, () => {
  it("ships no licence outside the allow-list in the production set", () => {
    // Arrange — the set that is actually distributed.
    const inventory = readLicenceInventory("prod");

    // Act
    const rows = violationRows(inventory);

    // Assert
    expect(rows).toEqual([]);
  });

  it("installs no licence outside the allow-list in the full tree", () => {
    // Arrange — dev-only build tooling cannot hide a copyleft package either.
    const inventory = readLicenceInventory("all");

    // Act
    const rows = violationRows(inventory);

    // Assert
    expect(rows).toEqual([]);
  });

  it("measures a non-empty inventory for both scopes, so a failed parse cannot pass vacuously", () => {
    // Arrange — floors a little under the measured 210 production / 542 full packages,
    // so a routine dependency change does not redden them while `{}` or a truncated
    // parse does.
    const production = readLicenceInventory("prod");
    const full = readLicenceInventory("all");
    const count = (inventory: Readonly<Record<string, readonly LicenceEntry[]>>) =>
      Object.values(inventory).reduce((total, entries) => total + entries.length, 0);

    // Act
    const productionCount = count(production);
    const fullCount = count(full);

    // Assert — a real inventory carries several families and far more than a handful.
    expect(productionCount).toBeGreaterThanOrEqual(200);
    expect(fullCount).toBeGreaterThanOrEqual(500);
    expect(Object.keys(production).length).toBeGreaterThanOrEqual(8);
    expect(Object.keys(full).length).toBeGreaterThanOrEqual(15);
    expect(production).toHaveProperty("MIT");
    expect(full).toHaveProperty("MIT");
  });

  it("reports a synthetic copyleft package seeded into the measured inventory", () => {
    // Arrange — the real production tree plus one entry of the kind this guard exists for.
    const seeded: Record<string, readonly LicenceEntry[]> = {
      ...readLicenceInventory("prod"),
      "GPL-3.0-only": [{ name: "probe", version: "0.0.0", license: "GPL-3.0-only" }],
    };

    // Act
    const rows = violationRows(seeded);

    // Assert — exactly the probe: the measured tree itself contributes no row.
    expect(rows).toEqual(["probe@0.0.0 → GPL-3.0-only"]);
  });
});
