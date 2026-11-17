import { z } from "zod";

import { internalAuthStage } from "@/server/auth/internal-hmac";
import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { buildHeartbeatResponse } from "@/server/internal/worker-heartbeat";
import { platformRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { addDays } from "@/server/runtime/time";
import { getPlatformSettings } from "@/server/settings/platform-settings";

/**
 * `POST /api/v1/internal/worker/heartbeat` — the worker's configuration channel
 * (OP-135, contract §10.3.2; schema §20.4; ADR-0829 §3).
 *
 * The worker reports what it is doing and reads back what it should do: the
 * active face space, the lease length, the attempt ceiling and the operator's
 * pause switch are all `platformSettings` reads, so an operator paces the fleet
 * without a redeploy. The `workerHeartbeats` row it leaves behind is the
 * liveness board `/admin/pipeline/health` reads (§10.3.2).
 */

const ROUTE = "/api/v1/internal/worker/heartbeat";

/** How long a heartbeat row outlives its last report, in days. */
const HEARTBEAT_RETENTION_DAYS = 7;

/** §10.3.2's documented heartbeat body; the response is the real contract. */
const heartbeatBodySchema = z.object({
  workerId: z.string().min(1),
  version: z.string().optional(),
  modelKeys: z.record(z.string(), z.string()).optional(),
  inFlight: z.number().int().nonnegative().optional(),
  capacity: z.number().int().nonnegative().optional(),
  throughputPerMin: z.number().nonnegative().optional(),
  queueDepthObserved: z.record(z.string(), z.number()).optional(),
  gpu: z
    .object({
      present: z.boolean(),
      utilizationPercent: z.number(),
      memoryUsedMb: z.number(),
    })
    .optional(),
});

type HeartbeatBody = z.infer<typeof heartbeatBodySchema>;

/** The five-key configuration channel (§10.3.2). */
const heartbeatResponseSchema = z.object({
  acknowledged: z.literal(true),
  activeSpaceKey: z.string(),
  leaseMinutes: z.number().int(),
  maxAttempts: z.number().int(),
  pauseRequested: z.boolean(),
});

export const POST = defineRoute<HeartbeatBody, z.infer<typeof heartbeatResponseSchema>>({
  route: ROUTE,
  body: heartbeatBodySchema,
  response: heartbeatResponseSchema,
  // The secrets are read through a thunk: `getConfig()` validates the
  // environment, which `next build` runs without.
  auth: (ctx, request) =>
    internalAuthStage({
      internalApiSecret: getConfig().internal.apiSecret,
      cronSecret: getConfig().cron.secret,
    })(ctx, request),
  handler: async (ctx) => {
    const db = getDb();
    const now = systemClock.now();
    const settings = await getPlatformSettings({ db });

    await platformRepo(db)
      .collection(COLLECTIONS.workerHeartbeats)
      .updateOne(
        { workerId: ctx.body.workerId },
        {
          $set: {
            ...ctx.body,
            lastSeenAt: now,
            expireAt: addDays(now, HEARTBEAT_RETENTION_DAYS),
          },
          $setOnInsert: { firstSeenAt: now },
        },
        { upsert: true }
      );

    return {
      body: buildHeartbeatResponse({
        activeSpaceKey: settings.face.activeSpaceKey,
        leaseMinutes: settings.pipeline.leaseMinutes,
        maxAttempts: settings.pipeline.maxAttempts,
        pauseRequested: settings.pipeline.pauseRequested,
      }),
    };
  },
});
