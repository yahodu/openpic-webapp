import { ObjectId, type Document } from "mongodb";

import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { buildCursorPage, decodeCursor } from "@/server/http/cursor";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import {
  EXCLUDED_FEED_TYPE_KEYS,
  FEED_DEFAULT_LIMIT,
  FEED_MAX_LIMIT,
  feedCategoryFor,
  feedResponseSchema,
  feedTypeKeysForCategories,
  projectFeedItem,
  resolveFeedWindow,
  type FeedFilter,
  type StoredFeedRow,
} from "@/server/notifications/feed";
import { buildLiveNotificationFilter, summarizeUnread } from "@/server/notifications/unread-count";
import { platformRepo } from "@/server/repos";

/**
 * `GET /api/v1/me/notifications` — the in-app feed (contract §7.1; design §19.4,
 * §21).
 *
 * Guarded with the `user` label and rate class `read.normal`. One cursor page of
 * the caller's rows, filtered by a `createdAt` band (`active` | `unread` |
 * `all` | `archived`), by repeatable `category` and/or `eventId`, plus the
 * `summary` the shell renders without a second call. Rows are projected to the
 * exact §7.1 shape (`title`/`body` verbatim, `category` denormalised) and the
 * `auth.otp.*` types are never listed (defence in depth).
 *
 * Input fallbacks are explicit (ADR-0131): a non-positive or non-numeric
 * `limit` falls back to `20` and an unknown `filter` to `active` — never a
 * `400`.
 */

/** A numeric `limit` value: a plain, non-negative decimal integer. */
const DECIMAL_INTEGER = /^\d+$/;

/**
 * Parse the `filter` query value, defaulting to `active`.
 *
 * @param raw - The raw query value.
 * @returns One of the four bands.
 */
function parseFeedFilter(raw: string | null): FeedFilter {
  return raw === "unread" || raw === "all" || raw === "archived" ? raw : "active";
}

/**
 * Parse the `limit` query value, defaulting to `20` and clamping to `50`.
 *
 * A non-numeric, non-positive or absent value falls back to the default rather
 * than failing the request (contract §7.1).
 *
 * @param raw - The raw query value.
 * @returns The effective, bounded page size.
 */
function parseFeedLimit(raw: string | null): number {
  if (raw === null || !DECIMAL_INTEGER.test(raw)) {
    return FEED_DEFAULT_LIMIT;
  }
  const parsed = Number(raw);
  if (parsed < 1) {
    return FEED_DEFAULT_LIMIT;
  }
  return Math.min(parsed, FEED_MAX_LIMIT);
}

/**
 * Parse the `window` query value into a positive day count.
 *
 * @param raw - The raw query value.
 * @returns The day count, or `null` when absent/non-positive/non-numeric.
 */
function parseWindowDays(raw: string | null): number | null {
  if (raw === null || !DECIMAL_INTEGER.test(raw)) {
    return null;
  }
  const parsed = Number(raw);
  return parsed > 0 ? parsed : null;
}

/**
 * The `createdAt` part of a cursor key.
 *
 * The driver's `Document` is `any`-valued, so the two cursor fields are funnelled
 * through these narrow helpers rather than read off the row directly.
 *
 * @param value - The stored instant.
 * @returns Its ISO-8601 rendering.
 */
function cursorInstant(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

/**
 * The `_id` part of a cursor key.
 *
 * @param value - The stored id.
 * @returns Its hex rendering.
 */
function cursorId(value: unknown): string {
  return value instanceof ObjectId ? value.toHexString() : String(value);
}

export const GET = defineRoute({
  route: "/api/v1/me/notifications",
  response: feedResponseSchema,
  auth: (ctx, request) => requireAuth("user", { auth: getAuth(), database: getDb() })(ctx, request),
  handler: async (ctx) => {
    const principal = ctx.principal;
    if (principal === undefined) {
      throw appError("authentication_required");
    }

    const db = getDb();
    const userId = new ObjectId(principal);
    const params = new URL(ctx.request.url).searchParams;
    const now = new Date();

    const filter = parseFeedFilter(params.get("filter"));
    const limit = parseFeedLimit(params.get("limit"));
    const categories = params.getAll("category");
    const rawEventId = params.get("eventId");
    const rawCursor = params.get("cursor");
    const window = resolveFeedWindow({
      filter,
      now,
      windowDays: parseWindowDays(params.get("window")),
    });

    const typeKeyFilter: Document = { $nin: [...EXCLUDED_FEED_TYPE_KEYS] };
    if (categories.length > 0) {
      typeKeyFilter.$in = feedTypeKeysForCategories(categories);
    }

    const createdAtFilter: Document = { $gte: window.from };
    if (window.to !== null) {
      createdAtFilter.$lt = window.to;
    }

    // The TTL bound is the one the unread count applies
    // (`buildUnreadCountFilter`), reused rather than re-spelled so the list and
    // the badge agree about a row the TTL monitor has not swept yet (F3).
    const match: Document = {
      userId,
      typeKey: typeKeyFilter,
      createdAt: createdAtFilter,
      ...buildLiveNotificationFilter(now),
    };
    if (filter === "unread") {
      // The `unread` band is the whole 90-day horizon *restricted to unread rows*;
      // the other three bands differ only by their `createdAt` window.
      match.readAt = null;
    }

    if (rawEventId !== null) {
      if (!ObjectId.isValid(rawEventId)) {
        throw appError("validation_failed", {
          details: {
            fields: [
              {
                path: "eventId",
                code: "custom",
                message: "must be a 24-hex ObjectId",
              },
            ],
          },
        });
      }
      match.eventId = new ObjectId(rawEventId);
    }

    // The cursor continues on `createdAt` + `_id` so a `createdAt` tie never
    // skips or repeats a row (contract §0.8).
    let pageMatch: Document = match;
    if (rawCursor !== null) {
      const cursor = decodeCursor(rawCursor);
      const cursorCreatedAt = new Date(cursor.c);
      const cursorId = new ObjectId(cursor.i);
      pageMatch = {
        ...match,
        $or: [
          { createdAt: { $lt: cursorCreatedAt } },
          { createdAt: cursorCreatedAt, _id: { $lt: cursorId } },
        ],
      };
    }

    const notifications = platformRepo(db).collection(COLLECTIONS.notifications);

    const [rows, summary] = await Promise.all([
      notifications
        .find(pageMatch)
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit + 1)
        .toArray(),
      summarizeUnread({
        db,
        userId,
        now,
        excludeTypeKeys: EXCLUDED_FEED_TYPE_KEYS,
        categoryOf: feedCategoryFor,
      }),
    ]);

    const page = buildCursorPage(rows, limit, (row) => ({
      c: cursorInstant(row.createdAt),
      i: cursorId(row._id),
    }));

    return {
      body: {
        data: page.items.map((row) => projectFeedItem(row as unknown as StoredFeedRow)),
        page: { nextCursor: page.nextCursor, hasMore: page.hasMore, limit },
        summary: { unreadCount: summary.unreadCount, unreadByCategory: summary.byCategory },
      },
    };
  },
});
