import { z } from "zod";

import { internalAuthStage } from "@/server/auth/internal-hmac";
import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { crossTenantReads, tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";

/**
 * `POST /api/v1/internal/media/derivative-complete` — the thumbnail
 * processor's completion (OP-135, contract §10.3.2, §0.15; schema §16.1;
 * ADR-0829 §5).
 *
 * The processor sends an **opaque handle** (`objectKeyRef`), never an object
 * key: §0.15 keeps object keys server-side. The stored
 * `derivatives.<variant>.objectKey` is derived from the asset's own content
 * hash, so neither the request nor the answer carries it.
 *
 * `thumbnail` and `preview` are two entries of the §16.1 map: reporting one
 * never disturbs the other, and either advances the asset to
 * `derivatives_ready`.
 */

const ROUTE = "/api/v1/internal/media/derivative-complete";

/** The §16.1 derivative variants this report may complete. */
const DERIVATIVE_VARIANTS = ["thumbnail", "preview"] as const;

/**
 * §10.3.2's body. Strict: a body carrying a raw `objectKey` is a contract
 * violation, and an unknown field here is exactly that (§0.15).
 */
const derivativeBodySchema = z.strictObject({
  assetId: z.string().min(1),
  derivative: z.enum(DERIVATIVE_VARIANTS),
  /** The opaque handle. Its resolution is the processor's only key input. */
  objectKeyRef: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  format: z.string().min(1),
  processorVersion: z.number().int().nonnegative(),
  watermarkVersion: z.number().int().nonnegative(),
  contentHash: z.string().min(1),
});

/** The answer carries no key — only the asset's new state (§0.15, ADR-0829 §5). */
const derivativeResponseSchema = z.object({ status: z.literal("derivatives_ready") });

export const POST = defineRoute<
  z.infer<typeof derivativeBodySchema>,
  z.infer<typeof derivativeResponseSchema>
>({
  route: ROUTE,
  body: derivativeBodySchema,
  response: derivativeResponseSchema,
  // The secrets are read through a thunk: `getConfig()` validates the
  // environment, which `next build` runs without.
  auth: (ctx, request) =>
    internalAuthStage({
      internalApiSecret: getConfig().internal.apiSecret,
      cronSecret: getConfig().cron.secret,
    })(ctx, request),
  handler: async (ctx) => {
    const body = ctx.body;
    const db = getDb();
    const asset = await crossTenantReads.findMediaAssetById(body.assetId, db);
    if (asset === null) {
      throw appError("not_found", { details: { resource: "media_asset" } });
    }

    // The key never crosses the wire: it is derived from the asset's identity,
    // and the handle the processor sent is not stored on the asset.
    const locationKey = `${body.derivative}s`;
    await tenantRepo(asset.tenantId, db)
      .collection(COLLECTIONS.mediaAssets)
      .updateOne(
        { _id: asset._id },
        {
          $set: {
            [`derivatives.${body.derivative}`]: {
              locationKey,
              objectKey: `${locationKey}/${body.contentHash}.${body.format}`,
              bytes: body.bytes,
              width: body.width,
              height: body.height,
              format: body.format,
              processorVersion: body.processorVersion,
              watermarkVersion: body.watermarkVersion,
              generatedAt: systemClock.now(),
            },
            status: "derivatives_ready",
          },
        }
      );

    return { body: { status: "derivatives_ready" } };
  },
});
