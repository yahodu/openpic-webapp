import { z } from "zod";

import { computeExpiringSoon } from "@/server/attendee/my-events";
import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { getDb } from "@/server/db/mongo";
import { buildCursorPage, parsePageQuery } from "@/server/http/cursor";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { crossTenantReads } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";

/**
 * `GET /api/v1/me/events` — the account's own events (OP-134, contract §6.7,
 * §0.4, §0.8; schema §10.3, §15.3; ADR-0815).
 *
 * This is **the** single whitelisted cross-tenant read of the product: "all my
 * events" cannot be answered inside one tenant's boundary. The predicate that
 * decides which rows come back is only `subject.userId === <caller>`, applied
 * through {@link crossTenantReads.findAttendeeEventsBySubjectUser}; the route
 * never builds a filter of its own.
 *
 * Ordering is `updatedAt` descending with the `_id` tiebreaker (schema §15.3's
 * `{"subject.userId":1, updatedAt:-1}`), so the most-recently-touched
 * participation comes first and the §0.8 cursor pages on the same key.
 *
 * Auth is `user` only: an anonymous `op_att` session has no account list.
 */

/** One §6.7 item — exactly the thirteen documented keys. */
const itemSchema = z.object({
  eventId: z.string(),
  eventName: z.string(),
  organizerDisplayName: z.string(),
  startAt: z.iso.datetime().nullable(),
  displayTimeZone: z.string().nullable(),
  slug: z.string(),
  galleryUrl: z.string(),
  coverThumbnailUrl: z.string().nullable(),
  matchCount: z.number().int().nonnegative(),
  newMatchCount: z.number().int().nonnegative(),
  status: z.string(),
  galleryExpiresAt: z.iso.datetime().nullable(),
  expiringSoon: z.boolean(),
});

/** The §6.7 answer: the items and the §0.8 page envelope. */
const myEventsSchema = z.object({
  data: z.array(itemSchema),
  page: z.object({
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
    limit: z.number().int().positive(),
  }),
});

export const GET = defineRoute({
  route: "/api/v1/me/events",
  response: myEventsSchema,
  auth: (ctx, request) => requireAuth("user", { auth: getAuth(), database: getDb() })(ctx, request),
  handler: async (ctx) => {
    const { principal } = ctx;
    if (principal === undefined) {
      // The `user` auth stage always publishes the principal, or denies.
      throw appError("internal_error");
    }

    const { limit, cursor } = parsePageQuery(new URL(ctx.request.url).searchParams);
    const fetched = await crossTenantReads.findAttendeeEventsBySubjectUser(
      principal,
      // One row beyond the page: its presence is the only `hasMore` signal.
      { limit: limit + 1, ...(cursor === null ? {} : { cursor }) },
      getDb()
    );
    const page = buildCursorPage(fetched.items, limit, (item) => ({
      c: item.updatedAt.toISOString(),
      i: item.profileId,
    }));
    const now = systemClock.now();

    return {
      body: {
        data: page.items.map((item) => ({
          eventId: item.eventId,
          eventName: item.eventName,
          organizerDisplayName: item.organizerDisplayName,
          startAt: item.startAt === null ? null : item.startAt.toISOString(),
          displayTimeZone: item.displayTimeZone,
          slug: item.slug,
          galleryUrl: `/e/${item.slug}/gallery`,
          // `events` has no cover-asset pointer yet; a null is the honest answer.
          coverThumbnailUrl: null,
          matchCount: item.matchCount,
          newMatchCount: item.newMatchCount,
          status: item.status,
          galleryExpiresAt:
            item.galleryExpiresAt === null ? null : item.galleryExpiresAt.toISOString(),
          expiringSoon: computeExpiringSoon({ galleryExpiresAt: item.galleryExpiresAt, now }),
        })),
        page: { nextCursor: page.nextCursor, hasMore: page.hasMore, limit },
      },
    };
  },
});
