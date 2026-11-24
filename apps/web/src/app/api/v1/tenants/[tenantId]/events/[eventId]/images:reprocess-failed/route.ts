import { ObjectId } from "mongodb";
import { z } from "zod";

import { getDb } from "@/server/db/mongo";
import { eventActorAdmission, requirePrincipal } from "@/server/events/access";
import { eventIdFromRequest } from "@/server/events/event-id";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { retryFailedEventImages } from "@/server/images/retry-failed";
import { requestLogger } from "@/server/logging";
import { systemClock } from "@/server/runtime/clock";
import { getPlatformSettings } from "@/server/settings/platform-settings";
import { userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";

/**
 * `POST …/images:reprocess-failed` — retry the event's failed images (OP-127 I4,
 * contract §4.4).
 *
 * The bulk twin of the single-image route: only this event's `failed` images are
 * reset and re-enqueued (another event's failures of the same tenant are not
 * touched), and the answer is the contract's exact `{ requeuedCount }`. It is
 * the action target of `upload.batch.completed_with_errors`.
 *
 * The handler is a thin delegate to {@link retryFailedEventImages} (ADR-0777
 * D6): the work — and the same admission rule this route's middleware applies —
 * lives in the service, so a §7.3 delegate can reach it without a `Request`. The
 * wire contract does not move.
 */

/** The contract's bulk answer. */
const reprocessFailedSchema = z.object({
  requeuedCount: z.number().int().nonnegative(),
});

export const POST = defineRoute({
  route: "/api/v1/tenants/:tenantId/events/:eventId/images:reprocess-failed",
  response: reprocessFailedSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage({ admission: eventActorAdmission(2) }),
  handler: async (ctx) => {
    const db = getDb();
    const { tenantId, requestId } = ctx;
    if (tenantId === undefined) {
      throw appError("internal_error");
    }
    const eventId = eventIdFromRequest(ctx.request, { segmentFromEnd: 2 });

    const body = await retryFailedEventImages({
      db,
      // The stage publishes the workspace as a hex string; the service takes the id.
      tenantId: new ObjectId(tenantId),
      eventId,
      actorUserId: requirePrincipal(ctx),
      spaceKey: (await getPlatformSettings({ db })).face.activeSpaceKey,
      requestId,
      now: systemClock.now(),
      logger: requestLogger(ctx.request, { route: ctx.route }),
    });

    return { status: 202, body };
  },
});
