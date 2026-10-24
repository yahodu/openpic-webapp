import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { PLAN_NAME_LITERALS, scanPlanNameLiterals } from "../helpers/plan-name-scan.js";

/**
 * Unit contract — the plan-name-branch guard (OP-103 acceptance criterion 1,
 * "There are no plan-name branches").
 *
 * `plans.entitlements` is *policy as data*: the entitlement service resolves a
 * limit from the stored, self-describing spec, so a new tier or a new limit is
 * a data edit with zero code change. A plan-name branch (`if (planKey ===
 * "enterprise")`) silently breaks that — the limits stop being data and a new
 * tier gets the wrong behaviour with no test failing. This spec pins the
 * absence of the literals mechanically, at the one directory the card names.
 *
 * The guard is pinned twice: once on a synthetic fixture (so it is a scanner,
 * not a snapshot of today's files) and once on the real service directory (so
 * the invariant is asserted against the code that actually ships). The real
 * directory does not exist on the baseline, so this file is red on import —
 * the intended first state.
 *
 * @see docs/adr/ADR-0340-op103-entitlements-red.md
 */

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

/** The service directory whose production source must stay branch-free. */
const ENTITLEMENTS_DIR = join(repoRoot, "apps/web/src/server/services/entitlements");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("scanPlanNameLiterals — synthetic fixtures", () => {
  it("flags a plan-name literal in a production source file", () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-name-scan-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "check.ts"), 'if (planKey === "enterprise") {\n  return true;\n}\n');

    const violations = scanPlanNameLiterals(dir);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ literal: "enterprise", line: 1 });
  });

  it("ignores a plan name that is only a substring of another identifier", () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-name-scan-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "check.ts"), "const restarter = 1;\n");

    expect(scanPlanNameLiterals(dir)).toEqual([]);
  });

  it("does not scan test files", () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-name-scan-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "check.test.ts"), 'const planKey = "starter";\n');

    expect(scanPlanNameLiterals(dir)).toEqual([]);
  });
});

describe("the entitlements service has no plan-name branches", () => {
  it("U7: the entitlements service directory exists", () => {
    expect(existsSync(ENTITLEMENTS_DIR), `${ENTITLEMENTS_DIR} must exist`).toBe(true);
  });

  it("U7: no plan-name literal appears in src/server/services/entitlements", () => {
    const violations = scanPlanNameLiterals(ENTITLEMENTS_DIR);

    expect(violations).toEqual([]);
  });

  it("U7: the scanned literal set is exactly the three plan keys", () => {
    expect([...PLAN_NAME_LITERALS].sort()).toEqual(["enterprise", "professional", "starter"]);
  });
});
