import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { GET as getSubscription } from "@/app/api/v1/tenants/[tenantId]/subscription/route";
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
 * Integration / contract — `GET /api/v1/tenants/{tenantId}/subscription`
 * (OP-106 RED, contract §3.2, schema §14.3; ADR-0400).
 *
 * The user story: *as an organizer I want a single subscription view with a
 * reassuring banner so that I always know my billing state and that nothing was
 * deleted.*
 *
 *   I1  a workspace with **no `subscriptions` document** is the explicit free
 *       state — `exists: false`, `status: "none"`, `activePlanKey: "free"` —
 *       and it is **not** a `404`;
 *   I2  a `past_due` document serves the critical banner **with** the
 *       mandatory reassurance copy and the grace-window deadline;
 *   I3  a signed-in co-organizer with **no active tenant membership** gets the
 *       uniform `404 not_found`, while a plain workspace `member` may read the
 *       same body (the endpoint is `member`-readable; the `404` is about
 *       membership, never about the role).
 *
 * Around those three the suite pins the ordinary behaviour §3.2 implies: the
 * `401`/`404` ladder, the free-state `actions` matrix, the §0.5 bare
 * single-resource envelope, and the §0.15 never-return rules (`_id` and
 * provider `externalRefs` are never served).
 *
 * ## Contract expected of the implementation
 *
 * - `@/app/api/v1/tenants/[tenantId]/subscription/route` exports `GET`,
 *   declared `defineRoute({ route: "/api/v1/tenants/:tenantId/subscription", … })`
 *   with the `user` auth stage and the reusable tenant stage; it answers the
 *   §3.2 body **bare** (a single resource, §0.5).
 * - The served document is the tenant's most recently updated `subscriptions`
 *   row; **no** row at all is the free state (`exists: false`, `status: "none"`,
 *   `activePlanKey`/`subscribedPlanKey` = `"free"`, `banner: null`).
 * - The subscription read is tenant-scoped on the **string** hex `tenantId`
 *   (the convention OP-103/OP-104 established), so a seeded row is reachable
 *   only when its `tenantId` is that string.
 *
 * ## Assumptions recorded in the handoff (ADR-0400)
 *
 * - Provider `externalRefs` are the §0.15 never-return rule; the endpoint echoes
 *   nothing vendor-shaped.
 * - `banner.daysRemaining` is computed against the server clock, so the suite
 *   pins it as a non-negative number and pins the clock-independent
 *   `downgradeOn`/`gracePeriodEndsAt` exactly (the exact rounding is unit-pinned
 *   in `src/test/unit/subscription-view.test.ts`).
 */

const TENANTS_PATH = "/api/v1/tenants";

/** An RFC 3339 UTC timestamp string. */
const isoDateTime = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: "not an ISO date-time" });

/** The §3.2 `actions` block. */
const actionsSchema = z.object({
  canUpgrade: z.boolean(),
  canDowngrade: z.boolean(),
  canCancel: z.boolean(),
  canRetryCharge: z.boolean(),
  mustCompleteMandate: z.boolean(),
});

/** The §3.2 `banner` block. */
const bannerSchema = z.object({
  kind: z.enum(["past_due", "downgraded", "mandate_pending", "mandate_revoked", "cancelling"]),
  severity: z.enum(["critical", "important", "informational"]),
  daysRemaining: z.number().optional(),
  downgradeOn: isoDateTime.optional(),
  reassurance: z.string().optional(),
});

/** The §3.2 body, as served. */
const subscriptionBodySchema = z.object({
  tenantId: z.string(),
  exists: z.boolean(),
  status: z.enum([
    "none",
    "incomplete",
    "active",
    "past_due",
    "downgraded",
    "cancelled",
    "expired",
  ]),
  subscribedPlanKey: z.string(),
  subscribedPlanVersion: z.number().optional(),
  activePlanKey: z.string(),
  priceKey: z.string().optional(),
  billingCycle: z.enum(["monthly", "yearly"]).optional(),
  paymentMethodKind: z
    .enum(["mandate_upi", "mandate_bank_debit", "card", "invoice", "manual"])
    .optional(),
  mandateStatus: z
    .enum(["pending", "active", "paused", "revoked", "expired"])
    .nullable()
    .optional(),
  currentPeriodStart: isoDateTime.optional(),
  currentPeriodEnd: isoDateTime.optional(),
  nextChargeAt: isoDateTime.optional(),
  gracePeriodEndsAt: isoDateTime.nullable().optional(),
  pendingDue: z.object({ amountMinor: z.number().int(), currency: z.literal("INR") }).nullable(),
  scheduledChange: z
    .object({ toPlanKey: z.string(), effectiveAt: isoDateTime, reason: z.string() })
    .nullable()
    .optional(),
  cancelAt: isoDateTime.nullable().optional(),
  actions: actionsSchema,
  banner: bannerSchema.nullable(),
  updatedAt: isoDateTime.optional(),
});

let app: TestApp;

beforeAll(async () => {
  // Boots a private database, the real auth surface and the readiness probe;
  // the cold connect belongs in this hook, never inside a timed spec.
  app = await startTestApp({ prefix: "op106-read" });
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

/** Seed the full `subscriptions` row shape (schema §14.3) for a tenant. */
async function seedSubscription(overrides: {
  tenantId: string;
  status: "incomplete" | "active" | "past_due" | "downgraded" | "cancelled" | "expired";
  activePlanKey?: string;
  subscribedPlanKey?: string;
  mandateStatus?: "pending" | "active" | "paused" | "revoked" | "expired" | null;
  gracePeriodEndsAt?: Date | null;
  pendingDueMinor?: number;
  cancelAt?: Date | null;
  scheduledChange?: { toPlanKey: string; effectiveAt: Date; reason: string } | null;
  updatedAt?: Date;
  statusHistory?: { from: string; to: string; at: Date; reason: string; actor: string }[];
}): Promise<void> {
  const activePlanKey = overrides.activePlanKey ?? "starter";
  await app.db.collection(COLLECTIONS.subscriptions).insertOne({
    tenantId: overrides.tenantId,
    subscribedPlanKey: overrides.subscribedPlanKey ?? activePlanKey,
    subscribedPlanVersion: 3,
    activePlanKey,
    status: overrides.status,
    priceKey: "starter-monthly-inr",
    paymentMethodKind: "mandate_upi",
    mandateStatus: overrides.mandateStatus === undefined ? "active" : overrides.mandateStatus,
    billingCycle: "monthly",
    currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
    nextChargeAt: new Date("2026-10-01T00:00:00.000Z"),
    gracePeriodEndsAt: overrides.gracePeriodEndsAt ?? null,
    pendingDueMinor: overrides.pendingDueMinor ?? 0,
    currency: "INR",
    dunning: { attemptCount: 0, lastAttemptAt: null, remindersSent: [], nextReminderAt: null },
    cancelAt: overrides.cancelAt ?? null,
    cancelledAt: null,
    cancelReason: null,
    scheduledChange: overrides.scheduledChange ?? null,
    previousSubscriptionId: null,
    statusHistory: overrides.statusHistory ?? [],
    // A provider-shaped ref: the §0.15 never-return rule says this must not be
    // served to a client (`externalRefs` is "never" exposed).
    externalRefs: [{ provider: "cashfree", id: "cf_sub_0001" }],
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-09-01T00:00:00.000Z"),
  });
}

/** A `GET /tenants/{t}/subscription` request carrying a session cookie. */
function subscriptionRequest(cookie: string, tenantId: string): Request {
  return new Request(new URL(`${TENANTS_PATH}/${tenantId}/subscription`, APP_ORIGIN), {
    method: "GET",
    headers: { cookie },
  });
}

/** The error envelope of a failed response. */
async function errorEnvelope(response: Response): Promise<{ code: string }> {
  const parsed = await body(response);
  return parsed.error as { code: string };
}

describe("GET /api/v1/tenants/{tenantId}/subscription", () => {
  it("I1: a workspace with no subscription document reads as the explicit free state, not a 404", async () => {
    const owner = await app.signIn(makeIdentity("op106-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op106-free",
    });

    const response = await getSubscription(
      subscriptionRequest(owner.cookie, tenantId.toHexString())
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-tenant-id")).toBe(tenantId.toHexString());

    const payload = await body(response);
    expect(() => subscriptionBodySchema.parse(payload)).not.toThrow();
    expect(payload).toMatchObject({
      tenantId: tenantId.toHexString(),
      exists: false,
      status: "none",
      activePlanKey: "free",
      subscribedPlanKey: "free",
      pendingDue: null,
      banner: null,
      actions: {
        canUpgrade: true,
        canDowngrade: false,
        canCancel: false,
        canRetryCharge: false,
        mustCompleteMandate: false,
      },
    });
  });

  it("I1: the free state never leaks the driver's `_id` or the provider refs a stored row would carry", async () => {
    const owner = await app.signIn(makeIdentity("op106-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op106-free",
    });

    const response = await getSubscription(
      subscriptionRequest(owner.cookie, tenantId.toHexString())
    );
    expect(response.status).toBe(200);
    const payload = await body(response);

    // The body is the real free state (so this is not vacuous on an empty body)…
    expect(payload.status).toBe("none");
    expect(payload.exists).toBe(false);
    // …and it carries neither the driver's `_id` nor the provider refs a stored
    // row holds (§0.15 never-return rules).
    expect(payload).not.toHaveProperty("_id");
    expect(payload).not.toHaveProperty("externalRefs");
  });

  it("I2: a past_due document serves the critical banner with the mandatory reassurance and the downgrade deadline", async () => {
    const owner = await app.signIn(makeIdentity("op106-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op106-past-due",
    });
    const grace = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    await seedSubscription({
      tenantId: tenantId.toHexString(),
      status: "past_due",
      gracePeriodEndsAt: grace,
      pendingDueMinor: 49900,
    });

    const response = await getSubscription(
      subscriptionRequest(owner.cookie, tenantId.toHexString())
    );

    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(() => subscriptionBodySchema.parse(payload)).not.toThrow();
    expect(payload).toMatchObject({
      exists: true,
      status: "past_due",
      activePlanKey: "starter",
      subscribedPlanKey: "starter",
      mandateStatus: "active",
      gracePeriodEndsAt: grace.toISOString(),
      pendingDue: { amountMinor: 49900, currency: "INR" },
      actions: {
        canUpgrade: true,
        canDowngrade: true,
        canCancel: true,
        canRetryCharge: true,
        mustCompleteMandate: false,
      },
      banner: {
        kind: "past_due",
        severity: "critical",
        downgradeOn: grace.toISOString(),
        reassurance: expect.stringMatching(/nothing has been deleted/i),
      },
    });

    const banner = payload.banner as { daysRemaining?: number };
    expect(typeof banner.daysRemaining).toBe("number");
    expect(banner.daysRemaining).toBeGreaterThanOrEqual(0);
  });

  it("I2: a downgraded document reassures even though the active plan is already free", async () => {
    const owner = await app.signIn(makeIdentity("op106-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op106-downgraded",
    });
    await seedSubscription({
      tenantId: tenantId.toHexString(),
      status: "downgraded",
      activePlanKey: "free",
      subscribedPlanKey: "starter",
      pendingDueMinor: 49900,
    });

    const response = await getSubscription(
      subscriptionRequest(owner.cookie, tenantId.toHexString())
    );
    expect(response.status).toBe(200);

    const payload = await body(response);

    expect(payload).toMatchObject({
      exists: true,
      status: "downgraded",
      activePlanKey: "free",
      subscribedPlanKey: "starter",
      banner: {
        kind: "downgraded",
        severity: "critical",
        reassurance: expect.stringMatching(/nothing has been deleted/i),
      },
    });
  });

  it("I2: an active subscription with a revoked mandate warns without the payment banner", async () => {
    const owner = await app.signIn(makeIdentity("op106-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op106-revoked",
    });
    await seedSubscription({
      tenantId: tenantId.toHexString(),
      status: "active",
      mandateStatus: "revoked",
    });

    const response = await getSubscription(
      subscriptionRequest(owner.cookie, tenantId.toHexString())
    );
    expect(response.status).toBe(200);

    const payload = await body(response);

    expect(payload).toMatchObject({
      status: "active",
      mandateStatus: "revoked",
      banner: { kind: "mandate_revoked", severity: "important" },
      // The mandate is not chargeable, so "Pay now" must be withheld.
      actions: { canRetryCharge: false, canUpgrade: true },
    });
  });

  /**
   * OP-106 follow-up (card `t_09e53bea`): the projection's edges the OP-106
   * RED/GREEN left unpinned. These are **characterisation pins** — they lock the
   * shipped behaviour of `readSubscriptionView` exactly as merged (PR #294,
   * ADR-0401) rather than driving new code. A failure here means the shipped
   * behaviour changed, not that the pin is wrong.
   */
  describe("the served projection's unpinned edges (OP-106 follow-up)", () => {
    it("serves `pendingDue: null` when the stored `pendingDueMinor` is zero (the projection gates on `> 0`)", async () => {
      const owner = await app.signIn(makeIdentity("op106-owner"));
      const tenantId = await seedWorkspace({
        userId: owner.userId,
        role: "owner",
        slug: "op106-zero-due",
      });
      // Only the positive case (`49900`) and the free state were pinned before;
      // a stored zero must not surface as `{ amountMinor: 0, currency: "INR" }`.
      await seedSubscription({
        tenantId: tenantId.toHexString(),
        status: "active",
        pendingDueMinor: 0,
      });

      const response = await getSubscription(
        subscriptionRequest(owner.cookie, tenantId.toHexString())
      );

      expect(response.status).toBe(200);
      const payload = await body(response);
      expect(() => subscriptionBodySchema.parse(payload)).not.toThrow();
      expect(payload.status).toBe("active");
      expect(payload.exists).toBe(true);
      expect(payload.pendingDue).toBeNull();
    });

    it("serializes a stored `scheduledChange.effectiveAt` and `updatedAt` as RFC 3339 strings", async () => {
      const owner = await app.signIn(makeIdentity("op106-owner"));
      const tenantId = await seedWorkspace({
        userId: owner.userId,
        role: "owner",
        slug: "op106-scheduled-change",
      });
      const effectiveAt = new Date("2026-11-01T00:00:00.000Z");
      const updatedAt = new Date("2026-10-15T10:30:00.000Z");
      await seedSubscription({
        tenantId: tenantId.toHexString(),
        status: "active",
        scheduledChange: { toPlanKey: "pro", effectiveAt, reason: "upgrade_at_period_end" },
        updatedAt,
      });

      const response = await getSubscription(
        subscriptionRequest(owner.cookie, tenantId.toHexString())
      );

      expect(response.status).toBe(200);
      const payload = await body(response);
      expect(() => subscriptionBodySchema.parse(payload)).not.toThrow();
      expect(payload).toMatchObject({
        scheduledChange: {
          toPlanKey: "pro",
          effectiveAt: effectiveAt.toISOString(),
          reason: "upgrade_at_period_end",
        },
        updatedAt: updatedAt.toISOString(),
      });
      // The dates crossed the wire as RFC 3339 strings, never as `Date` objects.
      const scheduledChange = payload.scheduledChange as { effectiveAt: unknown };
      expect(typeof scheduledChange.effectiveAt).toBe("string");
      expect(typeof payload.updatedAt).toBe("string");
    });

    it("serves `scheduledChange: null` and still serializes `updatedAt` for a row with no scheduled change", async () => {
      const owner = await app.signIn(makeIdentity("op106-owner"));
      const tenantId = await seedWorkspace({
        userId: owner.userId,
        role: "owner",
        slug: "op106-no-scheduled-change",
      });
      const updatedAt = new Date("2026-10-16T08:00:00.000Z");
      await seedSubscription({
        tenantId: tenantId.toHexString(),
        status: "active",
        updatedAt,
      });

      const response = await getSubscription(
        subscriptionRequest(owner.cookie, tenantId.toHexString())
      );

      expect(response.status).toBe(200);
      const payload = await body(response);
      expect(() => subscriptionBodySchema.parse(payload)).not.toThrow();
      expect(payload.scheduledChange).toBeNull();
      expect(payload.updatedAt).toBe(updatedAt.toISOString());
    });

    it("characterization: with two rows at an equal `updatedAt`, the read serves the row inserted first", async () => {
      const owner = await app.signIn(makeIdentity("op106-owner"));
      const equalUpdatedAt = new Date("2026-10-20T00:00:00.000Z");

      // ADR-0400 §1 pins the served row as the tenant's *most recently updated*
      // one, but `findOne({}, { sort: { updatedAt: -1 } })` gives MongoDB no
      // tie-break: on an equal `updatedAt` the order is unspecified (ADR-0401
      // §Consequences calls this out). This pin fixes the **shipped** answer for
      // this harness — the collection's natural (insertion) order — so a future
      // `sort` change that prefers the live/active row is a visible break, not a
      // silent one. If product wants "the live row wins", that is a new RED.
      const liveFirst = await seedWorkspace({
        userId: owner.userId,
        role: "owner",
        slug: "op106-tie-live-first",
      });
      await seedSubscription({
        tenantId: liveFirst.toHexString(),
        status: "active",
        updatedAt: equalUpdatedAt,
      });
      await seedSubscription({
        tenantId: liveFirst.toHexString(),
        status: "cancelled",
        updatedAt: equalUpdatedAt,
      });

      const cancelledFirst = await seedWorkspace({
        userId: owner.userId,
        role: "owner",
        slug: "op106-tie-cancelled-first",
      });
      await seedSubscription({
        tenantId: cancelledFirst.toHexString(),
        status: "cancelled",
        updatedAt: equalUpdatedAt,
      });
      await seedSubscription({
        tenantId: cancelledFirst.toHexString(),
        status: "active",
        updatedAt: equalUpdatedAt,
      });

      const liveFirstPayload = await body(
        await getSubscription(subscriptionRequest(owner.cookie, liveFirst.toHexString()))
      );
      const cancelledFirstPayload = await body(
        await getSubscription(subscriptionRequest(owner.cookie, cancelledFirst.toHexString()))
      );

      // The served row tracks *insertion order*, not the status: inserting the
      // live row first serves `active`, inserting the cancelled row first serves
      // `cancelled`. Neither row is preferred by its status.
      expect(liveFirstPayload.status).toBe("active");
      expect(cancelledFirstPayload.status).toBe("cancelled");
    });

    it("characterization: a terminal `cancelled` row that still carries `cancelAt` renders the `cancelling` banner", async () => {
      const owner = await app.signIn(makeIdentity("op106-owner"));
      const tenantId = await seedWorkspace({
        userId: owner.userId,
        role: "owner",
        slug: "op106-terminal-cancel-at",
      });
      const cancelAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
      // ADR-0400 §1 row 5 (`cancelAt` set → `cancelling`) is unconditional and
      // does not exclude a terminal status; ADR-0401 §Consequences records that
      // nothing seeded this combination. This pin fixes the **shipped** answer:
      // a `cancelled` row that still carries a `cancelAt` renders `cancelling`.
      // If product decides the banner must be suppressed on a terminal status,
      // that is a RED + GREEN change to ADR-0400 row 5 — not a silent edit here.
      await seedSubscription({
        tenantId: tenantId.toHexString(),
        status: "cancelled",
        cancelAt,
      });

      const response = await getSubscription(
        subscriptionRequest(owner.cookie, tenantId.toHexString())
      );

      expect(response.status).toBe(200);
      const payload = await body(response);
      expect(() => subscriptionBodySchema.parse(payload)).not.toThrow();
      expect(payload).toMatchObject({
        status: "cancelled",
        cancelAt: cancelAt.toISOString(),
        banner: { kind: "cancelling", severity: "informational" },
      });
    });
  });

  it("I3: a signed-in co-organizer with no tenant membership gets the uniform 404", async () => {
    const owner = await app.signIn(makeIdentity("op106-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op106-outsider",
    });
    await seedSubscription({
      tenantId: tenantId.toHexString(),
      status: "active",
      pendingDueMinor: 0,
    });

    // A different, perfectly valid identity that was never added to the tenant.
    const outsider = await app.signIn(makeIdentity("op106-outsider"));

    const response = await getSubscription(
      subscriptionRequest(outsider.cookie, tenantId.toHexString())
    );

    expect(response.status).toBe(404);
    expect(await errorEnvelope(response)).toMatchObject({ code: "not_found" });
  });

  it("I3: a plain workspace member may read the same body (the 404 is about membership, not the role)", async () => {
    const owner = await app.signIn(makeIdentity("op106-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op106-member",
    });
    const member = await app.signIn(makeIdentity("op106-member"));
    await addMember(tenantId, member, "member");
    await seedSubscription({
      tenantId: tenantId.toHexString(),
      status: "active",
      pendingDueMinor: 0,
    });

    const response = await getSubscription(
      subscriptionRequest(member.cookie, tenantId.toHexString())
    );

    expect(response.status).toBe(200);
    const payload = await body(response);
    // Membership is enough to read; it is not enough to act (§3.3 is owner-only).
    expect(payload).toMatchObject({
      status: "active",
      actions: {
        canUpgrade: false,
        canDowngrade: false,
        canCancel: false,
        canRetryCharge: false,
        mustCompleteMandate: false,
      },
    });
  });

  it("rejects an unauthenticated caller with 401 before any tenancy resolution", async () => {
    const owner = await app.signIn(makeIdentity("op106-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op106-anon",
    });

    const response = await getSubscription(
      new Request(new URL(`${TENANTS_PATH}/${tenantId.toHexString()}/subscription`, APP_ORIGIN), {
        method: "GET",
      })
    );

    expect(response.status).toBe(401);
    expect(await errorEnvelope(response)).toMatchObject({ code: "authentication_required" });
  });
});
