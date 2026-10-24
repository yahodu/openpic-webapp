import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Mechanical guard against plan-name branching in the entitlement service
 * (OP-103 acceptance criterion 1: "There are no plan-name branches").
 *
 * **Why this exists.** `plans.entitlements` is *policy as data* (design
 * principle P2): a limit is a keyed, self-describing spec, so adding a tier or
 * a limit is a data edit with zero code change. The moment service code writes
 * `if (planKey === "enterprise") …` the limits stop being data and a new tier
 * silently gets the wrong behaviour. A plan-name branch is invisible to review
 * across a growing directory, so it is pinned mechanically here: `src/server/services/entitlements/**` must contain **no** occurrence of
 * a plan-name literal in production source.
 *
 * **Scope boundary.** Only `*.ts` files directly in the target directory are
 * scanned, and `*.test.ts` is excluded — a spec may legitimately name a tier in
 * a fixture, and the invariant is about *service* code. The literal match is
 * word-bounded, so `starter` is flagged but `restarter` is not.
 *
 * The helper lives in the test tree because it is a scanner over repository
 * files, not production code (the same idiom as
 * `apps/web/src/test/helpers/workflow-shell-safety.ts`).
 *
 * @see apps/web/src/test/unit/entitlements-plan-name-guard.test.ts
 */

/** The plan-key literals service code must never branch on (schema §14.1). */
export const PLAN_NAME_LITERALS: readonly string[] = ["starter", "professional", "enterprise"];

/** One forbidden plan-name literal found in a source file. */
export interface PlanNameViolation {
  /** The path as passed in, e.g. `apps/web/src/…/entitlements/check.ts`. */
  readonly file: string;
  /** 1-based line number of the offending line. */
  readonly line: number;
  /** The plan-name literal that matched. */
  readonly literal: string;
  /** The trimmed line text, for the failure message. */
  readonly text: string;
}

/**
 * Scan one directory of TypeScript source for plan-name literals.
 *
 * @param directory - Absolute or repo-relative directory to scan.
 * @returns Every violation found, in file-name then line order.
 * @throws If the directory does not exist (a missing service is a defect, not a
 *   vacuous pass).
 */
export function scanPlanNameLiterals(directory: string): PlanNameViolation[] {
  const violations: PlanNameViolation[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
      continue;
    }

    const file = join(directory, entry.name);
    const lines = readFileSync(file, "utf8").split("\n");

    lines.forEach((text, index) => {
      for (const literal of PLAN_NAME_LITERALS) {
        if (new RegExp(`\\b${literal}\\b`).test(text)) {
          violations.push({ file, line: index + 1, literal, text: text.trim() });
        }
      }
    });
  }

  return violations;
}
