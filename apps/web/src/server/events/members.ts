import type { Db } from "mongodb";
import { ObjectId } from "mongodb";

import { maskEmail } from "@openpic/contracts";

import { COLLECTIONS } from "@/server/db/collections";
import { platformRepo, tenantRepo } from "@/server/repos";

import type { EventMember } from "./member-schema";

/**
 * Event-member attribution read model (OP-119, contract §4.3, schema §15.2).
 *
 * The listing answers "who works on this event, and how many images did each of
 * them upload". The upload count is the **cached counter** stored on the member
 * row (`event_organizers.uploadedImageCount`, `$inc`'d on upload complete) —
 * never a request-time count over `event_images`, so the read costs the same
 * whether an event has ten images or a hundred thousand (ADR-0642).
 *
 * The contact is masked **here**, at the projection boundary, with the shared
 * `maskEmail` helper (§0.13), exactly as the workspace listing does: the raw
 * address never reaches a response body (§0.15).
 *
 * The read is **total** (ADR-0644): a stored row that cannot name a user, or
 * that carries no usable join instant, is skipped rather than allowed to fail
 * the whole listing for every caller.
 */

/** The Better Auth-owned user collection (schema §13.1). */
const USER_COLLECTION = "user";

/** An `event_organizers` row as stored (schema §15.2). */
interface EventOrganizerRow {
  readonly _id?: unknown;
  readonly userId?: unknown;
  readonly role?: unknown;
  readonly status?: unknown;
  readonly uploadedImageCount?: unknown;
  readonly addedAt?: unknown;
  readonly createdAt?: unknown;
}

/** A row that can be reported: it names a user and has a join instant. */
interface DatedMemberRow {
  readonly row: EventOrganizerRow;
  readonly userId: ObjectId;
  /** The user id as the lowercase hex the DTO carries and the joins key on. */
  readonly userIdHex: string;
  readonly joinedAtMillis: number;
}

/** The Better Auth user fields the projection reads. */
interface UserDocument {
  readonly _id?: ObjectId;
  readonly email?: string;
}

/** The `userProfiles` fields the projection reads (schema §13.2). */
interface UserProfileDocument {
  readonly userId?: ObjectId;
  readonly displayName?: string;
}

/**
 * Read one stored value as an `ObjectId`.
 *
 * The member rows in this codebase store `userId` as the hex string the write
 * path had in hand, while schema §15.2 types it as an `ObjectId`; a read must
 * accept both, and anything else cannot name a user.
 *
 * @param value - The stored `userId`.
 * @returns The id, or `null` when the value is not an id.
 */
function toObjectId(value: unknown): ObjectId | null {
  if (value instanceof ObjectId) {
    return value;
  }
  const raw = typeof value === "string" ? value : "";
  return /^[0-9a-f]{24}$/i.test(raw) ? new ObjectId(raw) : null;
}

/**
 * Read a stored instant as epoch milliseconds (ADR-0644).
 *
 * Schema §15.2 types both join fields as dates, so only a `Date` can name an
 * instant; anything else — including an invalid `Date` — cannot.
 *
 * @param value - The stored value.
 * @returns The instant, or `null` when the value is not a usable date.
 */
function instantMillis(value: unknown): number | null {
  if (!(value instanceof Date)) {
    return null;
  }
  const millis = value.getTime();
  return Number.isFinite(millis) ? millis : null;
}

/**
 * The instant a member row joined (ADR-0644).
 *
 * `addedAt` is the §15.2 field the DTO reports; this codebase's event-create
 * write stores `createdAt` instead (ADR-0642), so both are read. A row carrying
 * neither is malformed, but it must not fail the whole listing for every caller:
 * it falls back to the insertion instant encoded in its `_id`, which keeps the
 * worker attributed. A row that cannot be dated at all is skipped by the caller.
 *
 * @param row - The stored `event_organizers` row.
 * @returns The join instant in epoch milliseconds, or `null` when undatable.
 */
function joinInstantMillis(row: EventOrganizerRow): number | null {
  const stored = instantMillis(row.addedAt) ?? instantMillis(row.createdAt);
  if (stored !== null) {
    return stored;
  }
  return row._id instanceof ObjectId ? row._id.getTimestamp().getTime() : null;
}

/**
 * Project one member row onto the §4.3 DTO.
 *
 * @param row - The stored `event_organizers` row.
 * @param userId - The member's user id, already proven to name a user.
 * @param joinedAtMillis - The row's join instant, already proven usable.
 * @param user - The member's Better Auth user document, when it exists.
 * @param profile - The member's `userProfiles` document, when it exists.
 * @returns The wire member, with its contact masked.
 */
function projectEventMember(
  row: EventOrganizerRow,
  userId: ObjectId,
  joinedAtMillis: number,
  user: UserDocument | undefined,
  profile: UserProfileDocument | undefined
): EventMember {
  return {
    userId: userId.toHexString(),
    displayName: profile?.displayName ?? "",
    role: row.role === "co_organizer" ? "co_organizer" : "organizer",
    status: row.status === "removed" ? "removed" : "active",
    emailMasked: maskEmail(user?.email ?? ""),
    addedAt: new Date(joinedAtMillis).toISOString(),
    uploadedImageCount: typeof row.uploadedImageCount === "number" ? row.uploadedImageCount : 0,
  };
}

/**
 * List the workers of one event as the §4.3 DTO.
 *
 * The rows are read in one `find` and the users/profiles they reference in two
 * `$in` reads — three round trips total, independent of the member count. Only
 * the event's own members are listed: a workspace member who holds no
 * `event_organizers` row is admitted to *read* the list but is not one of the
 * people the uploads are attributed to (ADR-0640 §A10).
 *
 * @param db - The database to read.
 * @param tenantKey - The event's tenant id, as the stored hex string.
 * @param eventId - The event whose members are listed.
 * @returns The projected members, ordered by the instant they joined.
 */
export async function listEventMembers(
  db: Db,
  tenantKey: string,
  eventId: ObjectId
): Promise<EventMember[]> {
  const rows = (await tenantRepo(tenantKey, db)
    .collection(COLLECTIONS.eventOrganizers)
    .find({ eventId })
    .toArray()) as EventOrganizerRow[];

  const members: DatedMemberRow[] = [];
  for (const row of rows) {
    const userId = toObjectId(row.userId);
    const joinedAtMillis = joinInstantMillis(row);
    // A row that cannot name a user or be dated is not a member the listing can
    // report (ADR-0643 §A15/A16, ADR-0644): it is skipped, never allowed to fail
    // the read for every caller.
    if (userId === null || joinedAtMillis === null) {
      continue;
    }
    members.push({ row, userId, userIdHex: userId.toHexString(), joinedAtMillis });
  }

  const userIds = members.map((member) => member.userId);

  const platform = platformRepo(db);
  const [users, profiles]: [UserDocument[], UserProfileDocument[]] = await Promise.all([
    platform
      .collection(USER_COLLECTION)
      .find({ _id: { $in: userIds } })
      .toArray() as Promise<UserDocument[]>,
    platform
      .collection(COLLECTIONS.userProfiles)
      .find({ userId: { $in: userIds } })
      .toArray() as Promise<UserProfileDocument[]>,
  ]);

  const userById = new Map(users.map((user) => [String(user._id), user]));
  const profileByUserId = new Map(profiles.map((profile) => [String(profile.userId), profile]));

  return members
    .map(({ row, userId, userIdHex, joinedAtMillis }) =>
      projectEventMember(
        row,
        userId,
        joinedAtMillis,
        userById.get(userIdHex),
        profileByUserId.get(userIdHex)
      )
    )
    .sort(
      (left, right) =>
        left.addedAt.localeCompare(right.addedAt) || left.userId.localeCompare(right.userId)
    );
}
