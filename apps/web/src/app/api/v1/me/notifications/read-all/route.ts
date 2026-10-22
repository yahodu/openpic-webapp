import { ObjectId, type Document } from "mongodb";
import { z } from "zod";

import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import {
  EXCLUDED_FEED_TYPE_KEYS,
  feedCategoryFor,
  feedTypeKeysForCategories,
} from "@/server/notifications/feed";
import { summarizeUnread } from "@/server/notifications/unread-count";
import { platformRepo } from "@/server/repos";

/**
 * `POST /api/v1/me/notifications/read-all` — mark every matching unread row read
 * (contract §7.1; design §19.4).
 *
 * Guarded with the `user` label and rate class `write.normal`. The body's
 * `before`, `category` and `eventId` are all optional and **AND-ed**:
 * `before` is a strict `createdAt < before` cut (a row created exactly at the
 * instant stays unread), `category` maps to its catalogue `typeKey`s and
 * `eventId` scopes to one event. The answer reports `markedCount` (the rows this
 * call changed) and `unreadCount` (the caller's remaining unread count), so a
 * second call marks nothing and reports `{ markedCount: 0, unreadCount: 0 }`.
 */

/** The optional filter body (all fields AND-ed when supplied). */
const readAllBodySchema = z.object({
  before: z.string().optional(),
  category: z.string().optional(),
  eventId: z.string().optional(),
});

/** The §7.1 `read-all` response, validated strictly (exactly these two fields). */
const readAllResponseSchema = z.object({
  markedCount: z.number().int().nonnegative(),
  unreadCount: z.number().int().nonnegative(),
});

export const POST = defineRoute({
  route: "/api/v1/me/notifications/read-all",
  body: readAllBodySchema,
  response: readAllResponseSchema,
  auth: (ctx, request) => requireAuth("user", { auth: getAuth(), database: getDb() })(ctx, request),
  handler: async (ctx) => {
    const principal = ctx.principal;
    if (principal === undefined) {
      throw appError("authentication_required");
    }

    const db = getDb();
    const userId = new ObjectId(principal);
    const now = new Date();
    const { before, category, eventId } = ctx.body;

    const filter: Document = { userId, readAt: null };

    if (category !== undefined) {
      filter.typeKey = { $in: feedTypeKeysForCategories([category]) };
    }

    if (eventId !== undefined) {
      if (!ObjectId.isValid(eventId)) {
        throw appError("validation_failed", {
          details: {
            fields: [{ path: "eventId", code: "custom", message: "must be a 24-hex ObjectId" }],
          },
        });
      }
      filter.eventId = new ObjectId(eventId);
    }

    if (before !== undefined) {
      const cut = new Date(before);
      if (Number.isNaN(cut.getTime())) {
        throw appError("validation_failed", {
          details: {
            fields: [{ path: "before", code: "custom", message: "must be an ISO-8601 instant" }],
          },
        });
      }
      filter.createdAt = { $lt: cut };
    }

    const updated = await platformRepo(db)
      .collection(COLLECTIONS.notifications)
      .updateMany(filter, { $set: { readAt: now } });

    const summary = await summarizeUnread({
      db,
      userId,
      now,
      excludeTypeKeys: EXCLUDED_FEED_TYPE_KEYS,
      categoryOf: feedCategoryFor,
    });

    return { body: { markedCount: updated.modifiedCount, unreadCount: summary.unreadCount } };
  },
});
