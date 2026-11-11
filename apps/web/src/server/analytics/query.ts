import type { FieldError } from "@openpic/contracts";

import { appError } from "@/server/http/errors";

import { validateAnalyticsRange, type AnalyticsRange } from "./date-range";

/**
 * The `GET /tenants/{tenantId}/analytics` query decoder (OP-119, contract
 * §4.5).
 *
 * `from` and `to` are required day keys and the `scope` vocabulary is **closed**
 * to `tenant` (the default) and `event`, with `eventId` required for the
 * latter. The closure is security-relevant, not cosmetic: schema §20.1 also
 * stores a `platform` scope, so forwarding a raw query value into the rollup
 * filter would serve every workspace's rollup to one tenant `owner`
 * (ADR-0641).
 */

/** The aggregate a request may read. */
export type AnalyticsScopeKind = "tenant" | "event";

/** The closed `scope` vocabulary, `tenant` first because it is the default. */
const SCOPE_KINDS: readonly AnalyticsScopeKind[] = ["tenant", "event"];

/** A 24-hex `ObjectId`, the only shape an `eventId` query value may take. */
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

/** A validated analytics request. */
export interface AnalyticsQuery {
  /** The validated `from..to` window. */
  readonly range: AnalyticsRange;
  /** Which aggregate to read. */
  readonly kind: AnalyticsScopeKind;
  /** The `scope=event` target, or `null` for the tenant scope. */
  readonly eventId: string | null;
}

/** Whether a raw `scope` value is in the closed vocabulary. */
function isScopeKind(value: string): value is AnalyticsScopeKind {
  return (SCOPE_KINDS as readonly string[]).includes(value);
}

/**
 * Refuse one query parameter as a `422 validation_failed` naming it.
 *
 * Uses the established `parseQrQuery` field shape (ADR-0620), so a client reads
 * every query refusal the same way and `details.fields[].path` names the
 * offending parameter.
 */
function refuseField(path: "scope" | "eventId", message: string): never {
  const field: FieldError = { path, code: "invalid", message };
  throw appError("validation_failed", { details: { fields: [field] } });
}

/**
 * Decode and validate the analytics query.
 *
 * @param searchParams - The request's query parameters.
 * @returns The window, the scope and (for `scope=event`) the event id.
 * @throws An `AppError` with code `validation_failed` (`422`) for a `scope`
 *   outside the vocabulary, a malformed or missing `eventId` under
 *   `scope=event`, or a `from`/`to` that is not a calendar day key; the range
 *   refusals `invalid_date_range` and `range_too_large` come from the window
 *   validator.
 */
export function parseAnalyticsQuery(searchParams: URLSearchParams): AnalyticsQuery {
  const rawScope = searchParams.get("scope");
  const scope = rawScope === null || rawScope === "" ? "tenant" : rawScope;
  if (!isScopeKind(scope)) {
    refuseField("scope", `Must be one of: ${SCOPE_KINDS.join(", ")}.`);
  }

  const range = validateAnalyticsRange(
    searchParams.get("from") ?? "",
    searchParams.get("to") ?? ""
  );

  if (scope === "tenant") {
    return { range, kind: "tenant", eventId: null };
  }

  const eventId = searchParams.get("eventId");
  if (eventId === null || eventId === "") {
    refuseField("eventId", "Is required when scope=event.");
  }
  if (!OBJECT_ID_HEX.test(eventId)) {
    // A malformed *filter value* is a request-shape refusal (`422`), unlike a
    // malformed path segment, which denies `404` so a route is never an
    // existence oracle. The caller is already an authorised tenant
    // `owner`|`admin`, so nothing is disclosed by saying the value is malformed.
    refuseField("eventId", "Must be a 24-character hex id.");
  }

  return { range, kind: "event", eventId };
}
