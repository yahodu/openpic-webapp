import type { Db } from "mongodb";
import { ObjectId } from "mongodb";

import { INVITATIONS_COLLECTION, USER_PROFILES_COLLECTION } from "@/server/auth/identity-hooks";

import { deriveCapabilities, type AccountStatus, type PlatformRole } from "./capabilities";
import type { Me, MeTenant } from "./schema";

/**
 * The `GET`/`PATCH /me` projection (OP-90, contract §1.2).
 *
 * Reads the caller-scoped collections **in parallel** (one round trip for the
 * whole shell) and assembles the `Me` body. `primaryTenant`/`tenants` are
 * derived from the caller's **active** `tenantMembers` rows joined to
 * `tenants`, so a removed membership or a dangling `primaryTenantId` can never
 * resurrect a workspace; `capabilities` is the advisory pure derivation; and
 * `contactCapabilities` is narrowed to its non-secret fields (`pushTokens` are
 * hashed credentials and are never returned, §0.15).
 *
 * `avatarUrl` is `null` until the media-signing infrastructure lands (OP-117);
 * the stored `avatarAssetId` is read but not signed here.
 */

/** The Better Auth-owned user collection (schema §13.1). */
const USER_COLLECTION = "user";
/** Workspaces (schema §13.3). */
const TENANTS_COLLECTION = "tenants";
/** Workspace memberships (schema §13.4). */
const TENANT_MEMBERS_COLLECTION = "tenantMembers";
/** The in-app notification feed (schema §19.4). */
const NOTIFICATIONS_COLLECTION = "notifications";

/** The default time zone when the profile carries none (contract §1.1). */
const DEFAULT_TIME_ZONE = "Asia/Kolkata";
/** The default locale when the profile carries none (contract §1.2). */
const DEFAULT_LOCALE = "en-IN";

/** The Better Auth user fields the projection reads. */
interface UserDocument {
  readonly _id?: ObjectId;
  readonly email?: unknown;
  readonly emailVerified?: unknown;
  readonly phoneNumber?: unknown;
  readonly phoneNumberVerified?: unknown;
  readonly twoFactorEnabled?: unknown;
}

/** The `userProfiles` fields the full projection reads (schema §13.2). */
export interface UserProfileDocument {
  readonly userId?: ObjectId;
  readonly displayName?: unknown;
  readonly avatarAssetId?: unknown;
  readonly locale?: unknown;
  readonly timeZone?: unknown;
  readonly platformRole?: unknown;
  readonly status?: unknown;
  readonly marketingOptIn?: unknown;
  readonly accountCompletedAt?: unknown;
  readonly deletionScheduledAt?: unknown;
  readonly primaryTenantId?: unknown;
  readonly contactCapabilities?: unknown;
}

/** An active membership row (schema §13.4). */
interface TenantMemberDocument {
  readonly tenantId?: unknown;
  readonly userId?: ObjectId;
  readonly role?: unknown;
  readonly status?: unknown;
}

/** A workspace document (schema §13.3). */
interface TenantDocument {
  readonly _id?: ObjectId;
  readonly slug?: unknown;
  readonly name?: unknown;
  readonly status?: unknown;
}

/** Read a stored id (ObjectId or string) as its hex string form, or `null`. */
function asHexString(value: unknown): string | null {
  if (value instanceof ObjectId) {
    return value.toHexString();
  }
  return typeof value === "string" ? value : null;
}

/** Read a stored value as a string, or the fallback. */
function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** Read a stored `Date`/date-string as an ISO string, or `null`. */
function asIsoString(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

/** Coerce a stored platform role to the documented union. */
function asPlatformRole(value: unknown): PlatformRole {
  return value === "admin" ? "admin" : "client";
}

/** Coerce a stored account status to the documented union. */
function asAccountStatus(value: unknown): AccountStatus {
  return value === "suspended" || value === "deletion_pending" || value === "deleted"
    ? value
    : "active";
}

/** Coerce a stored workspace role to the documented union. */
function asTenantRole(value: unknown): MeTenant["role"] {
  return value === "owner" || value === "admin" ? value : "member";
}

/** The never-probed contact capabilities, defaulted for a missing profile. */
function asContactCapabilities(value: unknown): Me["contactCapabilities"] {
  if (typeof value !== "object" || value === null) {
    return { whatsappCapable: null, whatsappCheckedAt: null };
  }
  const record = value as Record<string, unknown>;
  return {
    whatsappCapable: typeof record.whatsappCapable === "boolean" ? record.whatsappCapable : null,
    whatsappCheckedAt: asIsoString(record.whatsappCheckedAt),
  };
}

/** Build the active-membership workspace list, preserving membership order. */
async function loadTenants(database: Db, memberships: TenantMemberDocument[]): Promise<MeTenant[]> {
  const roleByTenantId = new Map<string, MeTenant["role"]>();
  const tenantIds: ObjectId[] = [];

  for (const membership of memberships) {
    const hex = asHexString(membership.tenantId);
    if (hex === null || roleByTenantId.has(hex)) {
      continue;
    }
    roleByTenantId.set(hex, asTenantRole(membership.role));
    tenantIds.push(new ObjectId(hex));
  }

  if (tenantIds.length === 0) {
    return [];
  }

  const documents = await database
    .collection<TenantDocument>(TENANTS_COLLECTION)
    .find({ _id: { $in: tenantIds } })
    .toArray();
  const byId = new Map<string, TenantDocument>();
  for (const document of documents) {
    const hex = asHexString(document._id);
    if (hex !== null) {
      byId.set(hex, document);
    }
  }

  const tenants: MeTenant[] = [];
  for (const [hex, role] of roleByTenantId) {
    const tenant = byId.get(hex);
    if (tenant === undefined) {
      // A membership pointing at a missing tenant document is skipped: the
      // pointer is not a workspace.
      continue;
    }
    tenants.push({
      id: hex,
      slug: asString(tenant.slug, ""),
      name: asString(tenant.name, ""),
      role,
      status: asString(tenant.status, "active"),
    });
  }
  return tenants;
}

/**
 * Assemble the caller's `Me` body (contract §1.2).
 *
 * @param database - The database the caller-scoped collections live in.
 * @param userId - The caller's Better Auth user id (hex).
 * @returns The full §1.2 projection.
 */
export async function buildMe(database: Db, userId: string): Promise<Me> {
  const objectId = new ObjectId(userId);

  const [user, profile, memberships, unreadNotificationCount, pendingInvitationCount] =
    await Promise.all([
      database.collection<UserDocument>(USER_COLLECTION).findOne({ _id: objectId }),
      database
        .collection<UserProfileDocument>(USER_PROFILES_COLLECTION)
        .findOne({ userId: objectId } as never),
      database
        .collection<TenantMemberDocument>(TENANT_MEMBERS_COLLECTION)
        .find({ userId: objectId, status: "active" } as never)
        .toArray(),
      database
        .collection(NOTIFICATIONS_COLLECTION)
        .countDocuments({ userId: objectId, readAt: null }),
      database
        .collection(INVITATIONS_COLLECTION)
        .countDocuments({ "invitee.userId": objectId, status: "pending" }),
    ]);

  const tenants = await loadTenants(database, memberships);

  const platformRole = asPlatformRole(profile?.platformRole);
  const status = asAccountStatus(profile?.status);
  const primaryTenantId = asHexString(profile?.primaryTenantId);

  return {
    id: asHexString(user?._id) ?? userId,
    email: asString(user?.email, ""),
    emailVerified: user?.emailVerified === true,
    phoneNumber: typeof user?.phoneNumber === "string" ? user.phoneNumber : null,
    phoneNumberVerified: user?.phoneNumberVerified === true,
    twoFactorEnabled: user?.twoFactorEnabled === true,
    accountCompletedAt: asIsoString(profile?.accountCompletedAt),
    displayName: typeof profile?.displayName === "string" ? profile.displayName : null,
    avatarUrl: null,
    locale: asString(profile?.locale, DEFAULT_LOCALE),
    timeZone: asString(profile?.timeZone, DEFAULT_TIME_ZONE),
    platformRole,
    status,
    marketingOptIn: profile?.marketingOptIn === true,
    contactCapabilities: asContactCapabilities(profile?.contactCapabilities),
    primaryTenant: tenants.find((tenant) => tenant.id === primaryTenantId) ?? null,
    tenants,
    capabilities: deriveCapabilities({ platformRole, status, tenants }),
    unreadNotificationCount,
    pendingInvitationCount,
    deletionScheduledAt: asIsoString(profile?.deletionScheduledAt),
  };
}
