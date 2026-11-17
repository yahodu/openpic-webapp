import { dateKeySchema, type FieldError } from "@openpic/contracts";

import { appError } from "@/server/http/errors";

/**
 * The tenant analytics date-range validator (OP-119, contract §4.5, schema
 * §20.1).
 *
 * `GET /tenants/{tenantId}/analytics?from&to` reads `analyticsDaily` day keys,
 * so the window is expressed in calendar days — `YYYY-MM-DD`, both ends
 * **inclusive** — and the contract's only range rule is "Max 366-day range
 * (`422 range_too_large`)": a leap year's 366 calendar days are accepted and a
 * 367th day is refused.
 */

/** The largest window the analytics read serves, in inclusive calendar days. */
export const MAX_ANALYTICS_RANGE_DAYS = 366;

/** Milliseconds in one calendar day. */
const MS_PER_DAY = 86_400_000;

/** A validated analytics window. */
export interface AnalyticsRange {
  /** The first day of the window, as requested. */
  readonly from: string;
  /** The last day of the window, as requested. */
  readonly to: string;
  /** The inclusive calendar-day count. */
  readonly days: number;
}

/**
 * Refuse a query parameter as a `422 validation_failed` naming it.
 *
 * The shape is the established `parseQrQuery` one (ADR-0620): one
 * `{ path, code, message }` entry per offending parameter.
 */
function refuseFields(fields: readonly FieldError[]): never {
  throw appError("validation_failed", { details: { fields } });
}

/** The `details.fields` entry for a value that is not a calendar day key. */
function dayKeyFieldError(path: "from" | "to"): FieldError {
  return {
    path,
    code: "invalid",
    message: "Must be a calendar date in YYYY-MM-DD form.",
  };
}

/**
 * Validate the `from`/`to` window.
 *
 * Both ends are included, so `from === to` is one day, and a DST day is still
 * one day: the count is a calendar subtraction of two day keys, not a 24-hour
 * instant difference (ADR-0640 §A1). The keys are echoed unchanged — this is a
 * validator, not a normaliser (ADR-0640 §A2).
 *
 * @param from - The requested first day (`YYYY-MM-DD`).
 * @param to - The requested last day (`YYYY-MM-DD`).
 * @returns The validated window and its inclusive day count.
 * @throws An `AppError` with code `validation_failed` (`422`) when either value
 *   is not a calendar day key, `invalid_date_range` (`422`) when `to` precedes
 *   `from`, or `range_too_large` (`422`, details `{ maxDays }`) when the window
 *   exceeds {@link MAX_ANALYTICS_RANGE_DAYS}.
 */
export function validateAnalyticsRange(from: string, to: string): AnalyticsRange {
  const fields: FieldError[] = [];
  if (!dateKeySchema.safeParse(from).success) {
    fields.push(dayKeyFieldError("from"));
  }
  if (!dateKeySchema.safeParse(to).success) {
    fields.push(dayKeyFieldError("to"));
  }
  if (fields.length > 0) {
    refuseFields(fields);
  }

  const startMs = Date.parse(`${from}T00:00:00.000Z`);
  const endMs = Date.parse(`${to}T00:00:00.000Z`);
  if (endMs < startMs) {
    throw appError("invalid_date_range", { details: { startAt: from, endAt: to } });
  }

  const days = Math.round((endMs - startMs) / MS_PER_DAY) + 1;
  if (days > MAX_ANALYTICS_RANGE_DAYS) {
    throw appError("range_too_large", { details: { maxDays: MAX_ANALYTICS_RANGE_DAYS } });
  }

  return { from, to, days };
}
