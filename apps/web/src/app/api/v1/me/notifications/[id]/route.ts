import { ObjectId } from "mongodb";
import { z } from "zod";

import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { platformRepo } from "@/server/repos";

import { notificationIdFromRequest } from "../_lib/notification-id";

/**
 * `DELETE /api/v1/me/notifications/{id}` — remove one row from the caller's feed
 * (contract §7.1; design §19.4).
 *
 * Guarded with the `user` label and rate class `write.normal`. The row is
 * deleted from the caller's feed only; the `notificationDispatches` audit ledger
 * is an independent record and is never touched. An unknown, malformed or
 * **foreign** id is `404 not_found` (never `403`).
 */

/** The `204` body placeholder: the pipeline serves no body for this status. */
const noContentSchema = z.null();

export const DELETE = defineRoute({
  route: "/api/v1/me/notifications/:id",
  response: noContentSchema,
  auth: (ctx, request) => requireAuth("user", { auth: getAuth(), database: getDb() })(ctx, request),
  handler: async (ctx) => {
    const principal = ctx.principal;
    if (principal === undefined) {
      throw appError("authentication_required");
    }

    const notificationId = notificationIdFromRequest(ctx.request, 1);
    if (notificationId === null) {
      throw appError("not_found", { details: { resource: "notification" } });
    }

    const result = await platformRepo(getDb())
      .collection(COLLECTIONS.notifications)
      .deleteOne({ _id: notificationId, userId: new ObjectId(principal) });

    if (result.deletedCount === 0) {
      throw appError("not_found", { details: { resource: "notification" } });
    }

    return { status: 204, body: null };
  },
});
