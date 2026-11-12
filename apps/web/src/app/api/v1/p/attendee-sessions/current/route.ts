import type { Db, ObjectId } from "mongodb";
import { z } from "zod";

import {
  attendeeTokenFrom,
  createAttendeeSessionResolver,
  findAttendeeSession,
} from "@/server/attendee/session-resolver";
import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { platformRepo } from "@/server/repos";

/**
 * `GET /api/v1/p/attendee-sessions/current` — the attendee's own session
 * (OP-129, contract §1.5; ADR-0780, ADR-0781).
 *
 * Guarded with the `attendee` label, which admits the `op_att` cookie, the
 * `X-Attendee-Session` header **or** a signed-in user. The body carries the
 * facts an attendee UI needs — the session id, `kind: "anonymous"`, the bound
 * event slugs, the claim state and the expiry — and never the raw token: §0.15
 * allows a bearer token only in the response that issued it.
 *
 * The row is read a second time here (the auth stage already resolved it)
 * because the OP-86 principal deliberately carries only the session id, and
 * widening that port would touch every guard consumer. One extra indexed
 * `tokenHash` lookup per session read is the cheaper trade.
 */

/** The §1.5 current response — exactly five keys. */
const currentSessionSchema = z.object({
  id: z.string(),
  kind: z.literal("anonymous"),
  eventSlugs: z.array(z.string()),
  claimedByUserId: z.string().nullable(),
  expiresAt: z.string(),
});

/** The `events` fields the slug projection reads (schema §15.1). */
interface EventSlugRow {
  readonly accessLinks?: readonly { readonly slug?: unknown }[];
}

/**
 * The public slugs of the events an attendee session is bound to.
 *
 * @param db - The database to read `events` from.
 * @param eventIds - The row's `eventIds`.
 * @returns The slugs, in `eventIds` order; `[]` when nothing is bound.
 */
async function eventSlugsFor(db: Db, eventIds: readonly ObjectId[]): Promise<string[]> {
  if (eventIds.length === 0) {
    return [];
  }
  const events = (await platformRepo(db)
    .collection(COLLECTIONS.events)
    .find({ _id: { $in: [...eventIds] } }, { projection: { accessLinks: 1 } })
    .toArray()) as EventSlugRow[];

  return events
    .map((event) => event.accessLinks?.[0]?.slug)
    .filter((slug): slug is string => typeof slug === "string");
}

export const GET = defineRoute({
  route: "/api/v1/p/attendee-sessions/current",
  response: currentSessionSchema,
  // Built per request: `getAuth()`/`getDb()` read validated configuration, so
  // evaluating them at module scope would fail `next build`'s page-data
  // collection (which runs without a configured environment).
  auth: (ctx, request) => {
    const database = getDb();
    return requireAuth("attendee", {
      auth: getAuth(),
      database,
      attendeeResolver: createAttendeeSessionResolver({ database }),
    })(ctx, request);
  },
  handler: async (ctx) => {
    const db = getDb();
    const token = attendeeTokenFrom(ctx.request);
    // A signed-in user satisfies the `attendee` label without holding a
    // session; §1.5 describes only the anonymous body.
    if (token === null) {
      throw appError("authentication_required");
    }
    const session = await findAttendeeSession({ database: db }, token);
    if (session === null) {
      throw appError("authentication_required");
    }

    return {
      body: {
        id: session._id.toHexString(),
        kind: "anonymous" as const,
        eventSlugs: await eventSlugsFor(db, session.eventIds),
        claimedByUserId:
          session.claimedByUserId === null ? null : session.claimedByUserId.toHexString(),
        expiresAt: session.expireAt.toISOString(),
      },
    };
  },
});
