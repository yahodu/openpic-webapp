import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { POST as acceptInvitationTokenRoute } from "@/app/api/v1/invitations/[token]/accept/route";
import { hashInvitationToken } from "@/server/collaboration/invitations";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { invitationExpiryJob } from "@/server/jobs/invitation-expiry";
import { usageThresholdCheckJob } from "@/server/jobs/usage-threshold-check";
import { periodKey } from "@/server/services/entitlements";
import { fixedClock } from "@/server/runtime/clock";

import { makeSubscription, type SubscriptionFixture } from "../factories/entitlements";
import { makeEntitlement, makePlan } from "../factories/plan";
import {
  APP_ORIGIN,
  makeIdentity,
  startTestApp,
  type SignedInUser,
  type TestApp,
} from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { fixtureInstant } from "../helpers/fixture-clock";
import { recordingLogger } from "../helpers/recording-logger";

/**
 * Integration / contract — `usage-threshold-check` and `invitation-expiry`
 * (OP-136, contract §10.2, §9.10; schema §14.2, §13.6; ADR-0849).
 *
 * The user story: *as the platform I want allowance warnings latched per period
 * and invitations to expire on their own deadline, so nobody is warned twice
 * for the same crossing and a stale invite cannot be accepted.*
 *
 * ## The contract this file pins
 *
 * `@/server/jobs/usage-threshold-check` exports `usageThresholdCheckJob`:
 *
 * - a tenant-scoped `usageCounters` row is compared with the tenant's effective
 *   limit for its own `periodKey`; each crossed 80/95/100 % threshold emits one
 *   `usage.storage.threshold` / `usage.events.threshold` with
 *   `payload.threshold` and `payload.percent`;
 * - the latch is the counter row's `thresholdsNotified: number[]`, so a
 *   delete-then-re-cross in the **same** period notifies nothing, and a **new**
 *   period (a different `periodKey`, hence a different row) starts empty;
 * - `details.notified` counts the deliveries of that run.
 *
 * `@/server/jobs/invitation-expiry` exports `invitationExpiryJob`:
 *
 * - a `pending` invitation past `expiresAt` becomes `expired` and emits
 *   `collab.invite.expired` once;
 * - the later `POST /api/v1/invitations/{token}/accept` answers `410
 *   invitation_expired`;
 * - a T+3d reminder is emitted at most once for a still-pending invite that has
 *   already been reminded (`details.reminded`).
 */

const DAY_MS = 86_400_000;

/**
 * The instant every run in this file is timed at, anchored **two UTC days ahead
 * of the real day** (ADR-0939). `invitations` carries
 * `invitations_expire_at_ttl` (`{ expireAt: 1 }`, `expireAfterSeconds: 0`), and
 * mongod evaluates that index against the real wall clock, not against the
 * injected `fixedClock(NOW)`. A literal anchor would therefore seed rows that
 * are already TTL-expired (every `NOW − n days` fixture) or already past
 * (every `NOW + n days` fixture short of the real day) at insert time, and a
 * monitor pass could delete one between the seed and the read. The anchor is
 * derived at runtime so all `NOW ± n days` fixtures stay in the real future
 * while keeping their position relative to the injected clock. See ADR-0148 for
 * the shared helper and ADR-0939 for this file.
 */
const NOW = new Date(fixtureInstant("09:00:00.000Z", 2));

/** The tenant the usage fixtures are scoped to. */
const TENANT = "t_op136_usage";

/** The plan key the seeded plan and subscription agree on. */
const PLAN_KEY = "op136-plan";

let app: TestApp;

/** Seed the active plan: `storage.bytes` is per-tenant lifetime, `events.active` monthly. */
async function seedPlan(): Promise<void> {
  await app.db.collection(COLLECTIONS.plans).insertOne(
    makePlan({
      key: PLAN_KEY,
      entitlements: {
        "storage.bytes": makeEntitlement({
          limit: 1_000,
          resetPeriod: "lifetime",
          scope: "tenant",
          enforcement: "hard",
        }),
        "events.active": makeEntitlement({
          limit: 10,
          resetPeriod: "monthly",
          scope: "tenant",
          enforcement: "hard",
        }),
      },
    })
  );
}

/** Seed the live subscription that makes {@link PLAN_KEY} the active plan. */
async function seedActiveSubscription(): Promise<void> {
  const subscription: SubscriptionFixture = makeSubscription({
    tenantId: TENANT,
    subscribedPlanKey: PLAN_KEY,
    activePlanKey: PLAN_KEY,
    status: "active",
  });
  await app.db.collection(COLLECTIONS.subscriptions).insertOne(subscription);
}

/** Seed one usage counter row. */
async function seedCounter(input: {
  readonly entitlementKey: string;
  readonly periodKey: string;
  readonly value: number;
  readonly thresholdsNotified?: readonly number[];
}): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.usageCounters).insertOne({
    _id,
    tenantId: TENANT,
    entitlementKey: input.entitlementKey,
    periodKey: input.periodKey,
    value: input.value,
    updatedAt: NOW,
    ...(input.thresholdsNotified === undefined
      ? {}
      : { thresholdsNotified: [...input.thresholdsNotified] }),
  });
  return _id;
}

/** Set one counter's stored value (a delete or a fresh upload moves it). */
async function setCounterValue(entitlementKey: string, value: number): Promise<void> {
  await app.db
    .collection(COLLECTIONS.usageCounters)
    .updateOne({ tenantId: TENANT, entitlementKey }, { $set: { value } });
}

/** The stored latch of one counter row. */
async function latch(entitlementKey: string, period: string): Promise<unknown> {
  const row = await app.db
    .collection(COLLECTIONS.usageCounters)
    .findOne({ tenantId: TENANT, entitlementKey, periodKey: period });
  return row?.thresholdsNotified;
}

/** The outbox rows of one event key, oldest first. */
async function thresholdEvents(eventKey: string): Promise<Record<string, unknown>[]> {
  return app.db.collection(COLLECTIONS.domainEvents).find({ eventKey }).sort({ _id: 1 }).toArray();
}

beforeAll(async () => {
  app = await startTestApp({ prefix: "op136-usage-invites" });
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await Promise.all(
    [
      COLLECTIONS.plans,
      COLLECTIONS.subscriptions,
      COLLECTIONS.usageCounters,
      COLLECTIONS.entitlementGrants,
      COLLECTIONS.domainEvents,
      COLLECTIONS.invitations,
    ].map((name) => app.db.collection(name).deleteMany({}))
  );
});

afterAll(async () => {
  await app.cleanup();
});

describe("usage-threshold-check: the per-period latch", () => {
  it("I6: warns once for 80 %, stays silent after a drop and a re-cross, then warns for 95 %", async () => {
    await seedPlan();
    await seedActiveSubscription();
    await seedCounter({ entitlementKey: "storage.bytes", periodKey: "lifetime", value: 850 });

    // ── Act: 85 % ──
    const first = await usageThresholdCheckJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: one 80 % warning, latched ──
    const afterFirst = await thresholdEvents("usage.storage.threshold");
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]?.payload).toMatchObject({ threshold: 80, percent: 85 });
    expect(first.details?.notified).toBe(1);
    expect(await latch("storage.bytes", "lifetime")).toEqual([80]);

    // ── Act: the same 85 % on the next hourly tick ──
    const again = await usageThresholdCheckJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: silent ──
    expect(await thresholdEvents("usage.storage.threshold")).toHaveLength(1);
    expect(again.details?.notified).toBe(0);

    // ── Act: delete-then-re-cross inside the same period ──
    await setCounterValue("storage.bytes", 500);
    const afterDrop = await usageThresholdCheckJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });
    await setCounterValue("storage.bytes", 900);
    const afterReCross = await usageThresholdCheckJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: the latch holds — no second 80 % ──
    expect(afterDrop.details?.notified).toBe(0);
    expect(afterReCross.details?.notified).toBe(0);
    expect(await thresholdEvents("usage.storage.threshold")).toHaveLength(1);

    // ── Act: a genuinely new threshold ──
    await setCounterValue("storage.bytes", 960);
    const afterNinetyFive = await usageThresholdCheckJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: one 95 % warning, both latched ──
    const events = await thresholdEvents("usage.storage.threshold");
    expect(events).toHaveLength(2);
    expect(events[1]?.payload).toMatchObject({ threshold: 95, percent: 96 });
    expect(afterNinetyFive.details?.notified).toBe(1);
    expect(await latch("storage.bytes", "lifetime")).toEqual([80, 95]);
  });

  it("notifies the same threshold again in a new period", async () => {
    await seedPlan();
    await seedActiveSubscription();

    // The previous month is fully latched at 100 %.
    await seedCounter({
      entitlementKey: "events.active",
      periodKey: "2026-10",
      value: 10,
      thresholdsNotified: [80, 95, 100],
    });
    // The current month is at 90 % and has never been warned.
    await seedCounter({
      entitlementKey: "events.active",
      periodKey: periodKey("monthly", NOW),
      value: 9,
    });

    // ── Act ──
    const result = await usageThresholdCheckJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: the current period's row is warned, the previous one is not ──
    const events = await thresholdEvents("usage.events.threshold");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ threshold: 80, percent: 90 });
    expect(result.details?.notified).toBe(1);
    expect(await latch("events.active", periodKey("monthly", NOW))).toEqual([80]);
    // The elapsed row keeps its own latch verbatim: an elapsed period is not
    // re-announced, and it is not deleted to make that true (ADR-0851 §3).
    expect(await latch("events.active", "2026-10")).toEqual([80, 95, 100]);
  });

  it("leaves an elapsed period's row alone even when its own latch is behind", async () => {
    await seedPlan();
    await seedActiveSubscription();

    // The elapsed month is at 90 % of the limit with no latch recorded at all,
    // so a job that reads every counter row would warn for it.
    await seedCounter({ entitlementKey: "events.active", periodKey: "2026-09", value: 9 });
    // The current month is at 10 % — below the first threshold, so the run has
    // nothing live to warn about either way.
    await seedCounter({
      entitlementKey: "events.active",
      periodKey: periodKey("monthly", NOW),
      value: 1,
    });

    // ── Act ──
    const result = await usageThresholdCheckJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: the elapsed row neither warns nor latches ──
    expect(result.details?.notified).toBe(0);
    expect(await thresholdEvents("usage.events.threshold")).toHaveLength(0);
    expect(await latch("events.active", "2026-09")).toBeUndefined();
  });

  it("says nothing for an unlimited quota or a counter below the first threshold", async () => {
    await seedPlan();
    await seedActiveSubscription();
    await seedCounter({
      entitlementKey: "storage.bytes",
      periodKey: "lifetime",
      value: 100,
    });

    const result = await usageThresholdCheckJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    expect(result.details?.notified).toBe(0);
    expect(await thresholdEvents("usage.storage.threshold")).toHaveLength(0);
    expect(await latch("storage.bytes", "lifetime")).toBeUndefined();
  });
});

describe("invitation-expiry", () => {
  /** Seed one pending invitation, past its deadline, addressed at `invitee`. */
  async function seedExpiredInvitation(invitee: SignedInUser): Promise<{
    readonly invitationId: ObjectId;
    readonly token: string;
  }> {
    const invitationId = new ObjectId();
    const token = `op136-invitation-token-${invitationId.toHexString()}`;
    const tenantKey = new ObjectId().toHexString();
    await app.db.collection(COLLECTIONS.invitations).insertOne({
      _id: invitationId,
      kind: "event_co_organizer",
      tenantId: tenantKey,
      eventId: new ObjectId(),
      invitedByUserId: new ObjectId(),
      invitee: { kind: "user", userId: invitee.userId.toHexString() },
      status: "pending",
      role: "co_organizer",
      tokenHash: hashInvitationToken(token),
      channelsNotified: ["email"],
      expiresAt: new Date(NOW.getTime() - DAY_MS),
      expireAt: new Date(NOW.getTime() - DAY_MS),
      resolvedAt: null,
      resolvedVia: null,
      resolvedByUserId: null,
      revokedAt: null,
      revokedByUserId: null,
      revokeReason: null,
      createdAt: new Date(NOW.getTime() - 8 * DAY_MS),
      updatedAt: new Date(NOW.getTime() - 8 * DAY_MS),
      schemaVersion: 1,
    });
    return { invitationId, token };
  }

  /** A `POST /api/v1/invitations/{token}/accept` request. */
  function acceptRequest(cookie: string, token: string): Request {
    return new Request(new URL(`/api/v1/invitations/${token}/accept`, APP_ORIGIN), {
      method: "POST",
      headers: { cookie },
    });
  }

  it("I7: moves a pending invitation past its deadline to expired, and a later accept answers 410", async () => {
    const invitee = await app.signIn(makeIdentity("op136-invitee"));
    const seeded = await seedExpiredInvitation(invitee);

    // ── Act ──
    const result = await invitationExpiryJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: expired, announced once, counted ──
    const row = await app.db
      .collection(COLLECTIONS.invitations)
      .findOne({ _id: seeded.invitationId });
    expect(row?.status).toBe("expired");
    const expiredEvents = await app.db
      .collection(COLLECTIONS.domainEvents)
      .find({
        eventKey: "collab.invite.expired",
        "subjectRef.id": seeded.invitationId.toHexString(),
      })
      .toArray();
    expect(expiredEvents).toHaveLength(1);
    expect(result.details?.expired).toBe(1);

    // ── Act: the invitee clicks the link afterwards ──
    const response = await acceptInvitationTokenRoute(acceptRequest(invitee.cookie, seeded.token));

    // ── Assert: the terminal answer ──
    expect(response.status).toBe(410);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("invitation_expired");
  });

  it("leaves a pending invitation inside its window alone", async () => {
    const invitee = await app.signIn(makeIdentity("op136-invite-live"));
    const seeded = await seedExpiredInvitation(invitee);
    await app.db.collection(COLLECTIONS.invitations).updateOne(
      { _id: seeded.invitationId },
      {
        $set: {
          expiresAt: new Date(NOW.getTime() + DAY_MS),
          expireAt: new Date(NOW.getTime() + DAY_MS),
        },
      }
    );

    const result = await invitationExpiryJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    const row = await app.db
      .collection(COLLECTIONS.invitations)
      .findOne({ _id: seeded.invitationId });
    expect(row?.status).toBe("pending");
    expect(result.details?.expired).toBe(0);
  });

  it("reminds a still-pending invitation at most once after T+3d", async () => {
    const invitee = await app.signIn(makeIdentity("op136-invite-remind"));
    const seeded = await seedExpiredInvitation(invitee);
    // Back inside the window, but long enough lived to earn the reminder.
    await app.db.collection(COLLECTIONS.invitations).updateOne(
      { _id: seeded.invitationId },
      {
        $set: {
          expiresAt: new Date(NOW.getTime() + 4 * DAY_MS),
          expireAt: new Date(NOW.getTime() + 4 * DAY_MS),
          createdAt: new Date(NOW.getTime() - 4 * DAY_MS),
        },
      }
    );

    const first = await invitationExpiryJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });
    const second = await invitationExpiryJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    expect(first.details?.reminded).toBe(1);
    expect(second.details?.reminded).toBe(0);
    expect(
      await app.db.collection(COLLECTIONS.domainEvents).countDocuments({
        eventKey: "collab.invite.reminder",
        "subjectRef.id": seeded.invitationId.toHexString(),
      })
    ).toBe(1);
  });
});
