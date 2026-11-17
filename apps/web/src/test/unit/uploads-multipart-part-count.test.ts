import { describe, expect, it } from "vitest";

import { partCountFor } from "@/server/uploads/multipart";

/**
 * Unit — the multipart part count (OP-125 U1, contract §5.1 / §5.4, ADR-0740).
 *
 * `POST …/events/{eventId}/uploads/multipart` answers `partCount` so Uppy can
 * slice one file into parts before it asks for a single signature. The count is
 * the whole upload's shape: one part too few truncates the file, one too many
 * asks for a signature for a part that will never exist.
 *
 * The rule is `ceil(size / partSizeBytes)` with the two edges the contract
 * pins:
 *
 * - a **partial** last part is still a part, so a size one byte past a part
 *   boundary needs the next number (`8 MB + 1` is two parts);
 * - an **exact** multiple adds nothing (`2 × 8 MB` is two parts, not three);
 * - an **empty** claim has nothing to upload (`0` parts), so a zero-byte file
 *   never mints a signed part URL;
 * - the part size is an **input**, never a constant baked into the helper, so
 *   the value `GET /uploads/config` publishes (§5.1.1) is the value the count
 *   is computed with.
 *
 * Contract the implementation owes:
 *
 * ```ts
 * // @/server/uploads/multipart
 * export function partCountFor(input: {
 *   readonly size: number;
 *   readonly partSizeBytes: number;
 * }): number;
 * ```
 */

/** The contract's fixed part size for the originals bucket (§5.1). */
const PART_SIZE_BYTES = 8_388_608;

/** One `[label, size, partSizeBytes, expected]` case of the rule. */
type PartCountCase = readonly [string, number, number, number];

const PART_COUNT_CASES: readonly PartCountCase[] = [
  // The contract's own worked example (§5.4): a 40 MB file at 8 MB per part.
  ["the contract's 40 MB example is five 8 MB parts", 41_943_040, PART_SIZE_BYTES, 5],
  ["one byte is one part", 1, PART_SIZE_BYTES, 1],
  ["exactly one part size is one part", 8_388_608, PART_SIZE_BYTES, 1],
  ["one byte past one part size is two parts", 8_388_609, PART_SIZE_BYTES, 2],
  ["exactly two part sizes is two parts", 16_777_216, PART_SIZE_BYTES, 2],
  ["one byte past two part sizes is three parts", 16_777_217, PART_SIZE_BYTES, 3],
  ["the 100 MB ceiling is thirteen parts", 104_857_600, PART_SIZE_BYTES, 13],
  ["a 4 MB part size quarters a 4 MB file", 4_194_304, 1_048_576, 4],
  ["a 4 MB part size needs a fifth part for one extra byte", 4_194_305, 1_048_576, 5],
];

describe("partCountFor (U1, contract §5.1/§5.4)", () => {
  it.each(PART_COUNT_CASES)("%s", (_label, size, partSizeBytes, expected) => {
    expect(partCountFor({ size, partSizeBytes })).toBe(expected);
  });

  it("never asks for a part when the claim is empty", () => {
    // A zero-byte claim slices into nothing: the create response must not tell
    // Uppy to sign part 1 of an empty file.
    expect(partCountFor({ size: 0, partSizeBytes: PART_SIZE_BYTES })).toBe(0);
  });

  it("rounds a partial trailing part up rather than truncating the upload", () => {
    // The last part is what a client actually uploads, so dropping it would
    // silently lose the tail of every file whose size is not a multiple.
    expect(partCountFor({ size: 8_388_607, partSizeBytes: PART_SIZE_BYTES })).toBe(1);
    expect(partCountFor({ size: 8_388_608, partSizeBytes: PART_SIZE_BYTES })).toBe(1);
    expect(partCountFor({ size: 8_388_609, partSizeBytes: PART_SIZE_BYTES })).toBe(2);
  });
});
