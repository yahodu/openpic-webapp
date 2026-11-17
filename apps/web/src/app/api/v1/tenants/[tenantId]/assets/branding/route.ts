import { ObjectId } from "mongodb";

import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { getDb } from "@/server/db/mongo";
import { defineRoute, type HandlerContext } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { acceptBrandingUpload } from "@/server/media/branding-upload";
import { brandingUploadResponseSchema } from "@/server/media/branding-schema";
import { tenantStage } from "@/server/tenancy/route-stage";

/**
 * `POST /api/v1/tenants/{tenantId}/assets/branding` (OP-114, API contract
 * §2.1 — "the one byte-accepting endpoint").
 *
 * Accepts exactly one `multipart/form-data` upload (`file`, ≤ 2 MiB,
 * png | jpeg | webp | svg **by magic bytes**, never by file name or declared
 * Content-Type), stores the content-addressed object under the tenant's
 * `branding` location, records the `mediaAssets` row and answers
 * `201 { assetId, kind, url, bytes }` with a signed `/t/` media URL.
 *
 * This route is the lone exemption from the JSON content-type rule: it
 * declares **no** `body` schema, so the pipeline never calls
 * `parseJsonBody` and the handler reads the multipart stream itself via
 * `ctx.request.formData()`. Authorization is owner|admin through the
 * reusable tenant stage (a `member` is refused `403 forbidden`, a non-member
 * `404 not_found` by the stage).
 */

/** The `user` auth stage, built per request so it reads validated config. */
function userAuth(): ReturnType<typeof requireAuth> {
  return requireAuth("user", { auth: getAuth(), database: getDb() });
}

/** The resolved workspace scope, guaranteed by the tenant stage. */
interface TenantScope {
  readonly tenantId: ObjectId;
  readonly role: "owner" | "admin" | "member";
}

/** Read the scope the tenant stage published, or fail loudly. */
function requireTenantScope(ctx: HandlerContext): TenantScope {
  const { tenantId, tenantRole } = ctx;
  if (tenantId === undefined || tenantRole === undefined) {
    throw appError("internal_error");
  }
  return { tenantId: new ObjectId(tenantId), role: tenantRole };
}

export const POST = defineRoute({
  route: "/api/v1/tenants/:tenantId/assets/branding",
  // No `body` schema — the JSON content-type exemption (§2.1); the handler
  // parses the multipart stream itself.
  response: brandingUploadResponseSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage(),
  handler: async (ctx) => {
    const scope = requireTenantScope(ctx);
    if (scope.role !== "owner" && scope.role !== "admin") {
      throw appError("forbidden");
    }

    const result = await acceptBrandingUpload({
      tenantId: scope.tenantId.toHexString(),
      request: ctx.request,
      route: ctx.route,
    });
    return { status: 201, body: result };
  },
});
