import { ObjectId, type Db, type Document } from "mongodb";

import { COLLECTIONS } from "../db/collections";
import { getDb } from "../db/mongo";
import { type Cursor } from "../http/cursor";
import { appError } from "../http/errors";

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

/** Offset/limit plus a keyset cursor, for the reads that page on §0.8's rules. */
export interface CrossTenantCursorPage extends CrossTenantPage {
  /** The decoded cursor from the previous page, or absent for the first page. */
  readonly cursor?: Cursor;
}

/** One page of a cross-tenant read. */
export interface AttendeeProfilePage {
  readonly items: AttendeeProfileDto[];
}

/** One reusable selfie of the calling subject (schema §16.4). */
export interface ReusableSelfie {
  readonly id: string;
  readonly createdAt: Date;
  /** The content hash the preview URL is signed over — never the vector. */
  readonly contentHash: string;
  readonly quality: { readonly accepted: boolean };
}

/** One page of reusable selfies. */
export interface ReusableSelfiePage {
  readonly items: ReusableSelfie[];
}

/**
 * One participation in the caller's own event list (contract §6.7).
 *
 * The profile's identity, the event facts and the organizer's display name are
 * joined here because this is the one read allowed to cross tenants: the join
 * keys are the row's own `eventId`/`tenantId`, never a caller-supplied one.
 */
export interface AttendeeEventItem {
  readonly profileId: string;
  readonly tenantId: string;
  readonly eventId: string;
  readonly eventName: string;
  readonly organizerDisplayName: string;
  readonly startAt: Date | null;
  readonly displayTimeZone: string | null;
  readonly slug: string;
  readonly matchCount: number;
  readonly newMatchCount: number;
  readonly status: string;
  readonly galleryExpiresAt: Date | null;
  /** The participation's own touch time — the list's sort key and cursor half. */
  readonly updatedAt: Date;
}

/** One page of the caller's own events. */
export interface AttendeeEventPage {
  readonly items: AttendeeEventItem[];
}

/** A 24-hex ObjectId, the only accepted `_id` tiebreaker in a cursor. */
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

/** The stored half of a selfie the reusable listing projects (§16.4). */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type ReusableSelfieDocument = {
  readonly _id: ObjectId;
  readonly createdAt: Date;
  readonly contentHash: string;
  readonly quality?: { readonly accepted?: boolean };
};

/**
 * The `subject.userId` predicate for one data subject.
 *
 * Schema §10.3 stores the id as an `ObjectId`, while the OP-77 suites seeded the
 * projection with string ids; matching both keeps the one whitelisted read
 * correct for the real stored shape without breaking the fixture shape.
 *
 * @param userId - The data subject's user id (hex or the fixture's string).
 * @returns A filter value matching either representation.
 */
function subjectUserValue(
  userId: string
): ObjectId | string | { readonly $in: (ObjectId | string)[] } {
  return ObjectId.isValid(userId) ? { $in: [userId, new ObjectId(userId)] } : userId;
}

/**
 * The cross-tenant read surface (the whitelist).
 */
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

  /**
   * Return the calling subject's reusable selfies across all tenants.
   *
   * A selfie is reusable once it is the profile's active one, so the filter is
   * `subject.userId` + `isActive`; the projection carries the content hash and
   * the quality verdict and **never** the face vector (§6.3, §0.15).
   *
   * @param userId - The data subject's user id (the caller).
   * @param page - Offset/limit pagination plus the previous page's cursor.
   * @param db - The database handle; defaults to the shared client.
   * @returns The page of reusable selfies, newest first.
   */
  findReusableSelfiesBySubjectUser(
    userId: string,
    page?: CrossTenantCursorPage,
    db?: Db
  ): Promise<ReusableSelfiePage>;

  /**
   * Return the caller's own participations across all tenants, newest touch
   * first (contract §6.7, schema §15.3 `{"subject.userId":1, updatedAt:-1}`).
   *
   * The filter is `subject.userId === caller` and nothing else: that predicate
   * **is** the security boundary of the one whitelisted cross-tenant read.
   *
   * @param userId - The data subject's user id (the caller).
   * @param page - The §0.8 page size plus the previous page's cursor.
   * @param db - The database handle; defaults to the shared client.
   * @returns The page, with each row joined to its event and organizer.
   */
  findAttendeeEventsBySubjectUser(
    userId: string,
    page?: CrossTenantCursorPage,
    db?: Db
  ): Promise<AttendeeEventPage>;

  /**
   * Return one `face_matches` row by its id alone (OP-133, §6.5, §17.5).
   *
   * `POST /p/matches/{matchId}/hide` carries no event slug, so the row's own
   * `tenantId` is what scopes the ownership check that follows; the id is
   * unguessable and is never the authorization.
   *
   * @param matchId - The 24-hex match id.
   * @param db - The database handle; defaults to the shared client.
   * @returns The row's owning scope, or `null` when no match carries the id.
   */
  findFaceMatchById(matchId: string, db?: Db): Promise<OwnedMatchRow | null>;
}

async function findAttendeeProfilesBySubjectUser(
  userId: string,
  page: CrossTenantPage = {},
  db: Db = getDb()
): Promise<AttendeeProfilePage> {
  const offset = page.offset ?? 0;

  let cursor = db
    .collection<AttendeeProfileDocument>(COLLECTIONS.attendeeEventProfiles)
    .find({ "subject.userId": subjectUserValue(userId) })
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

/**
 * The keyset filter that follows `cursor` on a `field`-desc list (§0.8).
 *
 * The strict `$or` on the compound `(field, _id)` key is what keeps a row that
 * shares an instant with the last one of the previous page from being skipped;
 * both halves are revived to their stored BSON types, because a string `_id`
 * compares unequal to every `ObjectId`.
 *
 * @param field - The participation's sort field: `createdAt` or `updatedAt`.
 * @param cursor - The decoded cursor, or `null` on the first page.
 * @returns The filter fragment, or the empty filter.
 * @throws {AppError} `invalid_cursor` (400) when a half is not a stored type.
 */
function keysetFilter(field: "createdAt" | "updatedAt", cursor: Cursor | null): Document {
  if (cursor === null) {
    return {};
  }
  const at = new Date(cursor.c);
  if (Number.isNaN(at.getTime()) || !OBJECT_ID_HEX.test(cursor.i)) {
    throw appError("invalid_cursor");
  }
  return {
    $or: [{ [field]: { $lt: at } }, { [field]: at, _id: { $lt: new ObjectId(cursor.i) } }],
  };
}

/**
 * The caller's reusable selfies, newest first (contract §6.3, schema §16.4).
 *
 * @param userId - The data subject's user id (hex).
 * @param page - Offset/limit pagination plus the previous page's cursor.
 * @param db - The database handle; defaults to the shared client.
 * @returns The page, projected to what the listing may expose.
 */
async function findReusableSelfiesBySubjectUser(
  userId: string,
  page: CrossTenantCursorPage = {},
  db: Db = getDb()
): Promise<ReusableSelfiePage> {
  const offset = page.offset ?? 0;

  let cursor = db
    .collection<ReusableSelfieDocument>(COLLECTIONS.selfies)
    .find(
      {
        "subject.userId": subjectUserValue(userId),
        isActive: true,
        ...keysetFilter("createdAt", page.cursor ?? null),
      },
      { projection: { _id: 1, createdAt: 1, contentHash: 1, quality: 1 } }
    )
    .sort({ createdAt: -1, _id: -1 });

  if (offset > 0) {
    cursor = cursor.skip(offset);
  }
  if (page.limit !== undefined && page.limit > 0) {
    cursor = cursor.limit(page.limit);
  }

  const docs = await cursor.toArray();
  return {
    items: docs.map((doc) => ({
      id: String(doc._id),
      createdAt: doc.createdAt,
      contentHash: doc.contentHash,
      quality: { accepted: doc.quality?.accepted === true },
    })),
  };
}

/** The stored `attendee_event_profiles` fields this read projects (§15.3). */
interface AttendeeProfileRow {
  readonly _id: ObjectId;
  readonly tenantId: string;
  readonly eventId: ObjectId;
  readonly status?: string;
  readonly matchCount?: number;
  readonly updatedAt?: Date;
}

/** The stored `events` fields the list item needs (§15.1). */
interface AttendeeEventRow {
  readonly _id: ObjectId;
  readonly name?: string;
  readonly startAt?: Date;
  readonly displayTimeZone?: string;
  readonly retentionExpiresAt?: Date | null;
  readonly accessLinks?: readonly { readonly slug?: string; readonly active?: boolean }[];
}

/** The stored `tenants` field the item's organizer name reads (§13.1). */
interface AttendeeTenantRow {
  readonly _id: ObjectId;
  readonly name?: string;
}

/**
 * The caller's own participations, newest touch first (contract §6.7).
 *
 * @param userId - The data subject's user id (hex).
 * @param page - The §0.8 page size plus the previous page's cursor.
 * @param db - The database handle; defaults to the shared client.
 * @returns The page, joined to each row's event and organizer.
 */
async function findAttendeeEventsBySubjectUser(
  userId: string,
  page: CrossTenantCursorPage = {},
  db: Db = getDb()
): Promise<AttendeeEventPage> {
  const offset = page.offset ?? 0;

  let cursor = db
    .collection<AttendeeProfileRow>(COLLECTIONS.attendeeEventProfiles)
    .find({
      "subject.userId": subjectUserValue(userId),
      ...keysetFilter("updatedAt", page.cursor ?? null),
    })
    .sort({ updatedAt: -1, _id: -1 });

  if (offset > 0) {
    cursor = cursor.skip(offset);
  }
  if (page.limit !== undefined && page.limit > 0) {
    cursor = cursor.limit(page.limit);
  }

  const profiles = await cursor.toArray();
  if (profiles.length === 0) {
    return { items: [] };
  }

  const events = await db
    .collection<AttendeeEventRow>(COLLECTIONS.events)
    .find(
      { _id: { $in: profiles.map((profile) => profile.eventId) } },
      {
        projection: {
          name: 1,
          startAt: 1,
          displayTimeZone: 1,
          retentionExpiresAt: 1,
          accessLinks: 1,
        },
      }
    )
    .toArray();
  const eventById = new Map(events.map((event) => [String(event._id), event]));

  const tenantObjectIds = profiles
    .map((profile) => profile.tenantId)
    .filter((tenantId) => ObjectId.isValid(tenantId))
    .map((tenantId) => new ObjectId(tenantId));
  const tenants = await db
    .collection<AttendeeTenantRow>(COLLECTIONS.tenants)
    .find({ _id: { $in: tenantObjectIds } }, { projection: { name: 1 } })
    .toArray();
  const tenantById = new Map(tenants.map((tenant) => [String(tenant._id), tenant]));

  const unseen = await db
    .collection(COLLECTIONS.faceMatches)
    .aggregate([
      {
        $match: {
          profileId: { $in: profiles.map((profile) => profile._id) },
          seenAt: null,
          hiddenAt: null,
        },
      },
      { $group: { _id: "$profileId", count: { $sum: 1 } } },
    ])
    .toArray();
  const newMatchCountByProfile = new Map(
    unseen.map((row) => [String(row._id), Number(row.count ?? 0)])
  );

  const items = profiles.map((profile) => {
    const event = eventById.get(String(profile.eventId));
    const slug = event?.accessLinks?.find((link) => link.active === true)?.slug;
    return {
      profileId: String(profile._id),
      tenantId: profile.tenantId,
      eventId: String(profile.eventId),
      eventName: event?.name ?? "",
      organizerDisplayName: tenantById.get(profile.tenantId)?.name ?? "",
      startAt: event?.startAt ?? null,
      displayTimeZone: event?.displayTimeZone ?? null,
      slug: slug ?? "",
      matchCount: profile.matchCount ?? 0,
      newMatchCount: newMatchCountByProfile.get(String(profile._id)) ?? 0,
      status: profile.status ?? "ready",
      galleryExpiresAt: event?.retentionExpiresAt ?? null,
      updatedAt: profile.updatedAt ?? new Date(0),
    };
  });

  return { items };
}

/** A stored `face_matches` row reduced to its owning scope (schema §17.5). */
export interface OwnedMatchRow {
  readonly tenantId: string;
  readonly eventId: ObjectId;
  readonly profileId: ObjectId;
}

/**
 * One `face_matches` row by its id alone (OP-133; contract §6.5, schema §17.5).
 *
 * @param matchId - The 24-hex match id.
 * @param db - The database handle; defaults to the shared client.
 * @returns The row's owning scope, or `null` when no match carries the id.
 */
async function findFaceMatchById(matchId: string, db: Db = getDb()): Promise<OwnedMatchRow | null> {
  if (!ObjectId.isValid(matchId)) {
    return null;
  }
  return (await db
    .collection(COLLECTIONS.faceMatches)
    .findOne(
      { _id: new ObjectId(matchId) },
      { projection: { tenantId: 1, eventId: 1, profileId: 1 } }
    )) as OwnedMatchRow | null;
}

/** The whitelisted cross-tenant reads. Import nothing else to cross a tenant. */
export const crossTenantReads: CrossTenantReads = {
  findAttendeeProfilesBySubjectUser,
  findReusableSelfiesBySubjectUser,
  findAttendeeEventsBySubjectUser,
  findFaceMatchById,
};

/** A stored `attendee_event_profiles` row as a claim walks it (§15.3). */
export interface ClaimProfileRow {
  readonly _id: ObjectId;
  readonly tenantId: string;
  readonly eventId: ObjectId;
  readonly status?: string;
  readonly activeSelfieId?: ObjectId | null;
  readonly matchCount?: number;
}

/** One §15.3 re-point: the profile, its session, the new owner and the instant. */
export interface RepointAttendeeProfileOptions {
  readonly profileId: ObjectId;
  /** The anonymous owner being moved, matched so a row another writer moved is not. */
  readonly sessionId: string;
  /** The account the profile moves to. */
  readonly userId: ObjectId;
  /** The instant stamped on `claimedAt`. */
  readonly now: Date;
  readonly db: Db;
}

/**
 * The whitelisted cross-tenant **write** surface (OP-134, contract §6.7, schema
 * §15.3).
 *
 * A session's anonymous profiles were minted under whichever tenant the
 * attendee reached, so re-pointing them at one account crosses tenants by
 * construction and cannot go through `tenantRepo` (the owning tenant is only
 * known once the row is read). This module is the deliberate, reviewable door
 * for that write — the sibling of `crossTenantReads`, in the one place the lint
 * rule permits reaching the driver directly. Contract §0.3/§10.3 still names
 * only the `GET /me/events` **read**; this write belongs beside it here, not in
 * a service.
 *
 * Filters, the §15.3 `$set`/`$unset` pair and the ordering of the walk's calls
 * are the claim's own, moved verbatim: no key, projection or write changed.
 */
export interface CrossTenantWrites {
  /**
   * The session's still-anonymous profiles, across every tenant.
   *
   * @param sessionId - The session's `_id` (hex) as stored on `subject`.
   * @param db - The database handle.
   * @returns The rows the walk decides over.
   */
  findAnonymousProfilesOfSession(sessionId: string, db: Db): Promise<ClaimProfileRow[]>;

  /**
   * The account's own profile for one event, across every tenant.
   *
   * @param eventId - The event's id.
   * @param userId - The caller's id.
   * @param db - The database handle.
   * @returns The row, or `null` when the account has none for that event.
   */
  findUserProfileForEvent(
    eventId: ObjectId,
    userId: ObjectId,
    db: Db
  ): Promise<ClaimProfileRow | null>;

  /**
   * One selfie's `createdAt`, the decision table's tie input.
   *
   * @param selfieId - The profile's active selfie, or `null`/absent.
   * @param db - The database handle.
   * @returns The instant, or `null` when the profile holds no selfie.
   */
  selfieCreatedAt(selfieId: ObjectId | null | undefined, db: Db): Promise<Date | null>;

  /**
   * Move one anonymous profile to the account, keeping `_id`, selfies and
   * matches (§15.3's atomic re-point).
   *
   * @param options - The profile, its session, the owner and the instant.
   * @returns `true` when this call moved the row, `false` when another writer
   *   got there first.
   */
  repointAttendeeProfile(options: RepointAttendeeProfileOptions): Promise<boolean>;

  /**
   * Adopt the anonymous profile's active selfie onto the account's own row.
   *
   * @param profileId - The account's profile for that event.
   * @param selfieId - The anonymous profile's active selfie.
   * @param db - The database handle.
   */
  adoptSelfie(profileId: ObjectId, selfieId: ObjectId | null | undefined, db: Db): Promise<void>;
}

async function findAnonymousProfilesOfSession(
  sessionId: string,
  db: Db
): Promise<ClaimProfileRow[]> {
  return db
    .collection<ClaimProfileRow>(COLLECTIONS.attendeeEventProfiles)
    .find({ "subject.kind": "anonymous", "subject.attendeeSessionId": sessionId })
    .toArray();
}

async function findUserProfileForEvent(
  eventId: ObjectId,
  userId: ObjectId,
  db: Db
): Promise<ClaimProfileRow | null> {
  return db.collection<ClaimProfileRow>(COLLECTIONS.attendeeEventProfiles).findOne({
    eventId,
    "subject.kind": "user",
    "subject.userId": userId,
  });
}

async function selfieCreatedAt(
  selfieId: ObjectId | null | undefined,
  db: Db
): Promise<Date | null> {
  if (selfieId === null || selfieId === undefined) {
    return null;
  }
  const row = (await db
    .collection(COLLECTIONS.selfies)
    .findOne({ _id: selfieId }, { projection: { createdAt: 1 } })) as {
    readonly createdAt?: unknown;
  } | null;
  return row?.createdAt instanceof Date ? row.createdAt : null;
}

async function repointAttendeeProfile(options: RepointAttendeeProfileOptions): Promise<boolean> {
  // Schema §15.3's atomic re-point, verbatim: `_id`, selfies and matches stay
  // put; only `subject` moves.
  const repointed = await options.db.collection(COLLECTIONS.attendeeEventProfiles).updateOne(
    {
      _id: options.profileId,
      "subject.kind": "anonymous",
      "subject.attendeeSessionId": options.sessionId,
    },
    {
      $set: {
        "subject.kind": "user",
        "subject.userId": options.userId,
        claimedAt: options.now,
      },
      $unset: { "subject.attendeeSessionId": "" },
    }
  );
  return repointed.matchedCount > 0;
}

async function adoptSelfie(
  profileId: ObjectId,
  selfieId: ObjectId | null | undefined,
  db: Db
): Promise<void> {
  await db
    .collection(COLLECTIONS.attendeeEventProfiles)
    .updateOne({ _id: profileId }, { $set: { activeSelfieId: selfieId ?? null } });
}

/** The whitelisted cross-tenant writes. Import nothing else to cross a tenant. */
export const crossTenantWrites: CrossTenantWrites = {
  findAnonymousProfilesOfSession,
  findUserProfileForEvent,
  selfieCreatedAt,
  repointAttendeeProfile,
  adoptSelfie,
};
