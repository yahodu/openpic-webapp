import { z } from "zod";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { requireTenantScope, userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";

/**
 * `GET /api/v1/tenants/{tenantId}/billing/invoices/{invoiceNumber}` — download a
 * stored invoice (OP-110, contract §3.4; ADR-0480).
 *
 * Owner **or** admin (§3.4). When no stored asset carries the number the route
 * answers `404 not_found`; the stored asset's home and its signing scheme are an
 * **open question** on this lane (invoice PDF generation is out of scope), so
 * the route serves the asset the workspace storage already holds.
 *
 * The §3.4 role gate lives in the handler: a plain `member` is `403` and a
 * non-member is the tenant stage's uniform `404`.
 */

/** The signed URL's validity window (§3.4: fifteen minutes). */
const SIGNED_URL_TTL_MS = 15 * 60 * 1000;

/** The §3.4 invoice download payload. */
const invoiceDownloadSchema = z.object({
  invoiceNumber: z.string(),
  downloadUrl: z.string(),
  expiresAt: z.string(),
});

/** The stored invoice asset fields the route reads. */
const invoiceAssetSchema = z.object({
  invoiceNumber: z.string(),
  url: z.string().min(1),
});

/** The `{invoiceNumber}` segment of the matched path, or `""`. */
function invoiceNumberFromRequest(request: Request): string {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  return decodeURIComponent(segments[segments.length - 1] ?? "");
}

export const GET = defineRoute({
  route: "/api/v1/tenants/:tenantId/billing/invoices/:invoiceNumber",
  response: invoiceDownloadSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage(),
  handler: async (ctx) => {
    const scope = requireTenantScope(ctx);
    if (scope.role !== "owner" && scope.role !== "admin") {
      throw appError("forbidden");
    }

    const invoiceNumber = invoiceNumberFromRequest(ctx.request);
    const asset = await tenantRepo(scope.tenantId.toHexString(), getDb())
      .collection(COLLECTIONS.mediaAssets)
      .findOne({ kind: "invoice", invoiceNumber });

    const parsed = asset === null ? null : invoiceAssetSchema.safeParse(asset);
    if (!parsed?.success) {
      throw appError("not_found", { details: { invoiceNumber } });
    }

    return {
      status: 200,
      body: {
        invoiceNumber: parsed.data.invoiceNumber,
        downloadUrl: parsed.data.url,
        expiresAt: new Date(systemClock.now().getTime() + SIGNED_URL_TTL_MS).toISOString(),
      },
    };
  },
});
