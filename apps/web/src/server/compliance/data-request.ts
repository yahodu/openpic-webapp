import { appError } from "@/server/http/errors";
import { addDays } from "@/server/runtime/time";

/**
 * The data-subject-request rules (OP-138, contract §8.1, schema §20.3;
 * ADR-0898 §2).
 *
 * Three questions `POST /api/v1/me/data-requests` must answer before it may
 * write a row, none of which needs a database, a clock or a request:
 * which regulation applies, when the request falls due, and what an anonymous
 * attendee may even ask about.
 */

/** The two regimes the platform serves. */
export const DSR_REGULATIONS = ["gdpr", "dpdpa"] as const;

/** A regulation a request may be filed under. */
export type DsrRegulation = (typeof DSR_REGULATIONS)[number];

/** Every request type the contract and the two regimes grant. */
export const DSR_REQUEST_TYPES = [
  "access",
  "erasure",
  "rectification",
  "portability",
  "consent_withdrawal",
  "correction",
  "restriction",
  "objection",
  "nomination",
  "grievance",
] as const;

/** A member of {@link DSR_REQUEST_TYPES}. */
export type DsrRequestType = (typeof DSR_REQUEST_TYPES)[number];

/** The tenant's stored data region (schema §13.3). */
export type TenantDataRegion = "in" | "eu";

/** The inputs the regulation ladder reads. */
export interface RegulationInput {
  /** The body's explicit choice; always wins. */
  readonly requested?: DsrRegulation;
  /** The tenant's `dataRegion`. */
  readonly tenantDataRegion?: TenantDataRegion | null;
  /** The caller's ISO 3166-1 alpha-2 country, any case. */
  readonly callerCountry?: string | null;
}

/** The EU member states (ISO 3166-1 alpha-2), for the geo rung. */
const EU_MEMBER_STATES: ReadonlySet<string> = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
]);

/**
 * Resolve the regulation a request is filed under.
 *
 * Precedence is body → tenant → geo → platform default. The default is
 * `dpdpa` because the platform's own default data region is `in`, so a caller
 * it cannot attribute is served the home jurisdiction's law.
 *
 * @param input - The explicit choice, the tenant's region and the caller's country.
 * @returns The regulation that applies.
 */
export function resolveRegulation(input: RegulationInput): DsrRegulation {
  if (input.requested !== undefined) {
    return input.requested;
  }
  if (input.tenantDataRegion === "eu") {
    return "gdpr";
  }
  if (input.tenantDataRegion === "in") {
    return "dpdpa";
  }
  const country = input.callerCountry?.trim().toUpperCase();
  if (country === "IN") {
    return "dpdpa";
  }
  if (country !== undefined && EU_MEMBER_STATES.has(country)) {
    return "gdpr";
  }
  return "dpdpa";
}

/** The settings slice the SLA arithmetic reads (`platformSettings.compliance`). */
export interface SlaSettings {
  readonly compliance: { readonly slaDays: Readonly<Record<DsrRegulation, number>> };
}

/**
 * The instant a request falls due: `now + slaDays[regulation]` 24-hour days in
 * UTC, never rounded to midnight.
 *
 * @param now - The filing instant (never mutated).
 * @param regulation - The regulation the window is read from.
 * @param settings - The runtime settings carrying the per-regulation window.
 * @returns A new `Date` the request is due at.
 */
export function computeSlaDueAt(now: Date, regulation: DsrRegulation, settings: SlaSettings): Date {
  const days =
    regulation === "gdpr" ? settings.compliance.slaDays.gdpr : settings.compliance.slaDays.dpdpa;
  return addDays(now, days);
}

/**
 * Narrow a requested scope to what an anonymous session may reference.
 *
 * An omitted scope means the session's own events; a subset keeps request order
 * and collapses duplicates; an empty array is a request about nothing; and any
 * id outside the session is refused `422 invalid_scope` naming the offenders.
 *
 * @param requested - The body's `scope.eventIds`, when present.
 * @param sessionEventIds - The events the attendee session touched.
 * @returns The resolved scope.
 * @throws {AppError} `invalid_scope` (422) with `details.eventIds`.
 */
export function resolveAttendeeScope(
  requested: readonly string[] | undefined,
  sessionEventIds: readonly string[]
): readonly string[] {
  if (requested === undefined) {
    return sessionEventIds;
  }
  const unique = [...new Set(requested)];
  const outside = unique.filter((eventId) => !sessionEventIds.includes(eventId));
  if (unique.length === 0 || outside.length > 0) {
    throw appError("invalid_scope", { details: { eventIds: outside } });
  }
  return unique;
}
