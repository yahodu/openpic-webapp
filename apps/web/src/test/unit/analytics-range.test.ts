import { describe, expect, it } from "vitest";

import { MAX_ANALYTICS_RANGE_DAYS, validateAnalyticsRange } from "@/server/analytics/date-range";
import { AppError } from "@/server/http/app-error";

/**
 * Unit — the tenant analytics date-range validator (OP-119 U1, contract §4.5,
 * schema §20.1).
 *
 * The analytics endpoint answers `GET /tenants/{t}/analytics?from&to` and the
 * contract's only range rule is "Max 366-day range (`422 range_too_large`)"
 * (Appendix A.2: `range_too_large` is `422` with details `{ maxDays }`;
 * `invalid_date_range` is `422` with details `{ startAt, endAt }`). The card
 * pins the reading: the bound is on an **inclusive** day count, so a range
 * whose first and last day are the same is one day, and a leap year's 366
 * calendar days are the largest range that is accepted.
 *
 * ## Contract expected of the implementation
 *
 * ```
 * @/server/analytics/date-range
 *   MAX_ANALYTICS_RANGE_DAYS: 366
 *   validateAnalyticsRange(from: string, to: string): { from: string; to: string; days: number }
 * ```
 *
 * - `from`/`to` are `YYYY-MM-DD` calendar day keys (`dateKeySchema`, the shape
 *   an `analyticsDaily` row stores); both ends are **included**.
 * - `days` is the inclusive calendar-day count, so `2026-09-24`..`2026-09-24`
 *   is `1` and `2026-09-24`..`2026-09-25` is `2`.
 * - More than `MAX_ANALYTICS_RANGE_DAYS` throws
 *   `AppError("range_too_large")` — `422`, `details: { maxDays: 366 }`.
 * - `to` earlier than `from` throws `AppError("invalid_date_range")` — `422`,
 *   `details: { startAt, endAt }` — the same refusal the event create/update
 *   window already raises for a reversed span.
 * - A value that is not a calendar day key throws
 *   `AppError("validation_failed")` — `422`, `details.fields[].path` naming the
 *   offending parameter, the established `parseQrQuery` shape (ADR-0620).
 *
 * ## Assumptions (ADR-0640 §Assumptions)
 *
 * - A1 — the day count is calendar-based (a `YYYY-MM-DD` subtraction), not a
 *   24-hour instant difference: an analytics range has no time-of-day, so a
 *   DST day is still one day.
 * - A2 — `from`/`to` are echoed back unchanged; the function is a validator,
 *   not a normaliser, so it never rewrites a legal key.
 */

/**
 * Run `run` and return what it threw, failing when it returned normally.
 *
 * @param run - The call under test.
 * @returns The thrown value.
 */
function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw, but it returned");
}

/** The `details.fields[].path` values of a thrown validation refusal. */
function fieldPaths(error: unknown): string[] {
  if (!(error instanceof AppError)) {
    throw new Error(
      `expected an AppError, received ${error === null ? "null" : typeof error}: ${String(error)}`
    );
  }
  const fields = error.details?.fields;
  if (!Array.isArray(fields)) {
    return [];
  }
  return fields.map((entry: unknown): string => {
    if (entry !== null && typeof entry === "object" && "path" in entry) {
      const path: unknown = entry.path;
      return typeof path === "string" ? path : "";
    }
    return "";
  });
}

describe("U1 — the analytics range is inclusive at both ends", () => {
  it("counts a single day as one day", () => {
    expect(validateAnalyticsRange("2026-09-24", "2026-09-24")).toEqual({
      from: "2026-09-24",
      to: "2026-09-24",
      days: 1,
    });
  });

  it("counts two adjacent days as two days, not one", () => {
    expect(validateAnalyticsRange("2026-09-24", "2026-09-25").days).toBe(2);
  });

  it("counts inclusively across a month boundary", () => {
    expect(validateAnalyticsRange("2026-01-31", "2026-02-02").days).toBe(3);
  });

  it("counts a leap-day span inclusively", () => {
    expect(validateAnalyticsRange("2024-02-28", "2024-03-01").days).toBe(3);
  });

  it("echoes the requested keys unchanged and returns only from/to/days", () => {
    const range = validateAnalyticsRange("2026-09-01", "2026-09-25");

    expect(range).toEqual({ from: "2026-09-01", to: "2026-09-25", days: 25 });
    expect(Object.keys(range).sort()).toEqual(["days", "from", "to"]);
  });
});

describe("U1 — the 366-day ceiling", () => {
  it("advertises the ceiling as 366 days", () => {
    expect(MAX_ANALYTICS_RANGE_DAYS).toBe(366);
  });

  it("accepts exactly 366 inclusive days (a leap year)", () => {
    expect(validateAnalyticsRange("2024-01-01", "2024-12-31").days).toBe(366);
  });

  it("refuses 367 inclusive days with 422 range_too_large naming the maximum", () => {
    const error = caught(() => validateAnalyticsRange("2024-01-01", "2025-01-01"));

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: "range_too_large",
      status: 422,
      details: { maxDays: 366 },
    });
  });

  it("refuses the card's 400-day span with 422 range_too_large", () => {
    const error = caught(() => validateAnalyticsRange("2026-01-01", "2027-02-04"));

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "range_too_large", status: 422 });
  });
});

describe("U1 — malformed and reversed ranges", () => {
  it("refuses a reversed range with 422 invalid_date_range naming both ends", () => {
    const error = caught(() => validateAnalyticsRange("2026-09-25", "2026-09-01"));

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: "invalid_date_range",
      status: 422,
      details: { startAt: "2026-09-25", endAt: "2026-09-01" },
    });
  });

  it("refuses an unpadded `from` key as a validation failure naming `from`", () => {
    const error = caught(() => validateAnalyticsRange("2026-9-1", "2026-09-25"));

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "validation_failed", status: 422 });
    expect(fieldPaths(error)).toContain("from");
  });

  it("refuses a non-date `to` value as a validation failure naming `to`", () => {
    const error = caught(() => validateAnalyticsRange("2026-09-01", "last-week"));

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "validation_failed", status: 422 });
    expect(fieldPaths(error)).toContain("to");
  });
});
