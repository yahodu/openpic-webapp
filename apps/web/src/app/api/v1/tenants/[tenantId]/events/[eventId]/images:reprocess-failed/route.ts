import { z } from "zod";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { eventActorAdmission } from "@/server/events/access";
import { eventIdFromRequest } from "@/server/events/event-id";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import type { EventImageListRow } from "@/server/images/dto";
import { requeueImages } from "@/server/images/requeue";
import { tenantRepo } from "@/server/repos";
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

    const rows = (await tenantRepo(tenantId, db)
      .collection(COLLECTIONS.eventImages)
      .find({ eventId, deletedAt: null, "processing.status": "failed" })
      .toArray()) as unknown as EventImageListRow[];

    const settings = await getPlatformSettings({ db });
    await requeueImages({
      db,
      tenantKey: tenantId,
      eventId,
      rows,
      now: systemClock.now(),
      spaceKey: settings.face.activeSpaceKey,
      requestId,
    });

    return { status: 202, body: { requeuedCount: rows.length } };
  },
});
