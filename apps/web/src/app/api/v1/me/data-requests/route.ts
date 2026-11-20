import { ObjectId, type Db } from "mongodb";
import { z } from "zod";

import { findRequestAttendeeSession } from "@/server/attendee/session-resolver";
import { getAuth } from "@/server/auth";
import { enforceAuth, requireAuth, resolvePrincipal } from "@/server/auth/guards";
import {
  DSR_REGULATIONS,
  DSR_REQUEST_TYPES,
  computeSlaDueAt,
  resolveAttendeeScope,
  resolveRegulation,
  type TenantDataRegion,
} from "@/server/compliance/data-request";
import { isoOf } from "@/server/compliance/serialize";
import { getRateLimitConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { buildCursorPage, parsePageQuery } from "@/server/http/cursor";
import { defineRoute, type RouteStage } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { idempotencyStage, mongoIdempotencyStore } from "@/server/idempotency";
import { requestLogger } from "@/server/logging";
import { createRateLimiter, rateLimitStage } from "@/server/rate-limit";
import { platformRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { getPlatformSettings } from "@/server/settings/platform-settings";

import { acknowledgementFor } from "./_lib/acknowledgement";

/**
 * `GET` / `POST /api/v1/me/data-requests` — file a data-subject request and read
 * the caller's own (OP-138, contract §8.1, schema §20.3; ADR-0898).
 *
 * A DSR is the one request a user cannot be refused, so the create route is
 * deliberately wider than its siblings: a signed-in **user or** an anonymous
 * **attendee** may file, and §0.3's ban exemption (`allowBanned`) keeps a
 * suspended account able to exercise a statutory right.
 *
 * The filing budget is contract §8.1's "5 / day / principal". The response is
 * `202` with exactly the six receipt keys, the deadline comes from
 * `platformSettings.compliance.slaDays`, and each accepted create writes one
 * `dataSubjectRequests` row plus one `privacy.dsr.received` outbox event — the
 * acknowledgement is the evidence, never the note text.
 */

/** The registered collection (schema §20.3). */
const REQUESTS = COLLECTIONS.dataSubjectRequests;

/** The outbox event a filed request announces (contract §7.6). */
const DSR_EVENT_KEY = "privacy.dsr.received";

/** The §8.1 receipt shape — exactly six keys. */
const receiptSchema = z.object({
  id: z.string(),
  requestType: z.string(),
  status: z.string(),
  slaDueAt: z.iso.datetime(),
  acknowledgement: z.string(),
  pollUrl: z.string(),
});

/** The create body (contract §8.1). */
const createBodySchema = z.object({
  requestType: z.enum(DSR_REQUEST_TYPES),
  regulation: z.enum(DSR_REGULATIONS).optional(),
  scope: z.object({ eventIds: z.array(z.string().min(1)).max(100) }).optional(),
});

/** One row of the caller's own list (§0.8). */
const summarySchema = z.object({
  id: z.string(),
  requestType: z.string(),
  regulation: z.string(),
  status: z.string(),
  slaDueAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
});

/** The list envelope `GET /me/events` and `GET /me/notifications` answer. */
const listResponseSchema = z.object({
  data: z.array(summarySchema),
  page: z.object({
    hasMore: z.boolean(),
    limit: z.number(),
    nextCursor: z.string().nullable(),
  }),
});

/**
 * The combined `user` OR `attendee` credential (contract §0.2/§0.3).
 *
 * §0.3 lets an attendee session satisfy only the `attendee` label and a user
 * only the user labels, so neither single label admits both. The route resolves
 * the principal itself: a missing credential is `401 unauthenticated`, an
 * account runs the `user` rules with the §0.3 ban exemption, and an anonymous
 * session is admitted as-is. The user id is published on `ctx.principal` so the
 * identity rate tier keys the daily budget on the principal, not the IP.
 */
const dsrAuth: RouteStage = async (ctx, request) => {
  const database = getDb();
  const principal = await resolvePrincipal(request, { auth: getAuth(), database });

  if (principal === null) {
    throw appError("unauthenticated");
  }

  if (principal.kind === "user") {
    enforceAuth(
      "user",
      { principal, now: systemClock.now(), allowBanned: true },
      request,
      ctx.route
    );
    Object.assign(ctx, {
      principal: principal.userId,
      ...(principal.sessionId === null || principal.sessionId === undefined
        ? {}
        : { sessionId: principal.sessionId }),
    });
  }

  return undefined;
};

/** Parse a set of event ids into `ObjectId`s, keeping only well-formed ids. */
function eventObjectIds(eventIds: readonly string[]): ObjectId[] {
  return eventIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
}

/**
 * The events a scope names (schema §15.1), used for the tenant columns and the
 * outbox event's `tenantId`.
 */
async function eventsByIds(
  db: Db,
  eventIds: readonly string[]
): Promise<Record<string, unknown>[]> {
  if (eventIds.length === 0) {
    return [];
  }
  return await platformRepo(db)
    .collection(COLLECTIONS.events)
    .find({ _id: { $in: eventObjectIds(eventIds) } })
    .toArray();
}

/**
 * Narrow a user's requested scope to events they may reference (ADR-0898 §6).
 *
 * A user may reference the events they created or still organize; any other id
 * is `422 invalid_scope` naming the offenders. An omitted or empty scope means
 * "all of my data", which is deliberately not narrowed here.
 */
async function resolveUserScope(
  db: Db,
  userId: string,
  requested: readonly string[] | undefined
): Promise<readonly string[]> {
  if (requested === undefined || requested.length === 0) {
    return [];
  }
  const unique = [...new Set(requested)];
  const objectIds = eventObjectIds(unique);
  const platform = platformRepo(db);

  const created = (await platform
    .collection(COLLECTIONS.events)
    .find({ _id: { $in: objectIds } })
    .toArray()) as Record<string, unknown>[];
  const owned = new Set(
    created
      .filter((event) => String(event.createdByUserId) === userId)
      .map((event) => String(event._id))
  );

  const organizing = (await platform
    .collection(COLLECTIONS.eventOrganizers)
    .find({ eventId: { $in: objectIds }, userId, revokedAt: null })
    .toArray()) as Record<string, unknown>[];
  for (const row of organizing) {
    owned.add(String(row.eventId));
  }

  const offenders = unique.filter((eventId) => !owned.has(eventId));
  if (offenders.length > 0) {
    throw appError("invalid_scope", { details: { eventIds: offenders } });
  }
  return unique;
}

/** The tenant's stored data region, when the scope names one. */
async function tenantDataRegionOf(
  db: Db,
  tenantIds: readonly string[]
): Promise<TenantDataRegion | null> {
  const first = tenantIds[0];
  if (first === undefined || !ObjectId.isValid(first)) {
    return null;
  }
  const tenant = (await platformRepo(db)
    .collection(COLLECTIONS.tenants)
    .findOne({ _id: new ObjectId(first) })) as Record<string, unknown> | null;
  const region = tenant?.dataRegion;
  return region === "in" || region === "eu" ? region : null;
}

/** The caller's country from the CDN headers the platform is fronted by. */
function callerCountryOf(request: Request): string | null {
  return request.headers.get("x-vercel-ip-country") ?? request.headers.get("cf-ipcountry");
}

export const POST = defineRoute({
  route: "/api/v1/me/data-requests",
  body: createBodySchema,
  response: receiptSchema,
  auth: dsrAuth,
  // §8.1's "5 / day / principal": after auth, keyed on the principal.
  rateLimitIdentity: rateLimitStage({
    classKey: "compliance.dsr",
    limiter: createRateLimiter(),
    salt: getRateLimitConfig().salt,
  }),
  idempotency: idempotencyStage({ store: mongoIdempotencyStore(), required: true }),
  handler: async (ctx) => {
    const db = getDb();
    const now = systemClock.now();
    const requestedScope = ctx.body.scope?.eventIds;
    const userId = ctx.principal;

    let subject: Record<string, unknown>;
    let eventIds: readonly string[];
    if (userId === undefined) {
      const session = await findRequestAttendeeSession({ database: db }, ctx.request);
      if (session === null) {
        throw appError("unauthenticated");
      }
      subject = { kind: "anonymous", attendeeSessionId: session._id.toHexString() };
      eventIds = resolveAttendeeScope(
        requestedScope,
        session.eventIds.map((eventId) => eventId.toHexString())
      );
    } else {
      subject = { kind: "user", userId: new ObjectId(userId) };
      eventIds = await resolveUserScope(db, userId, requestedScope);
    }

    const events = await eventsByIds(db, eventIds);
    const tenantIds = [...new Set(events.map((event) => String(event.tenantId)))];
    const regulation = resolveRegulation({
      ...(ctx.body.regulation === undefined ? {} : { requested: ctx.body.regulation }),
      tenantDataRegion: await tenantDataRegionOf(db, tenantIds),
      callerCountry: callerCountryOf(ctx.request),
    });

    const settings = await getPlatformSettings({ db });
    const slaDueAt = computeSlaDueAt(now, regulation, settings);
    const slaDueAtIso = slaDueAt.toISOString();
    const requestId = new ObjectId();

    await platformRepo(db)
      .collection(REQUESTS)
      .insertOne({
        _id: requestId,
        requestType: ctx.body.requestType,
        subject,
        regulation,
        status: "received",
        slaDueAt,
        scope: { tenantIds, eventIds: eventObjectIds(eventIds) },
        executionLog: [],
        exportAssetId: null,
        completedAt: null,
        rejectionReason: null,
        receivedAt: now,
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
      });

    // The acknowledgement is the evidence. A request that resolves no tenant
    // (a platform-scoped filing) has no tenant to announce it under (ADR-0898 §6).
    const tenantId = tenantIds[0];
    if (tenantId !== undefined) {
      await emitDomainEvent(
        {
          eventKey: DSR_EVENT_KEY,
          tenantId,
          actorRef: { kind: String(subject.kind), id: userId ?? String(subject.attendeeSessionId) },
          subjectRef: {
            kind: String(subject.kind),
            id: userId ?? String(subject.attendeeSessionId),
          },
          payload: { requestType: ctx.body.requestType, regulation, slaDueAt: slaDueAtIso },
        },
        { db }
      );
    }

    // Never the note text (§8.1): the log line carries only the enum and regime.
    requestLogger(ctx.request, { route: ctx.route }).info("data subject request received", {
      event: "dsr.received",
      requestType: ctx.body.requestType,
      regulation,
    });

    return {
      status: 202,
      body: {
        id: requestId.toHexString(),
        requestType: ctx.body.requestType,
        status: "received",
        slaDueAt: slaDueAtIso,
        acknowledgement: acknowledgementFor(slaDueAt),
        pollUrl: `/api/v1/me/data-requests/${requestId.toHexString()}`,
      },
    };
  },
});

export const GET = defineRoute({
  route: "/api/v1/me/data-requests",
  response: listResponseSchema,
  auth: (ctx, request) => requireAuth("user", { auth: getAuth(), database: getDb() })(ctx, request),
  handler: async (ctx) => {
    const principal = ctx.principal;
    if (principal === undefined) {
      throw appError("authentication_required");
    }

    const query = parsePageQuery(new URL(ctx.request.url).searchParams);
    const filter: Record<string, unknown> = {
      "subject.kind": "user",
      "subject.userId": new ObjectId(principal),
    };
    if (query.cursor !== null) {
      if (!ObjectId.isValid(query.cursor.i)) {
        throw appError("invalid_cursor");
      }
      const c = new Date(query.cursor.c);
      filter.$or = [
        { receivedAt: { $lt: c } },
        { receivedAt: c, _id: { $lt: new ObjectId(query.cursor.i) } },
      ];
    }

    const rows = (await platformRepo(getDb())
      .collection(REQUESTS)
      .find(filter)
      .sort({ receivedAt: -1, _id: -1 })
      .limit(query.limit + 1)
      .toArray()) as Record<string, unknown>[];

    const page = buildCursorPage(rows, query.limit, (row) => ({
      c: (row.receivedAt as Date).toISOString(),
      i: String(row._id),
    }));

    return {
      body: {
        data: page.items.map((row) => ({
          id: String(row._id),
          requestType: String(row.requestType),
          regulation: String(row.regulation),
          status: String(row.status),
          slaDueAt: isoOf(row.slaDueAt),
          receivedAt: isoOf(row.receivedAt),
        })),
        page: { hasMore: page.hasMore, limit: query.limit, nextCursor: page.nextCursor },
      },
    };
  },
});
