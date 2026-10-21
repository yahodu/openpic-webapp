import { ObjectId } from "mongodb";
import { z } from "zod";

import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { ifNoneMatchSatisfied } from "@/server/http/etag";
import { EXCLUDED_FEED_TYPE_KEYS, feedCategoryFor } from "@/server/notifications/feed";
import { notificationSeveritySchema } from "@/server/notifications/notification-types";
import { composeUnreadEtag, summarizeUnread } from "@/server/notifications/unread-count";
import { getPlatformSettings } from "@/server/settings/platform-settings";

/**
 * `GET /api/v1/me/notifications/unread-count` — the polled badge (contract §7.2;
 * design §19.4, §21, §22).
 *
 * Guarded with the `user` label and rate class `read.hot`. The count, its
 * per-category breakdown and the highest severity are read with one aggregation
 * over the **partial** index `idx_user_unread` (`readAt: null`), and the answer
 * is cacheable: the weak `ETag`
 * `W/"<count>-<severity|none>-<epochSeconds>"` revalidates a matching
 * `If-None-Match` into a bodyless `304`, and every response is `no-store` (the
 * badge must never be served stale from a shared cache).
 *
 * Rows the TTL monitor has not yet swept, and `auth.otp.*` rows stored by a
 * bug, are excluded from both the count and the breakdown.
 */

/** The §7.2 response body, validated strictly (exactly these five fields). */
const unreadCountResponseSchema = z.object({
  unreadCount: z.number().int().nonnegative(),
  byCategory: z.record(z.string(), z.number().int().nonnegative()),
  highestSeverity: notificationSeveritySchema.nullable(),
  pollIntervalSeconds: z.number().int().positive(),
  serverTime: z.string(),
});

export const GET = defineRoute({
  route: "/api/v1/me/notifications/unread-count",
  response: unreadCountResponseSchema,
  auth: (ctx, request) => requireAuth("user", { auth: getAuth(), database: getDb() })(ctx, request),
  handler: async (ctx) => {
    const principal = ctx.principal;
    if (principal === undefined) {
      throw appError("authentication_required");
    }

    const db = getDb();
    const userId = new ObjectId(principal);
    const now = new Date();

    const [settings, summary] = await Promise.all([
      getPlatformSettings({ db }),
      summarizeUnread({
        db,
        userId,
        now,
        excludeTypeKeys: EXCLUDED_FEED_TYPE_KEYS,
        categoryOf: feedCategoryFor,
      }),
    ]);

    const etag = composeUnreadEtag({
      unreadCount: summary.unreadCount,
      highestSeverity: summary.highestSeverity,
      epochSeconds: summary.epochSeconds,
    });

    if (ifNoneMatchSatisfied(ctx.request, etag)) {
      return { status: 304, body: null, headers: { etag } };
    }

    return {
      body: {
        unreadCount: summary.unreadCount,
        byCategory: summary.byCategory,
        highestSeverity: summary.highestSeverity,
        pollIntervalSeconds: settings.notifications.pollIntervalSeconds,
        serverTime: now.toISOString(),
      },
      headers: { etag },
    };
  },
});
