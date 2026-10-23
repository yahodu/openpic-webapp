import { ObjectId } from "mongodb";

import { ianaTimeZoneSchema } from "@openpic/contracts";

import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute, type HandlerContext } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { platformRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import {
  canPatchTenantField,
  type TenantPatchField,
  type TenantRole,
} from "@/server/tenancy/permissions";
import { tenantPatchSchema, type TenantPatch } from "@/server/tenancy/patch-schema";
import { projectTenant } from "@/server/tenancy/projection";
import { tenantStage } from "@/server/tenancy/route-stage";
import { tenantSchema } from "@/server/tenancy/schema";

/**
 * `GET`/`PATCH /api/v1/tenants/{tenantId}` — one workspace (OP-100, contract
 * §2.1, schema §13.3/§13.4).
 *
 * `GET` powers the organizer dashboard header in one read: the §2.1 DTO with the
 * cached counters (advertising `counters.approximate: true`) and the caller's
 * `myRole`.
 *
 * `PATCH` applies the §2.1 fields through the `@/server/tenancy/permissions`
 * matrix (`owner`|`admin`, `billingContactUserId` owner only) and answers the
 * same DTO. A suspended workspace refuses every write with `423
 * tenant_suspended` before anything is persisted.
 *
 * Both declare the same reusable `tenant` stage, which resolves the `current`
 * alias, authorises membership and echoes `X-Tenant-Id` (contract §0.4). Only
 * the write path asks the stage to provision — a read must never create a
 * billable workspace.
 */

/** A 24-hex ObjectId, the only accepted explicit id shape. */
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

/** Where a client can contact support about a suspended workspace (A.1). */
const SUPPORT_URL = "/support";

/** The resolved workspace scope, guaranteed by the tenant stage. */
interface TenantScope {
  readonly tenantId: ObjectId;
  readonly role: TenantRole;
}

/**
 * Read the scope the tenant stage published, or fail loudly.
 *
 * The stage runs before every handler declared here, so a missing scope is a
 * programming error rather than a client-reachable state.
 */
function requireTenantScope(ctx: HandlerContext): TenantScope {
  const { tenantId, tenantRole } = ctx;
  if (tenantId === undefined || tenantRole === undefined) {
    throw appError("internal_error");
  }
  return { tenantId: new ObjectId(tenantId), role: tenantRole };
}

/** The `user` auth stage, built per request so it reads validated config. */
function userAuth(): ReturnType<typeof requireAuth> {
  return requireAuth("user", { auth: getAuth(), database: getDb() });
}

/** Read a stored tenant document by id through the platform-scope repository. */
async function loadTenant(tenantId: ObjectId): Promise<Record<string, unknown>> {
  const tenant = (await platformRepo()
    .collection(COLLECTIONS.tenants)
    .findOne({ _id: tenantId })) as Record<string, unknown> | null;
  if (tenant === null) {
    throw appError("not_found");
  }
  return tenant;
}

/** A `422 validation_failed` naming one offending field. */
function fieldError(path: string, message: string): ReturnType<typeof appError> {
  return appError("validation_failed", {
    details: { fields: [{ path, code: "invalid", message }] },
  });
}

export const GET = defineRoute({
  route: "/api/v1/tenants/:tenantId",
  response: tenantSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage(),
  handler: async (ctx) => {
    const scope = requireTenantScope(ctx);
    const tenant = await loadTenant(scope.tenantId);
    return { body: projectTenant(tenant, scope.role) };
  },
});

export const PATCH = defineRoute({
  route: "/api/v1/tenants/:tenantId",
  body: tenantPatchSchema,
  response: tenantSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  // A write is the organizer action that provisions the workspace on first use
  // (contract §2.1; ADR-0260 D3).
  tenant: tenantStage({ provisionOnMissing: true }),
  handler: async (ctx) => {
    const scope = requireTenantScope(ctx);
    const repo = platformRepo(getDb());
    const tenant = await loadTenant(scope.tenantId);

    // Suspension blocks the write outright, before any field is touched, so the
    // stored document is provably unchanged (I8; contract A.1).
    if (tenant.status === "suspended") {
      throw appError("tenant_suspended", {
        details: { reason: "suspended", supportUrl: SUPPORT_URL },
      });
    }

    const patch: TenantPatch = ctx.body;
    const settings = patch.settings ?? {};
    const supplied: TenantPatchField[] = [];
    if (patch.name !== undefined) supplied.push("name");
    if (settings.defaultTimeZone !== undefined) supplied.push("settings.defaultTimeZone");
    if (settings.brandLogoAssetId !== undefined) supplied.push("settings.brandLogoAssetId");
    if (settings.defaultWatermarkAssetId !== undefined) {
      supplied.push("settings.defaultWatermarkAssetId");
    }
    if (patch.billingContactUserId !== undefined) supplied.push("billingContactUserId");

    for (const field of supplied) {
      if (!canPatchTenantField(scope.role, field)) {
        throw appError("forbidden");
      }
    }

    const now = systemClock.now();
    const update: Record<string, unknown> = { updatedAt: now };

    if (patch.name !== undefined) {
      update.name = patch.name;
    }

    if (settings.defaultTimeZone !== undefined) {
      if (!ianaTimeZoneSchema.safeParse(settings.defaultTimeZone).success) {
        throw appError("unknown_timezone", { details: { field: "settings.defaultTimeZone" } });
      }
      update["settings.defaultTimeZone"] = settings.defaultTimeZone;
    }

    if (settings.brandLogoAssetId !== undefined) {
      update["settings.brandLogoAssetId"] = toAssetId(
        settings.brandLogoAssetId,
        "settings.brandLogoAssetId"
      );
    }
    if (settings.defaultWatermarkAssetId !== undefined) {
      update["settings.defaultWatermarkAssetId"] = toAssetId(
        settings.defaultWatermarkAssetId,
        "settings.defaultWatermarkAssetId"
      );
    }

    if (patch.billingContactUserId !== undefined) {
      const billingContactUserId = toObjectId(patch.billingContactUserId);
      const membership =
        billingContactUserId === null
          ? null
          : await repo.collection(COLLECTIONS.tenantMembers).findOne({
              tenantId: scope.tenantId,
              userId: billingContactUserId,
              status: "active",
            });
      if (billingContactUserId === null || membership === null) {
        throw appError("invalid_billing_contact");
      }
      update.billingContactUserId = billingContactUserId;
    }

    await repo.collection(COLLECTIONS.tenants).updateOne({ _id: scope.tenantId }, { $set: update });

    const updated = await loadTenant(scope.tenantId);
    return { body: projectTenant(updated, scope.role) };
  },
});

/** Parse a supplied id as an `ObjectId`, or `null` when malformed. */
function toObjectId(value: string): ObjectId | null {
  return OBJECT_ID_HEX.test(value) ? new ObjectId(value) : null;
}

/** Convert a branding asset id (or `null`) for storage. */
function toAssetId(value: string | null, path: string): ObjectId | null {
  if (value === null) {
    return null;
  }
  const objectId = toObjectId(value);
  if (objectId === null) {
    throw fieldError(path, "Must be a 24-hex media asset id or null.");
  }
  return objectId;
}
