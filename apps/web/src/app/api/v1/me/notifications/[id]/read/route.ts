import { ObjectId } from "mongodb";
import { z } from "zod";

import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { platformRepo } from "@/server/repos";

import { notificationIdFromRequest } from "../../_lib/notification-id";

/**
 * `POST /api/v1/me/notifications/{id}/read` — mark one feed row read
 * (contract §7.1; design §19.4).
 *
 * Guarded with the `user` label and rate class `write.normal`. The caller's own
 * row is marked read (`204`), and the operation is idempotent: the `readAt: null`
 * filter means a second call changes nothing but still answers `204`. An
 * unknown, malformed or **foreign** id is `404 not_found` — never `403`, so the
 * endpoint is not an existence oracle (the `me/sessions` precedent).
 */

/** The `204` body placeholder: the pipeline serves no body for this status. */
const noContentSchema = z.null();

export const POST = defineRoute({
  route: "/api/v1/me/notifications/:id/read",
  response: noContentSchema,
  auth: (ctx, request) => requireAuth("user", { auth: getAuth(), database: getDb() })(ctx, request),
  handler: async (ctx) => {
    const principal = ctx.principal;
    if (principal === undefined) {
      throw appError("authentication_required");
    }

    const notificationId = notificationIdFromRequest(ctx.request, 2);
    if (notificationId === null) {
      throw appError("not_found", { details: { resource: "notification" } });
    }

    const userId = new ObjectId(principal);
    const notifications = platformRepo(getDb()).collection(COLLECTIONS.notifications);

    // Ownership is part of the filter, so a foreign row is indistinguishable
    // from a missing one.
    const existing = await notifications.findOne({ _id: notificationId, userId });
    if (existing === null) {
      throw appError("not_found", { details: { resource: "notification" } });
    }

    await notifications.updateOne(
      { _id: notificationId, userId, readAt: null },
      { $set: { readAt: new Date() } }
    );

    return { status: 204, body: null };
  },
});
