import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DELETE as deleteNotification } from "@/app/api/v1/me/notifications/[id]/route";
import { POST as markRead } from "@/app/api/v1/me/notifications/[id]/read/route";
import { POST as markAllRead } from "@/app/api/v1/me/notifications/read-all/route";

import {
  APP_ORIGIN,
  makeIdentity,
  startTestApp,
  type SignedInUser,
  type TestApp,
} from "../helpers/authed-app";
import { insertFeedRow, NOTIFICATIONS_COLLECTION } from "../helpers/notification-rows";

/**
 * Integration / contract — the notification read-state mutations (OP-97,
 * contract §7.1; design §19.4).
 *
 * Three routes own the caller's read state:
 *
 *   POST   `/api/v1/me/notifications/{id}/read` → `204`, idempotent;
 *   POST   `/api/v1/me/notifications/read-all`  → `200 { markedCount, unreadCount }`;
 *   DELETE `/api/v1/me/notifications/{id}`      → `204`, the caller's feed only.
 *
 * All three are `user`-scoped: an id that exists but belongs to somebody else
 * must be indistinguishable from one that does not exist, so a probe can never
 * learn that a foreign notification exists (I2). `read-all` honours an optional
 * `category`/`eventId`/`before` filter, so marking one category read must leave
 * every other category untouched (I3). A delete removes the feed row and
 * nothing else: `notificationDispatches` is an independent audit ledger
 * (contract §7.1).
 *
 * ## Contract expected of the implementation
 *
 * The three route modules above export the handler named after their HTTP verb,
 * each guarded with the `user` label. A malformed, unknown or foreign `{id}` is
 * `404 not_found` for every one of them.
 */

const DISPATCHES_COLLECTION = "notification_dispatches";

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op97-read-state" });
}, 30_000);

afterAll(async () => {
  await app.cleanup();
});

/** The instant `days` ago. */
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/** A POST carrying the session cookie and an optional JSON body. */
function postRequest(session: SignedInUser, path: string, payload?: unknown): Request {
  return new Request(new URL(path, APP_ORIGIN), {
    method: "POST",
    headers:
      payload === undefined
        ? { cookie: session.cookie }
        : { cookie: session.cookie, "content-type": "application/json" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

/** A DELETE carrying the session cookie. */
function deleteRequest(session: SignedInUser, path: string): Request {
  return new Request(new URL(path, APP_ORIGIN), {
    method: "DELETE",
    headers: { cookie: session.cookie },
  });
}

/** Read the stored row, failing loudly when it is gone. */
async function requireRow(id: ObjectId): Promise<Record<string, unknown>> {
  const row = await app.db.collection(NOTIFICATIONS_COLLECTION).findOne({ _id: id });
  if (row === null) {
    throw new Error(`no stored notification row for ${id.toString()}`);
  }
  return row;
}

describe("POST /api/v1/me/notifications/{id}/read", () => {
  it("marks the caller's own row read and is idempotent", async () => {
    const session = await app.signIn(makeIdentity("op97-read"));
    const id = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "account.welcome",
      createdAt: daysAgo(1),
    });
    const path = `/api/v1/me/notifications/${id.toString()}/read`;

    const first = await markRead(postRequest(session, path));
    const second = await markRead(postRequest(session, path));

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect((await requireRow(id)).readAt).toBeInstanceOf(Date);
  });

  it("I2: answers 404 for another user's notification id", async () => {
    const owner = await app.signIn(makeIdentity("op97-read-owner"));
    const stranger = await app.signIn(makeIdentity("op97-read-stranger"));
    const id = await insertFeedRow(app.db, {
      userId: owner.userId,
      typeKey: "account.welcome",
      createdAt: daysAgo(1),
    });

    const response = await markRead(
      postRequest(stranger, `/api/v1/me/notifications/${id.toString()}/read`)
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
    expect((await requireRow(id)).readAt).toBeNull();
  });

  it("I2: answers 404 for an unknown or malformed notification id", async () => {
    const session = await app.signIn(makeIdentity("op97-read-missing"));
    const unknown = new ObjectId().toString();

    const missing = await markRead(
      postRequest(session, `/api/v1/me/notifications/${unknown}/read`)
    );
    const malformed = await markRead(
      postRequest(session, "/api/v1/me/notifications/not-an-object-id/read")
    );

    expect(missing.status).toBe(404);
    expect(malformed.status).toBe(404);
  });
});

describe("DELETE /api/v1/me/notifications/{id}", () => {
  it("removes the caller's own feed row without touching the dispatch ledger", async () => {
    const session = await app.signIn(makeIdentity("op97-delete"));
    const id = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "account.welcome",
      createdAt: daysAgo(1),
    });
    await app.db.collection(DISPATCHES_COLLECTION).insertOne({
      userId: session.userId,
      typeKey: "account.welcome",
      channel: "in_app",
      channelGroup: "in_app",
      status: "sent",
      notificationId: id,
      queuedAt: daysAgo(1),
      expireAt: daysAgo(-100),
    });

    const response = await deleteNotification(
      deleteRequest(session, `/api/v1/me/notifications/${id.toString()}`)
    );

    expect(response.status).toBe(204);
    expect(await app.db.collection(NOTIFICATIONS_COLLECTION).findOne({ _id: id })).toBeNull();
    expect(
      await app.db.collection(DISPATCHES_COLLECTION).countDocuments({ notificationId: id })
    ).toBe(1);
  });

  it("I2: answers 404 for another user's notification id", async () => {
    const owner = await app.signIn(makeIdentity("op97-delete-owner"));
    const stranger = await app.signIn(makeIdentity("op97-delete-stranger"));
    const id = await insertFeedRow(app.db, {
      userId: owner.userId,
      typeKey: "account.welcome",
      createdAt: daysAgo(1),
    });

    const response = await deleteNotification(
      deleteRequest(stranger, `/api/v1/me/notifications/${id.toString()}`)
    );

    expect(response.status).toBe(404);
    expect((await requireRow(id)).readAt).toBeNull();
  });
});

describe("POST /api/v1/me/notifications/read-all", () => {
  it("I3: with a category, marks only that category and reports the remaining count", async () => {
    const session = await app.signIn(makeIdentity("op97-read-all"));
    const matchingA = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "attendee.matches.new",
      createdAt: daysAgo(1),
    });
    const matchingB = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "attendee.matches.new",
      createdAt: daysAgo(2),
    });
    const billing = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "billing.payment.failed",
      createdAt: daysAgo(3),
    });
    const alreadyReadAt = daysAgo(4);
    const alreadyRead = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "attendee.matches.new",
      readAt: alreadyReadAt,
      createdAt: alreadyReadAt,
    });

    const response = await markAllRead(
      postRequest(session, "/api/v1/me/notifications/read-all", { category: "matching" })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ markedCount: 2, unreadCount: 1 });
    expect((await requireRow(matchingA)).readAt).toBeInstanceOf(Date);
    expect((await requireRow(matchingB)).readAt).toBeInstanceOf(Date);
    expect((await requireRow(billing)).readAt).toBeNull();
    expect((await requireRow(alreadyRead)).readAt).toEqual(alreadyReadAt);
  });

  it("marks every unread row of the caller when no filter is supplied", async () => {
    const session = await app.signIn(makeIdentity("op97-read-all-none"));
    const other = await app.signIn(makeIdentity("op97-read-all-other"));
    const mine = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "account.welcome",
      createdAt: daysAgo(1),
    });
    const theirs = await insertFeedRow(app.db, {
      userId: other.userId,
      typeKey: "account.welcome",
      createdAt: daysAgo(1),
    });

    const response = await markAllRead(
      postRequest(session, "/api/v1/me/notifications/read-all", {})
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ markedCount: 1, unreadCount: 0 });
    expect((await requireRow(mine)).readAt).toBeInstanceOf(Date);
    expect((await requireRow(theirs)).readAt).toBeNull();
  });

  it("is idempotent: a second read-all marks nothing", async () => {
    const session = await app.signIn(makeIdentity("op97-read-all-twice"));
    await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "account.welcome",
      createdAt: daysAgo(1),
    });

    const first = await markAllRead(postRequest(session, "/api/v1/me/notifications/read-all", {}));
    const second = await markAllRead(postRequest(session, "/api/v1/me/notifications/read-all", {}));

    expect(await first.json()).toEqual({ markedCount: 1, unreadCount: 0 });
    expect(await second.json()).toEqual({ markedCount: 0, unreadCount: 0 });
  });

  it("I3: with an eventId, marks only that event's rows and reports the remaining count", async () => {
    const session = await app.signIn(makeIdentity("op97-read-all-event"));
    const scopedEvent = new ObjectId();
    const otherEvent = new ObjectId();
    const scopedA = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "attendee.matches.new",
      eventId: scopedEvent,
      createdAt: daysAgo(1),
    });
    const scopedB = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "collab.invite.sent",
      eventId: scopedEvent,
      createdAt: daysAgo(2),
    });
    const other = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "event.details.updated",
      eventId: otherEvent,
      createdAt: daysAgo(3),
    });
    const unassigned = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "account.welcome",
      eventId: null,
      createdAt: daysAgo(4),
    });

    const response = await markAllRead(
      postRequest(session, "/api/v1/me/notifications/read-all", {
        eventId: scopedEvent.toHexString(),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ markedCount: 2, unreadCount: 2 });
    expect((await requireRow(scopedA)).readAt).toBeInstanceOf(Date);
    expect((await requireRow(scopedB)).readAt).toBeInstanceOf(Date);
    expect((await requireRow(other)).readAt).toBeNull();
    expect((await requireRow(unassigned)).readAt).toBeNull();
  });

  it("I3: with `before`, marks only rows created before the instant", async () => {
    const session = await app.signIn(makeIdentity("op97-read-all-before"));
    const recent = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "account.welcome",
      createdAt: daysAgo(1),
    });
    const older = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "account.welcome",
      createdAt: daysAgo(3),
    });
    const oldest = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "account.welcome",
      createdAt: daysAgo(5),
    });

    const response = await markAllRead(
      postRequest(session, "/api/v1/me/notifications/read-all", {
        before: daysAgo(2).toISOString(),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ markedCount: 2, unreadCount: 1 });
    expect((await requireRow(recent)).readAt).toBeNull();
    expect((await requireRow(older)).readAt).toBeInstanceOf(Date);
    expect((await requireRow(oldest)).readAt).toBeInstanceOf(Date);
  });

  it("I3: with `before`, leaves a row created exactly at the instant unread", async () => {
    // The operator is `createdAt < before` (ADR-0129 §Feed projection): a row
    // whose `createdAt` equals the cut instant is NOT "created before" it, so it
    // stays unread. The seeded / cut values share one instant so `$lt` and `$lte`
    // are distinguishable — the earlier case (1/3/5 days, cut at 2) cannot.
    const session = await app.signIn(makeIdentity("op97-read-all-before-boundary"));
    const cut = daysAgo(2);
    const atCut = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "account.welcome",
      createdAt: cut,
    });
    const justBefore = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "account.welcome",
      createdAt: new Date(cut.getTime() - 1),
    });

    const response = await markAllRead(
      postRequest(session, "/api/v1/me/notifications/read-all", {
        before: cut.toISOString(),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ markedCount: 1, unreadCount: 1 });
    expect((await requireRow(atCut)).readAt).toBeNull();
    expect((await requireRow(justBefore)).readAt).toBeInstanceOf(Date);
  });

  it("I3: ANDs category and eventId when both are supplied", async () => {
    const session = await app.signIn(makeIdentity("op97-read-all-and"));
    const event = new ObjectId();
    const both = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "attendee.matches.new",
      eventId: event,
      createdAt: daysAgo(1),
    });
    const categoryOnly = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "attendee.matches.new",
      eventId: new ObjectId(),
      createdAt: daysAgo(2),
    });
    const eventOnly = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "collab.invite.sent",
      eventId: event,
      createdAt: daysAgo(3),
    });

    const response = await markAllRead(
      postRequest(session, "/api/v1/me/notifications/read-all", {
        category: "matching",
        eventId: event.toHexString(),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ markedCount: 1, unreadCount: 2 });
    expect((await requireRow(both)).readAt).toBeInstanceOf(Date);
    expect((await requireRow(categoryOnly)).readAt).toBeNull();
    expect((await requireRow(eventOnly)).readAt).toBeNull();
  });
});
