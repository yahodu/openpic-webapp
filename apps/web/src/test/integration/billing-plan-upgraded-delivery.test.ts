import { randomUUID } from "node:crypto";

import { ObjectId } from "mongodb";
import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { POST as upgradePlan } from "@/app/api/v1/tenants/[tenantId]/billing/upgrade/route";
import { memoryMessageTransport } from "@/server/adapters/memory-message-transport";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { runNotificationFanOut, type FanOutSummary } from "@/server/notifications/fan-out";
import type { OutboundMessage } from "@/server/notifications/message-transport";
import { invalidateNotificationTypeCache } from "@/server/notifications/notification-type-cache";
import {
  seedNotificationTemplates,
  seedNotificationTypes,
} from "@/server/notifications/seed-notification-types";
import { seedPlans } from "@/server/plans/seed-plans";
import { mongoRecipientRepository } from "@/server/repos/notification-recipients";

import {
  makeCashfreeCreateSubscriptionResponse,
  TEST_CASHFREE_WEBHOOK_SECRET,
} from "../factories/payment";
import {
  APP_ORIGIN,
  makeIdentity,
  startTestApp,
  type SignedInUser,
  type TestApp,
} from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { server } from "./setup";

/**
 * Integration / contract — the billing-contact actor exemption is
 * **audience-scoped, not `typeKey`-scoped** (OP-101 review finding F1;
 * [ADR-0978](../../../../../docs/adr/ADR-0978-op101-billing-downgrade-scheduled-event.md)
 * §D3; pins recorded in
 * [ADR-0981](../../../../../docs/adr/ADR-0981-op101-actor-exemption-audience-scope-pins.md),
 * which is the record that names this file as its consumer).
 *
 * `resolveRecipients` removes an event's actor from the audience — except when
 * the audience itself named that actor as the **billing contact**. ADR-0978 §D3
 * says why the exemption cannot be keyed on the event type: §4.3 makes the payer
 * the recipient of a billing-type notification with no actor exclusion, and only
 * §4.5's event-lifecycle audiences carry "minus the actor". `billing_contact` is
 * the audience of `BILLING` alone, so the rule is a property of the *audience*;
 * scoping it to the one type that happened to motivate it re-introduces the bug
 * for every other type in that audience.
 *
 * ## The discriminator
 *
 * `billing.plan.upgraded` is the only other `BILLING`-audience type emitted with
 * a user actor today (`POST …/billing/upgrade`, `upgrade/route.ts:389-391`). It
 * is therefore the narrowest case that separates the two candidate rules:
 *
 * - **audience-scoped (shipped):** the owner *is* the billing contact
 *   (`provisioning.ts:162`), so the upgrade reaches them — one feed row, one
 *   rendered email;
 * - **`typeKey`-scoped (rejected):** the exemption applies to
 *   `billing.plan.downgrade_scheduled` only, so the upgraded event's actor is
 *   spliced out and the event reaches **nobody** — zero rows, zero email.
 *
 * The downgrade spec's `D1`–`D3`
 * (`billing-downgrade-scheduled-event.test.ts`) pin the same rule for the type
 * that motivated it and cannot tell the two rules apart by construction. The
 * non-billing half of the rule — an actor in an `organizer` / `co_organizer` /
 * `attendee_identified` audience is still removed — is pinned at
 * `server/notifications/fan-out.test.ts:265-280` and is deliberately **not**
 * duplicated here.
 *
 *   F1D  the owner upgrades, is the billing contact, and still receives the
 *        event: exactly one in-app row and exactly one rendered, sent email;
 *        anti-vacuity: the outbox row was `pending` before the drain and its
 *        `dispatch.notifications` flag is `done` after it, so "zero rows"
 *        cannot pass because the consumer never ran;
 *   F1E  the anti-leak half *on this type*: when the billing contact is a
 *        different active member, the contact receives the event and the
 *        owner-actor does not, though both are deliverable — the sibling of
 *        the downgrade spec's `D2`, one type over.
 *
 * ## Contract expected of the implementation
 *
 * None — this pack changes no production file. It pins the shipped behaviour of
 * `apps/web/src/server/notifications/fan-out.ts` (`:403-408` fills the `payers`
 * set in the `billing_contact` arm, `:425` skips an actor in that set) through
 * the HTTP surface, the real `runNotificationFanOut` consumer, the real seeded
 * catalogue (`SEED_NOTIFICATION_TYPES` / `SEED_NOTIFICATION_TEMPLATES`) and the
 * real `mongoRecipientRepository`; only the outbound transport is in memory.
 *
 * ## Red / green on arrival
 *
 * Both cases are **green on the shipped tree** — the shipped rule is the one
 * ADR-0978 §D3 decided. Their red is measured against the rejected variant: with
 * `const typeKeyScoped = typeRow.typeKey === "billing.plan.downgrade_scheduled"`
 * gating the exemption, `F1D` and `F1E` both read zero feed rows (measured in
 * ADR-0981 §Evidence).
 *
 * ## Assumptions recorded in the handoff
 *
 * - "The owner is the billing contact" is seeded the way `provisioning.ts:162`
 *   provisions a workspace (`billingContactUserId === ownerUserId`), not by
 *   re-running tenant provisioning.
 * - Both recipients are seeded deliverable (verified email, all channels on, no
 *   quiet hours), so a delivery pin can only fail on the audience.
 * - The upgrade's vendor calls are MSW-intercepted at the pinned sandbox
 *   endpoints (ADR-0460 §1); the request is a contract-level call to the route
 *   handler, as `billing-plan-change.test.ts` does.
 */

const TENANTS_PATH = "/api/v1/tenants";

/** The catalogue key under test (ADR-0978 §D3's stated side effect). */
const EVENT_KEY = "billing.plan.upgraded";

/** The live row's plan before the upgrade (tierRank 1). */
const SOURCE_PLAN_KEY = "starter";

/** The upgrade's target plan (tierRank 2). */
const TARGET_PLAN_KEY = "professional";

/** The vendor subscription id the pre-existing (starter) mandate carries. */
const OLD_VENDOR_SUBSCRIPTION_ID = "cf_prev_002";

/** The Cashfree create-subscription endpoint the adapter calls. */
const CASHFREE_CREATE_URL = "https://sandbox.cashfree.com/pg/subscriptions";

/** The pinned v2025-01-01 Manage Subscription endpoint (ADR-0460 §1). */
const CASHFREE_MANAGE_URL = "https://sandbox.cashfree.com/pg/subscriptions/:subscriptionId/manage";

/** The fixed vendor decision expiry the create fixture carries (already UTC `Z`). */
const FIXTURE_EXPIRES_AT = "2026-11-01T05:00:46.000Z";

/** The hosted link the upgrade's fresh mandate answers with. */
const NEW_CHECKOUT_URL = "https://payments-test.cashfree.com/links/upgrade-002";

/** The payments selection this suite drives the route with. */
const PAYMENTS_ENV: Record<string, string> = {
  PAYMENT_PROVIDER: "cashfree",
  CASHFREE_CLIENT_ID: "test-client-id",
  CASHFREE_CLIENT_SECRET: "test-client-secret",
  CASHFREE_API_VERSION: "2025-01-01",
  CASHFREE_WEBHOOK_SECRET: TEST_CASHFREE_WEBHOOK_SECRET,
};

/** The `returnUrl` every accepted upgrade carries (an allow-listed origin). */
const RETURN_URL = new URL("/billing/return", APP_ORIGIN).toString();

/** The live row's period end (a fixed, already-UTC instant). */
const PERIOD_END = new Date("2026-12-01T00:00:00.000Z");

/** The Better Auth user collection (schema §13.1). */
const USER_COLLECTION = "user";

/** One stored outbox row, as this spec reads it (schema §18.3). */
interface StoredEvent {
  readonly eventKey: string;
  readonly tenantId: string;
  readonly actorRef: { readonly kind: string; readonly id: string };
  readonly dispatch: {
    readonly notifications: string;
    readonly analytics: string;
    readonly queue: string;
  };
  readonly [key: string]: unknown;
}

/** One stored in-app feed row (schema §19.4). */
interface StoredNotification {
  readonly tenantId?: unknown;
  readonly userId?: unknown;
  readonly typeKey?: unknown;
  readonly title?: unknown;
  readonly body?: unknown;
  readonly [key: string]: unknown;
}

/** One stored dispatch attempt (schema §19.5). */
interface StoredDispatch {
  readonly tenantId?: unknown;
  readonly userId?: unknown;
  readonly typeKey?: unknown;
  readonly channel?: unknown;
  readonly status?: unknown;
  readonly skipReason?: unknown;
  readonly subject?: unknown;
  readonly body?: unknown;
  readonly [key: string]: unknown;
}

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op101-upgraded-delivery", env: PAYMENTS_ENV });
  // The upgrade resolves the sold price and both plans' tiers from the
  // catalogue, so the four seeded tiers must be present (§14.1).
  await seedPlans({ db: app.db });
  // §3.3's one-live-row invariant is arbitrated by the partial index
  // `subscriptions_active_tenant_unique`.
  await ensureIndexes(app.db);
  // The real routing catalogue and the real copy — the delivery cases must not
  // pass over a missing type or template.
  await seedNotificationTypes({ db: app.db });
  await seedNotificationTemplates({ db: app.db });
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

beforeEach(() => {
  invalidateNotificationTypeCache();
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** Merge fields into a caller's auto-provisioned `userProfiles` row. */
async function updateProfile(userId: ObjectId, fields: Record<string, unknown>): Promise<void> {
  const result = await app.db
    .collection(COLLECTIONS.userProfiles)
    .updateOne({ userId }, { $set: { ...fields, updatedAt: new Date() } });
  expect(result.matchedCount).toBe(1);
}

/**
 * Insert a tenant (schema §13.3) and return its id.
 *
 * `billingContactUserId` defaults to the owner, which is what
 * `provisioning.ts:162` stores when a workspace is created.
 */
async function insertTenant(fields: {
  readonly slug: string;
  readonly ownerUserId: ObjectId;
  readonly billingContactUserId?: ObjectId;
}): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.tenants).insertOne({
    _id,
    slug: fields.slug,
    name: "OP101 Upgraded Studio",
    status: "active",
    ownerUserId: fields.ownerUserId,
    billingContactUserId: fields.billingContactUserId ?? fields.ownerUserId,
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

/** Seed a workspace owned by `user`, with `user` as an active owner member. */
async function seedWorkspace(options: {
  readonly userId: ObjectId;
  readonly slug: string;
}): Promise<ObjectId> {
  const tenantId = await insertTenant({ slug: options.slug, ownerUserId: options.userId });
  await app.db.collection(COLLECTIONS.tenantMembers).insertOne({
    tenantId,
    userId: options.userId,
    role: "owner",
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

/**
 * Seed the workspace's live `subscriptions` row (schema §14.3) and return it.
 *
 * `cancelledAt` stays `null` so the row occupies the
 * `subscriptions_active_tenant_unique` slot the upgrade must release, and the
 * `externalRefs` entry is the mandate the route cancels before it creates the
 * new one.
 */
async function seedSubscription(options: {
  readonly tenantId: string;
  readonly planKey: string;
  readonly priceKey: string;
}): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.subscriptions).insertOne({
    _id,
    tenantId: options.tenantId,
    subscribedPlanKey: options.planKey,
    subscribedPlanVersion: 1,
    activePlanKey: options.planKey,
    status: "active",
    priceKey: options.priceKey,
    billingCycle: "monthly",
    paymentMethodKind: "mandate_upi",
    mandateStatus: "active",
    currentPeriodStart: new Date("2026-11-01T00:00:00.000Z"),
    currentPeriodEnd: PERIOD_END,
    nextChargeAt: PERIOD_END,
    gracePeriodEndsAt: null,
    pendingDueMinor: 0,
    currency: "INR",
    dunning: { attemptCount: 0, lastAttemptAt: null, remindersSent: [], nextReminderAt: null },
    cancelAt: null,
    cancelledAt: null,
    cancelReason: null,
    scheduledChange: null,
    previousSubscriptionId: null,
    statusHistory: [],
    externalRefs: [
      {
        provider: "cashfree",
        env: "sandbox",
        kind: "subscription",
        id: OLD_VENDOR_SUBSCRIPTION_ID,
      },
    ],
    createdAt: new Date("2026-11-01T00:00:00.000Z"),
    updatedAt: new Date("2026-11-01T00:00:00.000Z"),
  });
  return _id;
}

/**
 * Make a recipient deliverable: a verified email and all-on, quiet-hours-free
 * preferences (so a delivery pin can fail only on the audience, never on the
 * recipient's own settings).
 */
async function seedDeliverableRecipient(userId: ObjectId): Promise<void> {
  await app.db
    .collection(USER_COLLECTION)
    .updateOne({ _id: userId }, { $set: { emailVerified: true } });
  await app.db.collection(COLLECTIONS.notificationPreferences).updateOne(
    { userId },
    {
      $set: {
        userId,
        global: { in_app: "on", email: "on", mobile: "on" },
        byType: {},
        byEvent: {},
        quietHours: { enabled: false, start: "22:00", end: "07:00", timeZone: "Asia/Kolkata" },
        locale: "en-IN",
      },
    },
    { upsert: true }
  );
}

/** The §3.3 upgrade body for the seeded `professional` tier. */
function upgradeBody(): Record<string, unknown> {
  return {
    targetPlanKey: TARGET_PLAN_KEY,
    priceKey: "professional-monthly-inr",
    returnUrl: RETURN_URL,
  };
}

/** A `POST …/billing/upgrade` request as the caller's session sends it. */
function upgradeRequest(options: {
  readonly tenantPath: string;
  readonly cookie: string;
  readonly idempotencyKey: string;
}): Request {
  return new Request(new URL(`${TENANTS_PATH}/${options.tenantPath}/billing/upgrade`, APP_ORIGIN), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: options.cookie,
      "idempotency-key": options.idempotencyKey,
    },
    body: JSON.stringify(upgradeBody()),
  });
}

/**
 * The vendor's Manage Subscription response, as Cashfree v2025-01-01 answers it.
 *
 * The create-response superset with a terminal status, so it satisfies the
 * adapter's manage-call schema whichever of the two candidate shapes it reads.
 */
function makeManageResponse(vendorSubscriptionId: string): Record<string, unknown> {
  return {
    ...makeCashfreeCreateSubscriptionResponse({
      subscription_id: vendorSubscriptionId,
      subscription_status: "CANCELLED",
    }),
    subscription_first_charge_time: null,
    next_schedule_date: null,
  };
}

/** Answer the upgrade's two vendor calls (cancel, then create). */
function recordProviderCalls(): void {
  server.use(
    http.post(CASHFREE_MANAGE_URL, ({ params }) =>
      HttpResponse.json(makeManageResponse(String(params.subscriptionId)))
    ),
    http.post(CASHFREE_CREATE_URL, () =>
      HttpResponse.json(
        makeCashfreeCreateSubscriptionResponse({
          subscription_id: "sub_new_002",
          cf_subscription_id: "98765433",
          subscription_expiry_time: FIXTURE_EXPIRES_AT,
          auth_link: NEW_CHECKOUT_URL,
        })
      )
    )
  );
}

/**
 * Seed the fixture both cases start from: an owner-headed workspace with a live
 * `starter` subscription, and the vendor stubs the upgrade's two calls need.
 */
async function seedUpgradeFixture(prefix: string): Promise<{
  readonly owner: SignedInUser;
  readonly tenantId: string;
  readonly subscriptionId: ObjectId;
}> {
  const owner = await app.signIn(makeIdentity(`${prefix}-owner`));
  const tenantObjectId = await seedWorkspace({ userId: owner.userId, slug: prefix });
  const tenantId = tenantObjectId.toHexString();
  const subscriptionId = await seedSubscription({
    tenantId,
    planKey: SOURCE_PLAN_KEY,
    priceKey: "starter-monthly-inr",
  });
  recordProviderCalls();
  return { owner, tenantId, subscriptionId };
}

/** The workspace's stored outbox rows, oldest first. */
async function outboxRows(tenantId: string): Promise<StoredEvent[]> {
  return app.db
    .collection<StoredEvent>(COLLECTIONS.domainEvents)
    .find({ tenantId })
    .sort({ occurredAt: 1 })
    .toArray();
}

/** The workspace's stored in-app feed rows (schema §19.4). */
async function notificationsOf(tenantId: string): Promise<StoredNotification[]> {
  return app.db
    .collection<StoredNotification>(COLLECTIONS.notifications)
    .find({ tenantId })
    .toArray();
}

/** The workspace's stored dispatch attempts (schema §19.5). */
async function dispatchesOf(tenantId: string): Promise<StoredDispatch[]> {
  return app.db.collection<StoredDispatch>(COLLECTIONS.dispatches).find({ tenantId }).toArray();
}

/** What one drain of the outbox produced for the workspace (design §2, §5). */
interface DrainResult {
  readonly summary: FanOutSummary;
  readonly notifications: readonly StoredNotification[];
  readonly dispatches: readonly StoredDispatch[];
  readonly outbound: readonly OutboundMessage[];
}

/**
 * Drain the outbox with the **real** notification consumer.
 *
 * The catalogue, the templates and the recipient port are the shipped ones;
 * only the outbound transport is in memory, so the send is observable without a
 * provider. The returned rows are the workspace's own, filtered by `tenantId`,
 * so a case's delivery cannot be satisfied by a sibling case's rows.
 *
 * @param tenantId - The workspace the assertions belong to.
 * @returns The run summary, the feed rows, the dispatch rows and the rendered
 *   email bodies.
 */
async function drainOutbox(tenantId: string): Promise<DrainResult> {
  const transport = memoryMessageTransport();
  const summary = await runNotificationFanOut({
    db: app.db,
    transport,
    recipients: mongoRecipientRepository(app.db),
    claimerId: "spec.op101-upgraded-delivery",
  });

  const notifications = await notificationsOf(tenantId);
  const dispatches = await dispatchesOf(tenantId);

  return { summary, notifications, dispatches, outbound: transport.outbox };
}

/** A stored field as text, or `""` when the field is not a string. */
function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The rendered email bodies one drain sent to one recipient. */
function emailsTo(messages: readonly OutboundMessage[], userId: ObjectId): string[] {
  return messages
    .filter((message) => message.channel === "email" && message.to.userId === userId.toHexString())
    .map((message) => message.text ?? message.html ?? message.subject ?? "");
}

/** The feed rows of the catalogue key under test, for one recipient. */
function feedRowsFor(rows: readonly StoredNotification[], userId: ObjectId): StoredNotification[] {
  return rows.filter(
    (row) => row.typeKey === EVENT_KEY && String(row.userId) === userId.toHexString()
  );
}

/** The dispatch rows of the catalogue key under test, for one recipient. */
function dispatchRowsFor(rows: readonly StoredDispatch[], userId: ObjectId): StoredDispatch[] {
  return rows.filter(
    (row) => row.typeKey === EVENT_KEY && String(row.userId) === userId.toHexString()
  );
}

/* -------------------------------------------------------------------------- */
/* F1D — the discriminator: audience-scoped, not `typeKey`-scoped (ADR-0978 §D3) */
/* -------------------------------------------------------------------------- */

describe(`billing.plan.upgraded — the payer who acted still receives it (ADR-0978 §D3)`, () => {
  it("F1D: delivers one in-app row and one rendered email to the owner who is the billing contact", async () => {
    const { owner, tenantId } = await seedUpgradeFixture("op101-f1d");
    await seedDeliverableRecipient(owner.userId);

    const response = await upgradePlan(
      upgradeRequest({ tenantPath: tenantId, cookie: owner.cookie, idempotencyKey: randomUUID() })
    );
    expect(response.status).toBe(201);

    // The request emitted exactly one row, and the consumer has not run yet.
    const pending = await outboxRows(tenantId);
    expect(pending.map((row) => row.eventKey)).toEqual([EVENT_KEY]);
    expect(pending[0]?.dispatch.notifications).toBe("pending");

    const drained = await drainOutbox(tenantId);

    // Anti-vacuity: this drain really carried the event — "zero rows" must not
    // be able to pass because the outbox was never claimed.
    expect(drained.summary.failed).toBe(0);
    const settled = await outboxRows(tenantId);
    expect(settled[0]?.dispatch.notifications).toBe("done");

    // `provisioning.ts:162` makes the owner the billing contact, so the payer
    // and the actor are the same person — and the payer still hears about it.
    // A `typeKey`-scoped exemption reads zero here.
    const feedRows = feedRowsFor(drained.notifications, owner.userId);
    expect(feedRows).toHaveLength(1);
    expect(textOf(feedRows[0]?.title).length).toBeGreaterThan(0);
    expect(textOf(feedRows[0]?.body).length).toBeGreaterThan(0);

    const emailRows = dispatchRowsFor(drained.dispatches, owner.userId).filter(
      (dispatch) => dispatch.channel === "email"
    );
    expect(emailRows).toHaveLength(1);
    expect(emailRows[0]?.status).toBe("sent");
    expect(emailRows[0]?.skipReason ?? null).toBeNull();
    const rendered = textOf(emailRows[0]?.body);
    // Rendered, not skipped: the stored body carries the copy, and exactly one
    // message left the transport carrying it.
    expect(rendered.length).toBeGreaterThan(0);
    expect(
      emailsTo(drained.outbound, owner.userId).filter((text) => text.includes(rendered))
    ).toHaveLength(1);
  });

  it("F1E: delivers to a different billing contact and not to the owner who upgraded", async () => {
    const { owner, tenantId } = await seedUpgradeFixture("op101-f1e");
    const contact = await app.signIn(makeIdentity("op101-f1e-billing-contact"));
    await addMember(new ObjectId(tenantId), contact, "member");
    await app.db
      .collection(COLLECTIONS.tenants)
      .updateOne(
        { _id: new ObjectId(tenantId) },
        { $set: { billingContactUserId: contact.userId } }
      );
    // Both callers are deliverable, so the only reason the owner is left out is
    // the audience — not an unverified contact or a switched-off channel.
    await seedDeliverableRecipient(owner.userId);
    await seedDeliverableRecipient(contact.userId);

    const response = await upgradePlan(
      upgradeRequest({ tenantPath: tenantId, cookie: owner.cookie, idempotencyKey: randomUUID() })
    );
    expect(response.status).toBe(201);

    const drained = await drainOutbox(tenantId);

    expect(drained.summary.failed).toBe(0);
    const settled = await outboxRows(tenantId);
    expect(settled[0]?.dispatch.notifications).toBe("done");

    // The exemption spares an id that the *billing_contact audience* resolved —
    // it does not spare the actor as such. A non-contact actor is still removed
    // (the mirror of the downgrade spec's `D2`, one type over).
    expect(feedRowsFor(drained.notifications, contact.userId)).toHaveLength(1);
    expect(feedRowsFor(drained.notifications, owner.userId)).toHaveLength(0);
    expect(
      dispatchRowsFor(drained.dispatches, contact.userId).filter(
        (dispatch) => dispatch.channel === "email" && dispatch.status === "sent"
      )
    ).toHaveLength(1);
    expect(dispatchRowsFor(drained.dispatches, owner.userId)).toHaveLength(0);
  });
});
