import { z } from "zod";

import { defineRoute } from "@/server/http/define-route";
import { getPlatformSettings } from "@/server/settings/platform-settings";
import { MAX_BATCH_FILES } from "@/server/uploads/batch-resolve";
import { PART_SIZE_BYTES } from "@/server/uploads/multipart";
import { PRESIGN_TTL_SECONDS } from "@/server/uploads/single-put";
import { userAuth } from "@/server/tenancy/route-scope";

/**
 * `GET /api/v1/uploads/config` — the fixed upload parameters (OP-123, contract
 * §5.1.1; ADR-0701).
 *
 * Uppy's `shouldUseMultipart` and the client's hashing worker read this so the
 * thresholds, the MIME allow-list, the batch ceiling and the presign TTL are a
 * settings change rather than a frontend deploy. The three tunables come from
 * the `platformSettings.upload` singleton; the rest are the contract's fixed
 * values. The answer is `private, max-age=300` — one caller's settings, five
 * minutes (§5.1.1).
 */

/** The §5.1.1 body: exactly the eight parameters the client may read. */
const uploadConfigSchema = z.object({
  multipartThresholdBytes: z.number().int().positive(),
  partSizeBytes: z.number().int().positive(),
  maxFileBytes: z.number().int().positive(),
  maxBatchSize: z.number().int().positive(),
  supportedMimeTypes: z.array(z.string().min(1)),
  presignTtlSeconds: z.number().int().positive(),
  maxConcurrentParts: z.number().int().positive(),
  hashAlgorithm: z.literal("sha256"),
});

/** The §5.1.1 cache policy: private, five minutes. */
const CACHE_CONTROL = "private, max-age=300";

/** The concurrent part uploads Uppy should run (§5.1.1). */
const MAX_CONCURRENT_PARTS = 4;

export const GET = defineRoute({
  route: "/api/v1/uploads/config",
  response: uploadConfigSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  handler: async () => {
    const { upload } = await getPlatformSettings();

    return {
      body: {
        multipartThresholdBytes: upload.multipartThresholdBytes,
        partSizeBytes: PART_SIZE_BYTES,
        maxFileBytes: upload.maxFileBytes,
        maxBatchSize: MAX_BATCH_FILES,
        supportedMimeTypes: upload.supportedMimeTypes,
        presignTtlSeconds: PRESIGN_TTL_SECONDS,
        maxConcurrentParts: MAX_CONCURRENT_PARTS,
        hashAlgorithm: "sha256" as const,
      },
      headers: { "cache-control": CACHE_CONTROL },
    };
  },
});
