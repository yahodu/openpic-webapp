import type { Db } from "mongodb";

import { COLLECTIONS } from "../db/collections";
import { getDb } from "../db/mongo";

import { toDto } from "./dto";

/**
 * The single whitelisted cross-tenant read (OP-77, schema §10.3; API contract
 * §6.7 `GET /api/v1/me/events`).
 *
 * An attendee is a data subject whose records live inside several tenants'
 * boundaries, so "all my events" is the one legitimate query that must cross
 * tenants. Every other read is confined by `tenantRepo`; this module is the
 * deliberate, reviewable exception. It lives under `src/server/repos/**`, the
 * one place (besides `db/**`) where the lint rule permits reaching the driver
 * directly (see `no-direct-collection-access`).
 *
 * The query is keyed on the *caller's* subject id only — never on a tenant —
 * so it returns every profile for that user across all tenants and cannot be
 * turned outward to another user: the filter is `subject.userId === userId`.
 * Results are projected through `toDto` so no internal `_id` escapes, and
 * ordered by `_id` so offset pagination is stable and pages never overlap.
 */

/** The subject half of an attendee-event profile. */
export interface AttendeeProfileSubject {
  readonly kind?: string;
  readonly userId?: string;
}

/** The stored shape of an attendee-event profile (OP-77). */
// A `type` alias (not an `interface`) is required here: `toDto`'s `Omit`-based
// projection only preserves the named fields when the document type has no
// index signature, while mongodb's `Collection<T>` constraint needs the implicit
// one that a type alias supplies.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type AttendeeProfileDocument = {
  readonly tenantId: string;
  readonly eventId?: string;
  readonly subject?: AttendeeProfileSubject;
};

/** A client-facing attendee-event profile (never emits `_id`). */
export interface AttendeeProfileDto {
  readonly id: string;
  readonly tenantId: string;
  readonly subject?: AttendeeProfileSubject;
  readonly [key: string]: unknown;
}

/** Offset pagination for a cross-tenant read. */
export interface CrossTenantPage {
  /** Maximum number of items to return. Omitted means no limit. */
  readonly limit?: number;
  /** Number of items to skip. Defaults to 0. */
  readonly offset?: number;
}

/** One page of a cross-tenant read. */
export interface AttendeeProfilePage {
  readonly items: AttendeeProfileDto[];
}

/** The cross-tenant read surface (the whitelist). */
export interface CrossTenantReads {
  /**
   * Return every attendee-event profile whose `subject.userId` is `userId`,
   * across all tenants, as one ordered page.
   *
   * @param userId - The data subject's user id (the caller).
   * @param page - Offset/limit pagination; offset defaults to 0.
   * @param db - The database handle; defaults to the shared client (OP-75).
   * @returns The page of DTOs (string `id`, no `_id`).
   */
  findAttendeeProfilesBySubjectUser(
    userId: string,
    page?: CrossTenantPage,
    db?: Db
  ): Promise<AttendeeProfilePage>;
}

async function findAttendeeProfilesBySubjectUser(
  userId: string,
  page: CrossTenantPage = {},
  db: Db = getDb()
): Promise<AttendeeProfilePage> {
  const offset = page.offset ?? 0;

  let cursor = db
    .collection<AttendeeProfileDocument>(COLLECTIONS.attendeeEventProfiles)
    .find({ "subject.userId": userId })
    .sort({ _id: 1 });

  if (offset > 0) {
    cursor = cursor.skip(offset);
  }
  if (page.limit !== undefined && page.limit > 0) {
    cursor = cursor.limit(page.limit);
  }

  const docs = await cursor.toArray();
  const items: AttendeeProfileDto[] = docs.flatMap((doc) => {
    const dto = toDto<AttendeeProfileDocument>(doc);
    return dto === null ? [] : [dto];
  });

  return { items };
}

/** The whitelisted cross-tenant reads. Import nothing else to cross a tenant. */
export const crossTenantReads: CrossTenantReads = {
  findAttendeeProfilesBySubjectUser,
};
