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
  readonly invitedByUserId?: unknown;
}

/** The Better Auth user fields the projection reads. */
interface UserDocument {
  readonly _id?: ObjectId;
  readonly email?: unknown;
}

/** The `userProfiles` fields the projection reads (schema §13.2). */
interface UserProfileDocument {
  readonly userId?: ObjectId;
  readonly displayName?: unknown;
}

/** Read a stored value as a hex id string, or `null`. */
function toHexOrNull(value: unknown): string | null {
  if (value instanceof ObjectId) {
    return value.toHexString();
  }
  return typeof value === "string" ? value : null;
}

/** Read a stored date as an ISO-8601 string, falling back to the epoch. */
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
 * @param membership - The stored `tenantMembers` row.
 * @param user - The member's Better Auth user document, when it exists.
 * @param profile - The member's `userProfiles` document, when it exists.
 * @returns The wire member, with its contact masked.
 */
export function projectMember(
  membership: MembershipDocument,
  user: UserDocument | null,
  profile: UserProfileDocument | null
): Member {
  return {
    userId: toHexOrNull(membership.userId) ?? "",
    displayName: typeof profile?.displayName === "string" ? profile.displayName : "",
    emailMasked: maskEmail(typeof user?.email === "string" ? user.email : ""),
    role: asTenantRole(membership.role),
    status: membership.status === "removed" ? "removed" : "active",
    joinedAt: toIso(membership.joinedAt),
    invitedByUserId: toHexOrNull(membership.invitedByUserId),
    avatarUrl: null,
  };
}

/**
 * List every membership of a workspace as the §2.2 DTO.
 *
 * The rows are read in one `find`, and the users/profiles they reference in two
 * `$in` reads — three round trips total, independent of the member count. Rows
 * whose user document has gone missing are still listed (their contact masks to
 * the fully-masked form) so the screen never silently drops a membership.
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

  const userIds = memberships
    .map((membership) => membership.userId)
    .filter((userId): userId is ObjectId => userId instanceof ObjectId);

  if (memberships.length === 0) {
    return [];
  }

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

  const userById = new Map(users.map((user) => [toHexOrNull(user._id), user]));
  const profileByUserId = new Map(
    profiles.map((profile) => [toHexOrNull(profile.userId), profile])
  );

  return memberships
    .map((membership) => {
      const userId = toHexOrNull(membership.userId);
      return projectMember(
        membership,
        userId === null ? null : (userById.get(userId) ?? null),
        userId === null ? null : (profileByUserId.get(userId) ?? null)
      );
    })
    .sort((left, right) => {
      if (left.joinedAt !== right.joinedAt) {
        return left.joinedAt < right.joinedAt ? -1 : 1;
      }
      return left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0;
    });
}
