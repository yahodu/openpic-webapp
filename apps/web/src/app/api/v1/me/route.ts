import { ObjectId, type Db } from "mongodb";

import { ianaTimeZoneSchema } from "@openpic/contracts";

import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { USER_PROFILES_COLLECTION } from "@/server/auth/identity-hooks";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";

import { ME_PATCH_EDITABLE_FIELDS, mePatchSchema } from "@/server/me/patch-schema";
import { buildMe } from "@/server/me/projection";
import { meSchema } from "@/server/me/schema";

/**
 * `GET` and `PATCH /api/v1/me` — the caller's own account (contract §1.2).
 *
 * `GET` is the single bootstrap call: one request returns the full §1.2 body
 * (identity, profile, active memberships, advisory capabilities and the
 * bell/invite counts), assembled by {@link buildMe}. `PATCH` edits the caller's
 * profile fields and returns that same full body; email/phone changes are
 * rejected — they go through Better Auth.
 *
 * Both are guarded with the `user` label. `GET /me` is on the contract §0.3
 * ban-exemption list (`allowBanned`), so a banned user can read why they are
 * banned; `PATCH` is not exempt.
 */

/** The `tenantMembers` collection (schema §13.4). */
const TENANT_MEMBERS_COLLECTION = "tenantMembers";
/** The `mediaAssets` collection (schema §16.1). */
const MEDIA_ASSETS_COLLECTION = "mediaAssets";

/** The branding-class `mediaAssets.kind` values a profile avatar may reference. */
const BRANDING_ASSET_KINDS = ["event_logo", "watermark"] as const;

/** The fields `PATCH /me` may set; every other supplied key is forbidden. */
const EDITABLE_FIELDS: ReadonlySet<string> = new Set<string>(ME_PATCH_EDITABLE_FIELDS);

/** The `422 validation_failed` envelope for an unacceptable `avatarAssetId`. */
function avatarAssetError(): ReturnType<typeof appError> {
  return appError("validation_failed", {
    details: {
      fields: [
        {
          path: "avatarAssetId",
          code: "invalid_asset",
          message: "Must be a branding asset owned by one of your workspaces.",
        },
      ],
    },
  });
}

/**
 * Resolve an `avatarAssetId` to the owned branding asset's ObjectId.
 *
 * Ownership is tenant-scoped (schema §16.1 carries `tenantId`, not a creator):
 * the asset must belong to a workspace the caller is an **active** member of. A
 * malformed id, a foreign asset and a non-existent asset all produce the same
 * `422 validation_failed` naming `avatarAssetId`, so the response never leaks
 * whether a foreign asset exists.
 *
 * @param database - The database to read memberships and assets from.
 * @param userId - The caller's Better Auth user id.
 * @param assetId - The supplied asset id (hex).
 * @returns The asset's ObjectId, ready to store.
 * @throws {AppError} `validation_failed` when the asset is not caller-owned.
 */
async function resolveOwnedAvatar(
  database: Db,
  userId: ObjectId,
  assetId: string
): Promise<ObjectId> {
  if (!ObjectId.isValid(assetId)) {
    throw avatarAssetError();
  }

  const memberships = await database
    .collection(TENANT_MEMBERS_COLLECTION)
    .find({ userId, status: "active" } as never)
    .toArray();
  const tenantIds = memberships
    .map((membership) => (membership as { tenantId?: unknown }).tenantId)
    .filter((tenantId): tenantId is ObjectId => tenantId instanceof ObjectId);

  const assetObjectId = new ObjectId(assetId);
  const asset =
    tenantIds.length === 0
      ? null
      : await database.collection(MEDIA_ASSETS_COLLECTION).findOne({
          _id: assetObjectId,
          tenantId: { $in: tenantIds },
          kind: { $in: [...BRANDING_ASSET_KINDS] },
        } as never);

  if (asset === null) {
    throw avatarAssetError();
  }
  return assetObjectId;
}

/** Return the caller's full §1.2 body behind the `user` guard (ban-exempt). */
export const GET = defineRoute({
  route: "/api/v1/me",
  response: meSchema,
  // Built per request: `getAuth()`/`getDb()` read validated configuration, so
  // evaluating them at module scope would fail `next build`'s page-data
  // collection (which runs without a configured environment).
  auth: (ctx, request) =>
    requireAuth("user", { auth: getAuth(), database: getDb(), allowBanned: true })(ctx, request),
  handler: async (ctx) => {
    const userId = ctx.principal;
    if (userId === undefined) {
      throw appError("authentication_required");
    }
    return { body: await buildMe(getDb(), userId) };
  },
});

/** Apply a profile edit and return the full §1.2 body behind the `user` guard. */
export const PATCH = defineRoute({
  route: "/api/v1/me",
  body: mePatchSchema,
  response: meSchema,
  auth: (ctx, request) => requireAuth("user", { auth: getAuth(), database: getDb() })(ctx, request),
  handler: async (ctx) => {
    const userId = ctx.principal;
    if (userId === undefined) {
      throw appError("authentication_required");
    }

    const supplied: Record<string, unknown> = ctx.body;

    // A key outside the editable set (email/phoneNumber/platformRole and any
    // other server-owned field) may never be supplied here.
    const forbidden = Object.keys(supplied).filter(
      (key) => supplied[key] !== undefined && !EDITABLE_FIELDS.has(key)
    );
    if (forbidden.length > 0) {
      throw appError("forbidden_field", { details: { fields: forbidden } });
    }

    const database = getDb();
    const objectId = new ObjectId(userId);
    const update: Record<string, unknown> = { updatedAt: new Date() };

    if (typeof supplied.displayName === "string") {
      update.displayName = supplied.displayName;
    }
    if (typeof supplied.locale === "string") {
      update.locale = supplied.locale;
    }
    if (typeof supplied.timeZone === "string") {
      if (!ianaTimeZoneSchema.safeParse(supplied.timeZone).success) {
        throw appError("unknown_timezone", { details: { field: "timeZone" } });
      }
      update.timeZone = supplied.timeZone;
    }
    if (typeof supplied.marketingOptIn === "boolean") {
      update.marketingOptIn = supplied.marketingOptIn;
    }
    if (supplied.avatarAssetId === null || typeof supplied.avatarAssetId === "string") {
      update.avatarAssetId =
        supplied.avatarAssetId === null
          ? null
          : await resolveOwnedAvatar(database, objectId, supplied.avatarAssetId);
    }

    await database
      .collection(USER_PROFILES_COLLECTION)
      .updateOne({ userId: objectId }, { $set: update });

    return { body: await buildMe(database, userId) };
  },
});
