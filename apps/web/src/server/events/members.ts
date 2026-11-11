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
 */

/** The Better Auth-owned user collection (schema §13.1). */
const USER_COLLECTION = "user";

/** An `event_organizers` row as stored (schema §15.2). */
interface EventOrganizerRow {
  readonly userId?: unknown;
  readonly role?: unknown;
  readonly status?: unknown;
  readonly uploadedImageCount?: unknown;
  readonly addedAt?: unknown;
  readonly createdAt?: unknown;
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

/** The join instant the §4.3 `addedAt` field reports. */
function toAddedAt(row: EventOrganizerRow): string {
  return new Date((row.addedAt ?? row.createdAt) as string | number | Date).toISOString();
}

/**
 * Project one member row onto the §4.3 DTO.
 *
 * @param row - The stored `event_organizers` row.
 * @param user - The member's Better Auth user document, when it exists.
 * @param profile - The member's `userProfiles` document, when it exists.
 * @returns The wire member, with its contact masked.
 */
function projectEventMember(
  row: EventOrganizerRow,
  user: UserDocument | undefined,
  profile: UserProfileDocument | undefined
): EventMember {
  return {
    userId: String(row.userId),
    displayName: profile?.displayName ?? "",
    role: row.role === "co_organizer" ? "co_organizer" : "organizer",
    status: row.status === "removed" ? "removed" : "active",
    emailMasked: maskEmail(user?.email ?? ""),
    addedAt: toAddedAt(row),
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

  const userIds = rows
    .map((row) => toObjectId(row.userId))
    .filter((userId): userId is ObjectId => userId !== null);

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

  return rows
    .map((row) => {
      const userId = String(row.userId);
      return projectEventMember(row, userById.get(userId), profileByUserId.get(userId));
    })
    .sort(
      (left, right) =>
        left.addedAt.localeCompare(right.addedAt) || left.userId.localeCompare(right.userId)
    );
}
