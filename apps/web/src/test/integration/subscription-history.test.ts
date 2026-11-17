import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { GET as getHistory } from "@/app/api/v1/tenants/[tenantId]/subscription/history/route";
import { COLLECTIONS } from "@/server/db/collections";

import { body } from "../helpers/auth-requests";
import {
  APP_ORIGIN,
  makeIdentity,
  startTestApp,
  type SignedInUser,
  type TestApp,
} from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";

/**
 * Integration / contract — `GET /api/v1/tenants/{tenantId}/subscription/history`
 * (OP-106 RED, contract §3.2, schema §14.3; ADR-0400).
 *
 * The user story: *as an organizer I want a single subscription view … so that I
 * always know my billing state and that nothing was deleted.* The history read
 * answers the support question behind that story — *why is this tenant on free?*
 * — without log diving.
 *
 *   I4  `statusHistory` is served **capped at 50, newest first**: the stored
 *       list may grow to ~50 rows, and a longer list must not be served whole.
 *
 * Around it the suite pins the access rules (§3.2: `user` + role
 * `owner`|`admin`) and the empty case, plus the §0.5 collection envelope.
 *
 * ## Contract expected of the implementation
 *
 * - `@/app/api/v1/tenants/[tenantId]/subscription/history/route` exports `GET`,
 *   declared `defineRoute({ route: "/api/v1/tenants/:tenantId/subscription/history", … })`,
 *   answered as the §0.5 **collection** envelope `{ data: [...] }`.
 * - Each entry is `{ from, to, at, reason, actor }` (schema §14.3), with `at`
 *   serialized RFC 3339 UTC.
 * - The gate is `member`-of-the-workspace (the reusable tenant stage, so a
 *   non-member is `404 not_found`) **then** role `owner`|`admin` (a plain
 *   `member` is `403 forbidden`), exactly like OP-104's `/usage`.
 * - A workspace with no subscription document answers the empty list, not a
 *   `404`: the free state is explicit everywhere in §3.2.
 */

const TENANTS_PATH = "/api/v1/tenants";

/** An RFC 3339 UTC timestamp string. */
const isoDateTime = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: "not an ISO date-time" });

/** One `statusHistory` entry as served. */
const statusHistoryEntrySchema = z.object({
  from: z.string(),
  to: z.string(),
  at: isoDateTime,
  reason: z.string(),
  actor: z.string(),
});

/** The §3.2 history body (§0.5 collection envelope). */
const historyBodySchema = z.object({ data: z.array(statusHistoryEntrySchema) });

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op106-history" });
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

/** Merge fields into a caller's auto-provisioned `userProfiles` row. */
async function updateProfile(userId: ObjectId, fields: Record<string, unknown>): Promise<void> {
  const result = await app.db
    .collection(COLLECTIONS.userProfiles)
    .updateOne({ userId }, { $set: { ...fields, updatedAt: new Date() } });
  expect(result.matchedCount).toBe(1);
}

/** Insert a tenant (schema §13.3) and return its id. */
async function insertTenant(fields: { slug: string; name: string; ownerUserId: ObjectId }) {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.tenants).insertOne({
    _id,
    slug: fields.slug,
    name: fields.name,
    status: "active",
    ownerUserId: fields.ownerUserId,
    billingContactUserId: fields.ownerUserId,
    dataRegion: "in",
    counters: {
      eventCount: 0,
      activeEventCount: 0,
      imageCount: 0,
      storageBytes: 0,
      attendeeCount: 0,
      reconciledAt: null,
    },
    settings: {
      defaultTimeZone: "Asia/Kolkata",
      brandLogoAssetId: null,
      defaultWatermarkAssetId: null,
    },
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    schemaVersion: 1,
  });
  return _id;
}

/** Seed a workspace with `user` as a member and its `current` alias target. */
async function seedWorkspace(options: {
  userId: ObjectId;
  role: "owner" | "admin" | "member";
  slug: string;
}): Promise<ObjectId> {
  const tenantId = await insertTenant({
    slug: options.slug,
    name: "OP106 Studio",
    ownerUserId: options.role === "owner" ? options.userId : new ObjectId(),
  });
  await app.db.collection(COLLECTIONS.tenantMembers).insertOne({
    tenantId,
    userId: options.userId,
    role: options.role,
    status: "active",
    joinedAt: new Date(),
  });
  await updateProfile(options.userId, { primaryTenantId: tenantId });
  return tenantId;
}

/** Add `user` to `tenantId` with a role and a working `current` alias. */
async function addMember(
  tenantId: ObjectId,
  user: SignedInUser,
  role: "owner" | "admin" | "member"
): Promise<void> {
  await app.db
    .collection(COLLECTIONS.tenantMembers)
    .insertOne({ tenantId, userId: user.userId, role, status: "active", joinedAt: new Date() });
  await updateProfile(user.userId, { primaryTenantId: tenantId });
}

/** Seed the `subscriptions` row shape (schema §14.3) with a history list. */
async function seedSubscription(fields: {
  tenantId: string;
  status: "active" | "past_due" | "downgraded";
  statusHistory: { from: string; to: string; at: Date; reason: string; actor: string }[];
}): Promise<void> {
  await app.db.collection(COLLECTIONS.subscriptions).insertOne({
    tenantId: fields.tenantId,
    subscribedPlanKey: "starter",
    subscribedPlanVersion: 3,
    activePlanKey: fields.status === "downgraded" ? "free" : "starter",
    status: fields.status,
    priceKey: "starter-monthly-inr",
    paymentMethodKind: "mandate_upi",
    mandateStatus: "active",
    billingCycle: "monthly",
    currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
    nextChargeAt: new Date("2026-10-01T00:00:00.000Z"),
    gracePeriodEndsAt: null,
    pendingDueMinor: 0,
    currency: "INR",
    dunning: { attemptCount: 0, lastAttemptAt: null, remindersSent: [], nextReminderAt: null },
    cancelAt: null,
    cancelledAt: null,
    cancelReason: null,
    scheduledChange: null,
    previousSubscriptionId: null,
    statusHistory: fields.statusHistory,
    externalRefs: [{ provider: "cashfree", id: "cf_sub_0001" }],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
}

/**
 * Build `count` history entries, one minute apart, oldest first.
 *
 * Entry `i` therefore has the `at` of `BASE + i minutes`, so "the newest 50" is
 * unambiguous and the entries the cap must drop are the lowest indices.
 */
function makeHistory(count: number) {
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) => ({
    from: index === 0 ? "none" : "active",
    to: index % 2 === 0 ? "active" : "past_due",
    at: new Date(base + index * 60_000),
    reason: `transition-${String(index)}`,
    actor: "system",
  }));
}

/** A `GET /tenants/{t}/subscription/history` request carrying a session cookie. */
function historyRequest(cookie: string, tenantId: string): Request {
  return new Request(new URL(`${TENANTS_PATH}/${tenantId}/subscription/history`, APP_ORIGIN), {
    method: "GET",
    headers: { cookie },
  });
}

/** The error envelope of a failed response. */
async function errorEnvelope(response: Response): Promise<{ code: string }> {
  const parsed = await body(response);
  return parsed.error as { code: string };
}

describe("GET /api/v1/tenants/{tenantId}/subscription/history", () => {
  it("I4: serves at most the 50 newest status transitions, newest first", async () => {
    const owner = await app.signIn(makeIdentity("op106-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op106-cap",
    });
    const history = makeHistory(60);
    await seedSubscription({
      tenantId: tenantId.toHexString(),
      status: "past_due",
      statusHistory: history,
    });

    const response = await getHistory(historyRequest(owner.cookie, tenantId.toHexString()));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-tenant-id")).toBe(tenantId.toHexString());

    const parsed = await body(response);
    expect(() => historyBodySchema.parse(parsed)).not.toThrow();

    const data = parsed.data as {
      at: string;
      reason: string;
      from: string;
      to: string;
      actor: string;
    }[];
    expect(data).toHaveLength(50);
    // Newest first: the most recent transition leads, the 50th-newest closes.
    expect(data[0]?.reason).toBe("transition-59");
    expect(data[49]?.reason).toBe("transition-10");
    // The ten oldest transitions are dropped, not truncated in place.
    const servedReasons = new Set(data.map((entry) => entry.reason));
    expect(servedReasons.has("transition-9")).toBe(false);
    expect(servedReasons.has("transition-0")).toBe(false);
    // Every served entry carries the full §14.3 shape, with `at` as ISO UTC.
    expect(data[0]).toMatchObject({
      from: expect.any(String),
      to: expect.any(String),
      at: history[59]?.at.toISOString(),
      reason: expect.any(String),
      actor: expect.any(String),
    });
  });

  it("serves the whole stored history when it is shorter than the cap", async () => {
    const owner = await app.signIn(makeIdentity("op106-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op106-short",
    });
    const history = makeHistory(3);
    await seedSubscription({
      tenantId: tenantId.toHexString(),
      status: "active",
      statusHistory: history,
    });

    const parsed = await body(
      await getHistory(historyRequest(owner.cookie, tenantId.toHexString()))
    );

    const data = parsed.data as { reason: string }[];
    expect(data.map((entry) => entry.reason)).toEqual([
      "transition-2",
      "transition-1",
      "transition-0",
    ]);
  });

  it("answers the empty list for a workspace with no subscription document, not a 404", async () => {
    const owner = await app.signIn(makeIdentity("op106-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op106-empty",
    });

    const response = await getHistory(historyRequest(owner.cookie, tenantId.toHexString()));

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ data: [] });
  });

  it("refuses a plain workspace member with 403 forbidden", async () => {
    const owner = await app.signIn(makeIdentity("op106-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op106-role",
    });
    const member = await app.signIn(makeIdentity("op106-member"));
    await addMember(tenantId, member, "member");
    await seedSubscription({
      tenantId: tenantId.toHexString(),
      status: "active",
      statusHistory: makeHistory(2),
    });

    const response = await getHistory(historyRequest(member.cookie, tenantId.toHexString()));

    expect(response.status).toBe(403);
    expect(await errorEnvelope(response)).toMatchObject({ code: "forbidden" });
  });

  it("admits a workspace admin as well as the owner", async () => {
    const owner = await app.signIn(makeIdentity("op106-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op106-admin",
    });
    const admin = await app.signIn(makeIdentity("op106-admin"));
    await addMember(tenantId, admin, "admin");
    await seedSubscription({
      tenantId: tenantId.toHexString(),
      status: "active",
      statusHistory: makeHistory(2),
    });

    const response = await getHistory(historyRequest(admin.cookie, tenantId.toHexString()));

    expect(response.status).toBe(200);
  });

  it("refuses a signed-in caller with no tenant membership with the uniform 404", async () => {
    const owner = await app.signIn(makeIdentity("op106-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op106-outsider",
    });
    await seedSubscription({
      tenantId: tenantId.toHexString(),
      status: "active",
      statusHistory: makeHistory(2),
    });
    const outsider = await app.signIn(makeIdentity("op106-outsider"));

    const response = await getHistory(historyRequest(outsider.cookie, tenantId.toHexString()));

    expect(response.status).toBe(404);
    expect(await errorEnvelope(response)).toMatchObject({ code: "not_found" });
  });

  it("rejects an unauthenticated caller with 401", async () => {
    const owner = await app.signIn(makeIdentity("op106-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op106-anon",
    });

    const response = await getHistory(
      new Request(
        new URL(`${TENANTS_PATH}/${tenantId.toHexString()}/subscription/history`, APP_ORIGIN),
        { method: "GET" }
      )
    );

    expect(response.status).toBe(401);
    expect(await errorEnvelope(response)).toMatchObject({ code: "authentication_required" });
  });
});
