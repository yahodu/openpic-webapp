import { describe, expect, it } from "vitest";

import { sizeWithinTolerance } from "@/server/uploads/size-tolerance";

/**
 * Unit — the completion path's stored-size tolerance (OP-124 U1, contract
 * §5.3, ADR-0720).
 *
 * `POST …/uploads/{uploadSessionId}/complete` carries the client's `bytes` and
 * the server `HeadObject`s the object it presigned. The two numbers are allowed
 * to disagree by **at most 1 %** — a client that miscounts a trailing byte is
 * not a corrupt upload — and a disagreement above that is `409 size_mismatch`.
 *
 * The helper is what makes the rule exact instead of float-shaped:
 *
 * - the base of the percentage is the **declared** (`bytes`) value, so
 *   `Math.abs(stored - declared) / declared <= 0.01` is the contract and
 *   `101 / 10 101` (a size that "agrees" only when the base is the stored
 *   number) must still be refused;
 * - the boundary is **inclusive**: exactly 1 % of slack passes;
 * - the comparison is integer arithmetic (`diff * 100 <= declared`), so an
 *   exact 1 % never fails on a floating-point rounding of `0.01`.
 *
 * Contract the implementation owes:
 *
 * ```ts
 * // @/server/uploads/size-tolerance
 * export function sizeWithinTolerance(input: {
 *   readonly declaredBytes: number;
 *   readonly storedBytes: number;
 * }): boolean;
 * ```
 */

/** One `[label, declaredBytes, storedBytes, expected]` case of the rule. */
type ToleranceCase = readonly [string, number, number, boolean];

/** The 1 % boundary, both directions, at two magnitudes. */
const BOUNDARY_CASES: readonly ToleranceCase[] = [
  ["an exact match is inside the tolerance", 2_140_000, 2_140_000, true],
  ["exactly 1 % larger is inside the tolerance", 10_000, 10_100, true],
  ["exactly 1 % smaller is inside the tolerance", 10_000, 9_900, true],
  ["one byte past 1 % larger is a mismatch", 10_000, 10_101, false],
  ["one byte past 1 % smaller is a mismatch", 10_000, 9_899, false],
  ["the largest single-PUT file at exactly 1 % larger is inside", 104_857_600, 105_906_176, true],
  ["the largest single-PUT file one byte past 1 % is a mismatch", 104_857_600, 105_906_177, false],
  ["a declared size of 100 admits exactly one extra byte", 100, 101, true],
  ["a declared size of 100 refuses two extra bytes", 100, 102, false],
];

/** Degenerate inputs must not divide by zero or admit a phantom object. */
const DEGENERATE_CASES: readonly ToleranceCase[] = [
  ["no declared bytes and no stored bytes agree", 0, 0, true],
  ["no declared bytes and one stored byte is a mismatch", 0, 1, false],
];

describe("sizeWithinTolerance (U1, contract §5.3)", () => {
  it.each(BOUNDARY_CASES)("%s", (_label, declaredBytes, storedBytes, expected) => {
    expect(sizeWithinTolerance({ declaredBytes, storedBytes })).toBe(expected);
  });

  it.each(DEGENERATE_CASES)("%s", (_label, declaredBytes, storedBytes, expected) => {
    expect(sizeWithinTolerance({ declaredBytes, storedBytes })).toBe(expected);
  });

  it("measures the percentage against the declared bytes, never the stored bytes", () => {
    // 101 bytes over 10 000 is 1.01 % of the declaration (refused) but
    // 0.9999 % of what storage holds (admitted). Only one of those readings is
    // the contract: the client's `bytes` is the number the 1 % applies to.
    expect(sizeWithinTolerance({ declaredBytes: 10_000, storedBytes: 10_101 })).toBe(false);
    expect(sizeWithinTolerance({ declaredBytes: 9_899, storedBytes: 10_000 })).toBe(false);
  });
});
