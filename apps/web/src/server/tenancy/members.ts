import type { Db } from "mongodb";
import { ObjectId } from "mongodb";

import { maskEmail } from "@openpic/contracts";

import { USER_PROFILES_COLLECTION } from "@/server/auth/identity-hooks";
import { COLLECTIONS } from "@/server/db/collections";
import { platformRepo } from "@/server/repos";

import type { Member } from "./member-schema";
import { asTenantRole } from "./permissions";

/**
 * Workspace-member read model (OP-101, contract §2.2, schema §13.4).
 *
 * The listing joins three collections in one round trip — `tenantMembers` (the
 * role and lifecycle), the Better Auth `user` (the contact, masked before it
 * leaves this module) and `userProfiles` (the display name) — so a member row is
 * never assembled from a per-row N+1 read.
 *
 * The contact is masked **here**, at the projection boundary, with the shared
 * `maskEmail` helper (§0.13): the raw address never reaches a response body
 * (§0.15).
 */

/** The Better Auth-owned user collection (schema §13.1). */
const USER_COLLECTION = "user";

/** A `tenantMembers` row as stored (schema §13.4). */
export interface MembershipDocument {
  readonly _id?: ObjectId;
  readonly tenantId?: unknown;
  readonly userId?: ObjectId;
  readonly role?: unknown;
  readonly status?: unknown;
  readonly joinedAt?: unknown;
  readonly removedAt?: unknown;
  readonly invitedByUserId?: ObjectId;
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
 * Read a stored date as an ISO-8601 string, falling back to the epoch.
 *
 * A row whose `joinedAt` is absent or unparseable must not fail the whole
 * listing (one corrupt row would otherwise turn `GET /members` into a `500`
 * for every caller of the workspace). It degrades to `1970-01-01T00:00:00.000Z`
 * instead, which keeps `joinedAt` a total, always-comparable ISO string for the
 * listing's sort (ADR-0282 §D2).
 *
 * @param value - The raw `joinedAt` value from the membership row.
 * @returns The instant as an ISO-8601 string, or the epoch when unusable.
 */
function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return new Date(0).toISOString();
}

/**
 * Project one membership row onto the §2.2 DTO.
 *
 * Stored values are read straight from the schema §13.4 document shapes, so the
 * only normalisation needed is the two §2.2 conventions the wire fixes: the
 * contact is masked, and a missing invited-by becomes `null`. `joinedAt` is
 * normalised through {@link toIso} so a corrupt row cannot throw.
 *
 * @param membership - The stored `tenantMembers` row.
 * @param user - The member's Better Auth user document, when it exists.
 * @param profile - The member's `userProfiles` document, when it exists.
 * @returns The wire member, with its contact masked.
 */
export function projectMember(
  membership: MembershipDocument,
  user: UserDocument | undefined,
  profile: UserProfileDocument | undefined
): Member {
  return {
    userId: String(membership.userId),
    displayName: profile?.displayName ?? "",
    emailMasked: maskEmail(user?.email ?? ""),
    role: asTenantRole(membership.role),
    status: membership.status === "removed" ? "removed" : "active",
    joinedAt: toIso(membership.joinedAt),
    invitedByUserId:
      membership.invitedByUserId === undefined ? null : membership.invitedByUserId.toHexString(),
    avatarUrl: null,
  };
}

/**
 * List every membership of a workspace as the §2.2 DTO.
 *
 * The rows are read in one `find`, and the users/profiles they reference in two
 * `$in` reads — three round trips total, independent of the member count. The
 * result is ordered by join time, then by user id, so the listing is total and
 * stable between calls.
 *
 * @param db - The database to read.
 * @param tenantId - The resolved workspace id.
 * @returns The projected members, ordered by join time then user id.
 */
export async function listWorkspaceMembers(db: Db, tenantId: ObjectId): Promise<Member[]> {
  const repo = platformRepo(db);
  const memberships = (await repo
    .collection(COLLECTIONS.tenantMembers)
    .find({ tenantId })
    .toArray()) as MembershipDocument[];

  const userIds = memberships.map((membership) => membership.userId);

  const [users, profiles]: [UserDocument[], UserProfileDocument[]] = await Promise.all([
    repo
      .collection(USER_COLLECTION)
      .find({ _id: { $in: userIds } })
      .toArray(),
    repo
      .collection(USER_PROFILES_COLLECTION)
      .find({ userId: { $in: userIds } })
      .toArray(),
  ]);

  const userById = new Map(users.map((user) => [String(user._id), user]));
  const profileByUserId = new Map(profiles.map((profile) => [String(profile.userId), profile]));

  return memberships
    .map((membership) => {
      const userId = String(membership.userId);
      return projectMember(membership, userById.get(userId), profileByUserId.get(userId));
    })
    .sort(
      (left, right) =>
        left.joinedAt.localeCompare(right.joinedAt) || left.userId.localeCompare(right.userId)
    );
}
