import { ObjectId } from "mongodb";
import { z } from "zod";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute, type HandlerContext } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { getLogger } from "@/server/logging";
import { platformRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { memberMutationSchema } from "@/server/tenancy/member-schema";
import type { MembershipDocument } from "@/server/tenancy/members";
import { asTenantRole } from "@/server/tenancy/permissions";
import { requireTenantScope, userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";

/**
 * `PATCH`/`DELETE /api/v1/tenants/{tenantId}/members/{userId}` — re-role or
 * remove one workspace member (OP-101, contract §2.2).
 *
 * Both verbs are **owner only**: an `admin`/`member` caller is `403 forbidden`.
 * The workspace owner is protected — re-roling or removing them is
 * `409 cannot_demote_owner` (§2.2, Appendix A.5) — and the stored row is left
 * untouched, so the refusal is total.
 *
 * `PATCH` sets the role and answers the updated member. `DELETE` is a **soft**
 * removal (`status: "removed"`, `removedAt`) that answers `204`; the row stays
 * as history, and because the reusable tenant stage re-reads `tenantMembers`
 * per request, the removed member's very next request is denied.
 *
 * A target id with no membership in this workspace is `404 not_found` (never
 * `403`), so the endpoint cannot confirm ids it does not hold (contract §0.4).
 */

/** A 24-hex ObjectId, the only accepted `{userId}` shape. */
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

/** The `PATCH` body: the two roles an owner may assign (§2.2). */
const memberRoleBodySchema = z.object({ role: z.enum(["admin", "member"]) });

/** The `204` body placeholder: the pipeline serves no body for this status. */
const noContentSchema = z.null();

/** The `{userId}` segment of the matched path; a malformed id denies `404`. */
function targetUserIdFromRequest(request: Request): ObjectId {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  const raw = segments.at(-1) ?? "";
  if (!OBJECT_ID_HEX.test(raw)) {
    throw appError("not_found");
  }
  return new ObjectId(raw);
}

/** The workspace scope, the caller's owner gate and the target membership. */
interface MemberTarget {
  readonly tenantId: ObjectId;
  readonly targetUserId: ObjectId;
  readonly membership: MembershipDocument;
}

/**
 * Resolve the caller, the target membership and the owner gate for both verbs.
 *
 * The gate order is deliberate: the caller's role is checked first (owner only),
 * then the target id is validated, then the membership is loaded. A missing
 * membership is `404 not_found`; an owner target is `409 cannot_demote_owner`.
 */
async function resolveMemberTarget(ctx: HandlerContext): Promise<MemberTarget> {
  const scope = requireTenantScope(ctx);
  if (scope.role !== "owner") {
    throw appError("forbidden");
  }

  const targetUserId = targetUserIdFromRequest(ctx.request);

  const membership = (await platformRepo(getDb())
    .collection(COLLECTIONS.tenantMembers)
    .findOne({ tenantId: scope.tenantId, userId: targetUserId })) as MembershipDocument | null;
  if (membership === null) {
    throw appError("not_found");
  }

  if (asTenantRole(membership.role) === "owner") {
    throw appError("cannot_demote_owner");
  }

  return { tenantId: scope.tenantId, targetUserId, membership };
}

export const PATCH = defineRoute({
  route: "/api/v1/tenants/:tenantId/members/:userId",
  body: memberRoleBodySchema,
  response: memberMutationSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage(),
  handler: async (ctx) => {
    const { tenantId, targetUserId } = await resolveMemberTarget(ctx);
    const role = ctx.body.role;

    await platformRepo(getDb())
      .collection(COLLECTIONS.tenantMembers)
      .updateOne(
        { tenantId, userId: targetUserId },
        { $set: { role, updatedAt: systemClock.now() } }
      );

    getLogger().info("member role changed", {
      event: "member.role_changed",
      tenantId: tenantId.toHexString(),
      userId: targetUserId.toHexString(),
      role,
    });

    return { body: { userId: targetUserId.toHexString(), role } };
  },
});

export const DELETE = defineRoute({
  route: "/api/v1/tenants/:tenantId/members/:userId",
  response: noContentSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage(),
  handler: async (ctx) => {
    const { tenantId, targetUserId } = await resolveMemberTarget(ctx);

    await platformRepo(getDb())
      .collection(COLLECTIONS.tenantMembers)
      .updateOne(
        { tenantId, userId: targetUserId },
        { $set: { status: "removed", removedAt: systemClock.now(), updatedAt: systemClock.now() } }
      );

    getLogger().info("member removed", {
      event: "member.removed",
      tenantId: tenantId.toHexString(),
      userId: targetUserId.toHexString(),
    });

    return { status: 204, body: null };
  },
});
