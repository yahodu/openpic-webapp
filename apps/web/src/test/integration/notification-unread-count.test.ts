import { type Document } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findForbiddenFields } from "@openpic/contracts";

import { GET as getUnreadCount } from "@/app/api/v1/me/notifications/unread-count/route";
import { ensureIndexes } from "@/server/db/indexes";
import { buildUnreadCountFilter } from "@/server/notifications/unread-count";
import {
  invalidatePlatformSettings,
  seedPlatformSettings,
} from "@/server/settings/platform-settings";

import {
  APP_ORIGIN,
  makeIdentity,
  startTestApp,
  type SignedInUser,
  type TestApp,
} from "../helpers/authed-app";
import { insertFeedRow } from "../helpers/notification-rows";

/**
 * Integration / contract — `GET /api/v1/me/notifications/unread-count` (OP-97,
 * contract §7.2; design §19.4, §21, §22).
 *
 * This is the polled hot path: the bell asks for a count, a per-category
 * breakdown and the highest severity, and the answer is cacheable with an
 * `ETag` so an unchanged badge is a bodyless `304`. It must stay cheap, which
 * the contract makes an observable property: the count runs against the
 * **partial** index `idx_user_unread` (`{userId:1, createdAt:-1}` where
 * `readAt: null`), so the plan is pinned here with an `explain` (I4).
 *
 * ## Contract expected of the implementation
 *
 * `@/app/api/v1/me/notifications/unread-count/route` exports `GET`, guarded
 * with the `user` label and rate class `read.hot`, answering
 * `{ unreadCount, byCategory, highestSeverity, pollIntervalSeconds, serverTime }`
 * with `Cache-Control: no-store` and a weak `ETag`
 * `` W/"<count>-<severity|none>-<epochSeconds>" `` (see the unit spec). A
 * matching `If-None-Match` is a `304` with an empty body.
 *
 * The count reads `buildUnreadCountFilter({ userId, now })` — `{ userId,
 * readAt: null, expireAt: { $gt: now } }` — so rows the TTL monitor has not yet
 * swept (I8) and `auth.otp.*` rows (I7, defence in depth) never inflate it.
 *
 * ## Assumptions recorded in the handoff
 *
 * - `byCategory` lists only categories with a non-zero count.
 * - `highestSeverity` is `null` when nothing is unread.
 * - The rate-limit class is asserted only through the designated class
 *   (`read.hot`); the numeric limit is owned by the rate-limit suite.
 */

let app: TestApp;

/** A non-default poll cadence, so the value provably comes from settings. */
const POLL_INTERVAL_SECONDS = 45;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op97-unread" });

  // Pin `pollIntervalSeconds` to a non-default value: a hard-coded 30 must fail.
  await seedPlatformSettings({ db: app.db });
  await app.db.collection("platformSettings").updateOne({ _id: "singleton" } as never, {
    $set: { "notifications.pollIntervalSeconds": POLL_INTERVAL_SECONDS },
  });
  invalidatePlatformSettings();
}, 30_000);

afterAll(async () => {
  await app.cleanup();
});

/** The instant `days` ago. */
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/** The instants `days` in the future. */
function daysAhead(days: number): Date {
  return daysAgo(-days);
}

/** The unread-count response body (contract §7.2). */
interface UnreadCountBody {
  readonly unreadCount: number;
  readonly byCategory: Record<string, number>;
  readonly highestSeverity: string | null;
  readonly pollIntervalSeconds: number;
  readonly serverTime: string;
}

/** A GET with the session cookie and optional extra headers. */
function countRequest(session: SignedInUser, headers: Record<string, string> = {}): Request {
  return new Request(new URL("/api/v1/me/notifications/unread-count", APP_ORIGIN), {
    method: "GET",
    headers: { cookie: session.cookie, ...headers },
  });
}

/** Collect every node of an `explain()` plan tree. */
function planNodes(plan: unknown): Document[] {
  if (plan === null || typeof plan !== "object") {
    return [];
  }
  const node = plan as Document;
  const children: Document[] = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        children.push(...planNodes(entry));
      }
    } else if (value !== null && typeof value === "object") {
      children.push(...planNodes(value));
    }
  }
  return [node, ...children];
}

describe("GET /api/v1/me/notifications/unread-count", () => {
  it("reports the count, the per-category breakdown and the highest severity", async () => {
    const session = await app.signIn(makeIdentity("op97-unread-shape"));
    await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "attendee.matches.new",
      severity: "informational",
      createdAt: daysAgo(1),
    });
    await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "collab.invite.sent",
      severity: "important",
      createdAt: daysAgo(2),
    });
    await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "account.welcome",
      severity: "informational",
      readAt: daysAgo(3),
      createdAt: daysAgo(3),
    });

    const response = await getUnreadCount(countRequest(session));
    const body = (await response.json()) as UnreadCountBody;

    expect(response.status).toBe(200);
    expect(body.unreadCount).toBe(2);
    expect(body.byCategory).toEqual({ matching: 1, collaboration: 1 });
    expect(body.highestSeverity).toBe("important");
    expect(body.pollIntervalSeconds).toBe(POLL_INTERVAL_SECONDS);
    expect(Date.parse(body.serverTime)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("answers zero with a null severity when the caller has nothing unread", async () => {
    const session = await app.signIn(makeIdentity("op97-unread-empty"));
    await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "account.welcome",
      readAt: daysAgo(1),
      createdAt: daysAgo(1),
    });

    const response = await getUnreadCount(countRequest(session));
    const body = (await response.json()) as UnreadCountBody;

    expect(body.unreadCount).toBe(0);
    expect(body.byCategory).toEqual({});
    expect(body.highestSeverity).toBeNull();
  });

  it("I6: the response body carries no never-return field", async () => {
    const session = await app.signIn(makeIdentity("op97-unread-never-return"));
    await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "account.welcome",
      createdAt: daysAgo(1),
    });

    const response = await getUnreadCount(countRequest(session));
    const body: unknown = await response.json();

    expect(findForbiddenFields(body, "default")).toEqual([]);
  });

  it("I7: never counts an OTP-type row, even one stored unread", async () => {
    const session = await app.signIn(makeIdentity("op97-unread-otp"));
    await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "account.welcome",
      severity: "informational",
      createdAt: daysAgo(1),
    });
    await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "auth.otp.email.requested",
      severity: "critical",
      createdAt: daysAgo(1),
    });

    const response = await getUnreadCount(countRequest(session));
    const body = (await response.json()) as UnreadCountBody;

    expect(body.unreadCount).toBe(1);
    expect(body.byCategory).toEqual({ account: 1 });
    expect(body.highestSeverity).toBe("informational");
  });

  it("I8: excludes a row whose expireAt has already passed", async () => {
    const session = await app.signIn(makeIdentity("op97-unread-expired"));
    await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "account.welcome",
      createdAt: daysAgo(1),
      expireAt: daysAhead(30),
    });
    await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "event.details.updated",
      createdAt: daysAgo(100),
      expireAt: daysAgo(1),
    });

    const response = await getUnreadCount(countRequest(session));
    const body = (await response.json()) as UnreadCountBody;

    expect(body.unreadCount).toBe(1);
    expect(body.byCategory).toEqual({ account: 1 });
  });

  it("I4: the count query is served by the partial index idx_user_unread", async () => {
    const session = await app.signIn(makeIdentity("op97-unread-explain"));
    // A read-heavy collection: the partial index indexes only the unread rows,
    // so the planner must prefer it over a full-collection scan.
    const readRows = Array.from({ length: 30 }, (_, index) => index);
    for (const index of readRows) {
      await insertFeedRow(app.db, {
        userId: session.userId,
        typeKey: "account.welcome",
        readAt: daysAgo(index + 1),
        createdAt: daysAgo(index + 1),
      });
    }
    for (const index of [1, 2, 3, 4]) {
      await insertFeedRow(app.db, {
        userId: session.userId,
        typeKey: "account.welcome",
        createdAt: daysAgo(index),
      });
    }
    await ensureIndexes(app.db);

    const now = new Date();
    const explanation = await app.db
      .collection("notifications")
      .find(buildUnreadCountFilter({ userId: session.userId, now }))
      .explain("executionStats");

    const plan = explanation as unknown as { queryPlanner?: { winningPlan?: unknown } };
    const stages = planNodes(plan.queryPlanner?.winningPlan).map((node) => node.indexName);
    expect(stages).toContain("idx_user_unread");
  });
});

describe("GET /api/v1/me/notifications/unread-count — conditional requests (I5)", () => {
  it("I5: serves no-store and a weak ETag, then 304 with an empty body on a match", async () => {
    const session = await app.signIn(makeIdentity("op97-unread-etag"));
    await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "account.welcome",
      createdAt: daysAgo(1),
    });

    const fresh = await getUnreadCount(countRequest(session));
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("cache-control")).toBe("no-store");
    const etag = fresh.headers.get("etag");
    if (etag === null) {
      throw new Error("the unread-count response carried no ETag");
    }
    expect(etag).toMatch(/^W\/"\d+-\w+-\d+"$/);

    const conditional = await getUnreadCount(countRequest(session, { "if-none-match": etag }));

    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("etag")).toBe(etag);
    expect((await conditional.arrayBuffer()).byteLength).toBe(0);
  });

  it("I5: a changed unread state no longer matches the stale ETag", async () => {
    const session = await app.signIn(makeIdentity("op97-unread-etag-change"));
    await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "account.welcome",
      createdAt: daysAgo(1),
    });

    const before = await getUnreadCount(countRequest(session));
    const etag = before.headers.get("etag");
    if (etag === null) {
      throw new Error("the unread-count response carried no ETag");
    }

    await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "collab.invite.sent",
      createdAt: daysAgo(1),
    });

    const after = await getUnreadCount(countRequest(session, { "if-none-match": etag }));

    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etag);
    expect(((await after.json()) as UnreadCountBody).unreadCount).toBe(2);
  });
});
