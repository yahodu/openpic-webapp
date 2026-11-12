import { describe, expect, it } from "vitest";

import { DELETED_COUNTS_HEADER, formatDeletedCounts } from "@/server/attendee/deleted-counts";

/**
 * Unit contract — the withdrawal `X-Deleted-Counts` header
 * (OP-131 U2, contract §6.2, ADR-0789).
 *
 * **Why this exists.** `DELETE /p/events/{slug}/consent` answers `204`, so the
 * only place the client can learn *what* was destroyed is the response header:
 * §6.2 fixes it as `X-Deleted-Counts: selfies=1;embeddings=1;matches=1904`.
 * That string is the attendee-facing confirmation copy ("we deleted your
 * selfie, its face vector and 1904 matched photos"), and it is the same shape
 * the DSR `executionLog` records, so its format is a contract rather than a
 * formatting convenience: a client that splits on `;` and `=` must be able to
 * parse it, a space or a reordered field silently breaks that client, and the
 * counts must never render as `undefined`/`NaN` for a zero.
 *
 * ## Contract expected of the implementation
 *
 * `@/server/attendee/deleted-counts` must export:
 *
 * ```ts
 * DELETED_COUNTS_HEADER: "x-deleted-counts"   // the header name, lowercase
 * interface DeletedCounts {
 *   selfies: number;     // selfie rows removed
 *   embeddings: number;  // selfie rows that carried a face vector
 *   matches: number;     // faceMatches rows removed
 * }
 * function formatDeletedCounts(counts: DeletedCounts): string
 * ```
 *
 * The output is exactly `selfies=<n>;embeddings=<n>;matches=<n>`: that field
 * order, `;` between the pairs, no spaces, and plain base-10 integers (so a
 * zero is `selfies=0`, never an empty segment).
 */

/** The header name contract §6.2 fixes, in the casing a header map stores. */
const EXPECTED_HEADER = "x-deleted-counts";

describe("formatDeletedCounts — the §6.2 header format", () => {
  it("U2: formats the contract's own example as selfies=1;embeddings=1;matches=3", () => {
    expect(formatDeletedCounts({ selfies: 1, embeddings: 1, matches: 3 })).toBe(
      "selfies=1;embeddings=1;matches=3"
    );
  });

  it("U2: keeps the selfies, embeddings, matches order with one field per semicolon segment", () => {
    const pairs = formatDeletedCounts({ selfies: 1, embeddings: 1, matches: 1904 }).split(";");

    expect(pairs).toEqual(["selfies=1", "embeddings=1", "matches=1904"]);
  });

  it("U2: writes a zero count as 0 rather than an empty segment", () => {
    expect(formatDeletedCounts({ selfies: 0, embeddings: 0, matches: 0 })).toBe(
      "selfies=0;embeddings=0;matches=0"
    );
  });

  it("U2: writes a large match count as a plain base-10 integer", () => {
    expect(formatDeletedCounts({ selfies: 1, embeddings: 1, matches: 1904 })).toBe(
      "selfies=1;embeddings=1;matches=1904"
    );
  });

  it("U2: emits no whitespace, so a client can split on ; and = alone", () => {
    const formatted = formatDeletedCounts({ selfies: 2, embeddings: 1, matches: 7 });

    expect(formatted).not.toMatch(/\s/);
  });

  it("U2: round-trips through a split on ; and = back to the counts it was given", () => {
    const counts = { selfies: 3, embeddings: 2, matches: 1904 };

    const parsed = Object.fromEntries(
      formatDeletedCounts(counts)
        .split(";")
        .map((pair: string) => {
          const [key, value] = pair.split("=");
          return [key ?? "", Number(value)];
        })
    );

    expect(parsed).toEqual(counts);
  });

  it("U2: names the response header x-deleted-counts", () => {
    expect(DELETED_COUNTS_HEADER).toBe(EXPECTED_HEADER);
  });
});
