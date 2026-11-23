import { randomUUID } from "node:crypto";

import { Collection, ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as actOnNotification } from "@/app/api/v1/me/notifications/[id]/actions/[actionKey]/route";
import { POST as acceptByToken } from "@/app/api/v1/invitations/[token]/accept/route";
import { GET as readFeed } from "@/app/api/v1/me/notifications/route";
import { POST as createInvitation } from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/invitations/route";
import { DELETE as revokeInvitation } from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/invitations/[invitationId]/route";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { runNotificationFanOut } from "@/server/notifications/fan-out";
import { invalidateNotificationTypeCache } from "@/server/notifications/notification-type-cache";
import {
  seedNotificationTemplates,
  seedNotificationTypes,
} from "@/server/notifications/seed-notification-types";
import type { ChargeOnceInput, ChargeOnceResult } from "@/server/payments/payment-provider";
import { mongoRecipientRepository } from "@/server/repos/notification-recipients";
import { sha256Hex } from "@/server/runtime/crypto";
import { getNotificationTransport } from "@/server/services/notification-transport";

import { makeSubscription } from "../factories/entitlements";
import { makeEntitlement, makePlan } from "../factories/plan";
import { body } from "../helpers/auth-requests";
import {
  APP_ORIGIN,
  makeIdentity,
  startTestApp,
  type SignedInUser,
  type TestApp,
  type TestIdentity,
} from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { insertFeedRow } from "../helpers/notification-rows";

/**
 * Integration / contract — the delegating, idempotent notification action
 * endpoint (OP-140 I1–I7, contract §7.3, notification design §7).
 *
 * The user story: *as a user, I want to act on a notification (accept, pay now,
 * retry) from the feed so that the action is applied exactly once and every
 * channel reflects the decision.* Design §7 states the structural promise this
 * file measures:
 *
 * 1. **The endpoint owns no state.** A notification is a _pointer_ to an
 *    `invitations` / `subscriptions` / … document that owns the outcome; the
 *    endpoint resolves `actionTarget` and delegates. The denormalised
 *    `actions[].state` on the row is a convenience and is allowed to be stale,
 *    so the endpoint must **never** refuse an action because a cached state
 *    says `unavailable` — the owning document decides (I3 pins this: a revoked
 *    invitation still answers `410 invitation_revoked`, not `422`).
 * 2. **A second click is `200`, never `409`.** The delegated service performs
 *    one conditional transition and answers from the row's current state, so
 *    the endpoint's second call reports `already_resolved` with the channel
 *    that originally won (I1, I2).
 * 3. **The closure happens in every channel.** After a successful transition
 *    the same `notifications.updateMany` fan-out runs, so the response's own
 *    `actions` and the feed's next `GET` agree (I1, E1).
 * 4. **A notification is not a permission.** Authorization is re-checked by the
 *    delegated service, so a caller who lost the owner role since the
 *    notification was sent is refused `403` and nothing is charged (I4).
 *
 * ## Contract expected of the implementation
 *
 * ```
 * @/app/api/v1/me/notifications/[id]/actions/[actionKey]/route
 *   POST /api/v1/me/notifications/{id}/actions/{actionKey}   (Auth `user`,
 *                                                             rate `write.normal`)
 * ```
 *
 * - The caller's own row is loaded first; an unknown, malformed or **foreign**
 *   id is `404 not_found` (never `403`, so the endpoint is not an existence
 *   oracle).
 * - `actionKey` must be one of the row's `actions[].key` **and** one of the
 *   §7.3 rows the dispatch table knows; otherwise `422 validation_failed`.
 * - `200` always carries exactly the nine §7.3 keys
 *   `{ notificationId, actionKey, outcome, alreadyResolved, resolvedVia,
 *   targetState, actions, redirectUrl, message }`. `outcome` is `applied` on
 *   the transition, `already_resolved` on a replay, `unavailable` when the
 *   delegated service refuses to act; `410` only for a `revoked`/`expired`
 *   invitation, where the affordance must disappear rather than report success.
 * - `actions` is the notification's **refreshed** affordance, projected as
 *   `{ key, label, state }` pairs — the same row the next `GET /me/notifications`
 *   serves.
 * - The endpoint never calls another HTTP route: it delegates to the domain
 *   service (`decideInvitation` for the invitation rows; the billing retry
 *   service for `pay_now`).
 *
 * ## Assumptions (ADR-0942 §Assumptions)
 *
 * - **A-1** — the endpoint's `200` body is exactly the nine keys §7.3's example
 *   documents; nothing from the invitation/billing service leaks through it
 *   (no `id`, no `membership`, no `status`). A rich delegated answer is
 *   projected onto those nine keys.
 * - **A-2** — a `subscription` notification's `actionTarget.id` names the
 *   `subscriptions` row and the row's `tenantId` names the workspace whose
 *   owner may act; the delegated service re-checks the owner role for that
 *   workspace.
 * - **A-3** — a repeated `pay_now` is `already_resolved` and writes **no
 *   second charge intent**: the charge's idempotency key is derived from
 *   `notificationId + actionKey` (the card's scope note), so the ledger holds
 *   one `pending` charge for the notification and the payment provider is
 *   asked once. This is the "applied exactly once" half of the user story for
 *   the billing delegate.
 * - **A-4** — for `pay_now` the owning document is still `past_due` when the
 *   intent is written (the charge is confirmed by a webhook, never by this
 *   response), so `targetState` reports the subscription's own status.
 * - **A-5** — a refusal by the delegated service (`403`, `409`, `502`, …) is
 *   propagated with its own status and code; the endpoint invents no status of
 *   its own. I4 pins the `403 forbidden` shape a lost owner role produces.
 * - **A-6** — I2 seeds the invitee's feed row directly. The trunk's fan-out
 *   writes no in-app row for an **email** invitee (recipient resolution reads
 *   `invitee.userId`, stamped only by the OP-89 lazy hook, whose re-emit is
 *   deduped against the create-time key), and repairing that is OP-89's lane,
 *   not this endpoint's. The row is the schema §19.4 shape the feed serves; the
 *   token decision and its closure still run through the real routes.
 */

/** The nine keys every §7.3 action response carries. */
const ACTION_BODY_KEYS = [
  "actionKey",
  "actions",
  "alreadyResolved",
  "message",
  "notificationId",
  "outcome",
  "redirectUrl",
  "resolvedVia",
  "targetState",
];

/** The invitation type key whose feed row carries the accept/reject affordance. */
const INVITE_TYPE_KEY = "collab.invite.sent";

/** The outstanding amount the seeded `past_due` workspace owes, in minor units. */
const DUE_MINOR = 49_900;

/** The live mandate the seeded subscription points at (the memory provider). */
const MEMORY_MANDATE_ID = "mem_sub_op140_mandate";

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op140-actions" });
  await ensureIndexes(app.db);
  // The notification catalogue is production seed data: seeding it makes the
  // in-app affordance a real row written by the same fan-out the cron runs.
  await seedNotificationTypes({ db: app.db });
  await seedNotificationTemplates({ db: app.db });
  invalidateNotificationTypeCache();
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

beforeEach(async () => {
  for (const name of [
    COLLECTIONS.invitations,
    COLLECTIONS.events,
    COLLECTIONS.eventOrganizers,
    COLLECTIONS.tenants,
    COLLECTIONS.tenantMembers,
    COLLECTIONS.userProfiles,
    COLLECTIONS.plans,
    COLLECTIONS.subscriptions,
    COLLECTIONS.usageCounters,
    COLLECTIONS.entitlementGrants,
    COLLECTIONS.domainEvents,
    COLLECTIONS.dispatches,
    COLLECTIONS.notifications,
    COLLECTIONS.idempotencyKeys,
    COLLECTIONS.billingTransactions,
  ]) {
    await app.db.collection(name).deleteMany({});
  }
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** A workspace with its organizer signed in. */
interface Workspace {
  readonly tenantId: ObjectId;
  readonly organizer: SignedInUser;
}

/** An event in a workspace, ready to invite into. */
interface EventFixture {
  readonly workspace: Workspace;
  readonly eventId: ObjectId;
}

/** A workspace whose owner owes a retryable amount. */
interface BillingFixture {
  readonly tenantId: ObjectId;
  readonly owner: SignedInUser;
  readonly subscriptionId: ObjectId;
}

/**
 * Sign a caller in and stamp the profile a completed account has.
 *
 * @param identity - The identity to sign in (unique per case).
 * @returns The signed-in caller.
 */
async function signInVerified(identity: TestIdentity): Promise<SignedInUser> {
  const user = await app.signIn(identity);
  await app.db.collection(COLLECTIONS.userProfiles).updateOne(
    { userId: user.userId },
    {
      $set: {
        displayName: `Caller ${identity.email}`,
        accountCompletedAt: new Date("2026-01-03T00:00:00.000Z"),
        updatedAt: new Date("2026-01-03T00:00:00.000Z"),
      },
    }
  );
  return user;
}

/** A monotonically increasing unique access-link slug for seeded events. */
let seededSlugSeq = 0;

/**
 * Seed a workspace with an organizer, an event and a live co-organizer plan.
 *
 * @param prefix - A unique suite-local prefix (slug and plan key).
 * @returns The organizer's workspace and the event.
 */
async function seedEvent(prefix: string): Promise<EventFixture> {
  const organizer = await signInVerified(makeIdentity(`${prefix}-organizer`));
  const tenantId = new ObjectId();
  await app.db
    .collection(COLLECTIONS.tenants)
    .insertOne(tenantDocument(prefix, tenantId, organizer));
  await app.db.collection(COLLECTIONS.tenantMembers).insertOne({
    tenantId,
    userId: organizer.userId,
    role: "owner",
    status: "active",
    joinedAt: new Date("2026-01-02T00:00:00.000Z"),
  });

  const eventId = new ObjectId();
  seededSlugSeq += 1;
  await app.db.collection(COLLECTIONS.events).insertOne({
    _id: eventId,
    tenantId: tenantId.toHexString(),
    name: "Rahul & Priya's Wedding",
    description: "",
    status: "published",
    startAt: new Date("2026-09-20T10:00:00.000Z"),
    endAt: new Date("2026-09-25T12:00:00.000Z"),
    displayTimeZone: "Asia/Kolkata",
    uploadWindowEndsAt: new Date("2026-09-30T12:00:00.000Z"),
    retentionExpiresAt: new Date("2026-12-24T12:00:00.000Z"),
    accessLinks: [
      {
        slug: `op140${String(seededSlugSeq).padStart(4, "0")}`,
        active: true,
        createdAt: new Date(),
        revokedAt: null,
      },
    ],
    counters: {
      imageCount: 0,
      processedImageCount: 0,
      failedImageCount: 0,
      attendeeCount: 0,
      matchCount: 0,
      storageBytes: 0,
    },
    sequence: 1,
    createdByUserId: organizer.userId.toHexString(),
    schemaVersion: 1,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  });
  await app.db.collection(COLLECTIONS.eventOrganizers).insertOne({
    tenantId: tenantId.toHexString(),
    eventId,
    userId: organizer.userId.toHexString(),
    role: "organizer",
    status: "active",
    revokedAt: null,
    uploadedImageCount: 0,
    createdAt: new Date("2026-09-02T00:00:00.000Z"),
    updatedAt: new Date("2026-09-02T00:00:00.000Z"),
    schemaVersion: 1,
  });

  const planKey = `op140-coorganizers-${prefix}`;
  await app.db.collection(COLLECTIONS.plans).insertOne(
    makePlan({
      key: planKey,
      entitlements: {
        "coorganizers.per_event": makeEntitlement({
          limit: 5,
          resetPeriod: "none",
          scope: "event",
          enforcement: "hard",
        }),
      },
    })
  );
  await app.db.collection(COLLECTIONS.subscriptions).insertOne(
    makeSubscription({
      tenantId: tenantId.toHexString(),
      subscribedPlanKey: planKey,
      activePlanKey: planKey,
      status: "active",
    })
  );

  return { workspace: { tenantId, organizer }, eventId };
}

/**
 * The stored `tenants` document one fixture starts from (schema §12).
 *
 * @param prefix - The suite-local prefix used for the slug.
 * @param tenantId - The workspace id to store.
 * @param owner - The workspace's owner.
 * @returns The document to insert.
 */
function tenantDocument(
  prefix: string,
  tenantId: ObjectId,
  owner: SignedInUser
): Record<string, unknown> {
  return {
    _id: tenantId,
    slug: `op140-${prefix}`,
    name: `OP140 ${prefix}`,
    status: "active",
    ownerUserId: owner.userId,
    billingContactUserId: owner.userId,
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
  };
}

/**
 * Seed a workspace whose owner owes a retryable amount.
 *
 * @param prefix - A unique suite-local prefix (slug).
 * @returns The workspace, its owner and the live subscription id.
 */
async function seedBillingWorkspace(prefix: string): Promise<BillingFixture> {
  const owner = await signInVerified(makeIdentity(`${prefix}-owner`));
  const tenantId = new ObjectId();
  await app.db.collection(COLLECTIONS.tenants).insertOne(tenantDocument(prefix, tenantId, owner));
  await app.db.collection(COLLECTIONS.tenantMembers).insertOne({
    tenantId,
    userId: owner.userId,
    role: "owner",
    status: "active",
    joinedAt: new Date("2026-01-02T00:00:00.000Z"),
  });
  await app.db
    .collection(COLLECTIONS.userProfiles)
    .updateOne({ userId: owner.userId }, { $set: { primaryTenantId: tenantId } });

  const subscriptionId = new ObjectId();
  await app.db.collection(COLLECTIONS.subscriptions).insertOne({
    _id: subscriptionId,
    tenantId: tenantId.toHexString(),
    subscribedPlanKey: "starter",
    subscribedPlanVersion: 1,
    activePlanKey: "starter",
    status: "past_due",
    priceKey: "starter-monthly-inr",
    billingCycle: "monthly",
    paymentMethodKind: "mandate_upi",
    mandateStatus: "active",
    currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-12-31T00:00:00.000Z"),
    nextChargeAt: new Date("2026-12-31T00:00:00.000Z"),
    gracePeriodEndsAt: null,
    pendingDueMinor: DUE_MINOR,
    currency: "INR",
    dunning: { attemptCount: 0, lastAttemptAt: null, remindersSent: [], nextReminderAt: null },
    cancelAt: null,
    cancelledAt: null,
    cancelReason: null,
    scheduledChange: null,
    previousSubscriptionId: null,
    statusHistory: [],
    externalRefs: [
      { provider: "memory", env: "sandbox", kind: "subscription", id: MEMORY_MANDATE_ID },
    ],
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date(),
  });

  return { tenantId, owner, subscriptionId };
}

/* -------------------------------------------------------------------------- */
/* Request builders                                                           */
/* -------------------------------------------------------------------------- */

/** The create payload for a user invitee. */
function userInvite(userId: string): Record<string, unknown> {
  return { invitee: { kind: "user", userId }, role: "co_organizer" };
}

/** The create payload for an email invitee. */
function emailInvite(email: string): Record<string, unknown> {
  return { invitee: { kind: "email", email }, role: "co_organizer" };
}

/** A `POST …/invitations` request. */
function createRequest(
  cookie: string,
  fixture: EventFixture,
  payload: Record<string, unknown>
): Request {
  return new Request(
    new URL(
      `/api/v1/tenants/${fixture.workspace.tenantId.toHexString()}/events/${fixture.eventId.toHexString()}/invitations`,
      APP_ORIGIN
    ),
    {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify(payload),
    }
  );
}

/** A `DELETE …/invitations/{invitationId}` request. */
function revokeRequest(cookie: string, fixture: EventFixture, invitationId: string): Request {
  return new Request(
    new URL(
      `/api/v1/tenants/${fixture.workspace.tenantId.toHexString()}/events/${fixture.eventId.toHexString()}/invitations/${invitationId}`,
      APP_ORIGIN
    ),
    { method: "DELETE", headers: { cookie } }
  );
}

/** A `POST /invitations/{token}/{decision}` request (`cookie` may be absent). */
function tokenDecision(cookie: string | null, token: string, decision: string): Request {
  const headers: Record<string, string> = {};
  if (cookie !== null) headers.cookie = cookie;
  return new Request(new URL(`/api/v1/invitations/${token}/${decision}`, APP_ORIGIN), {
    method: "POST",
    headers,
  });
}

/**
 * A `POST /me/notifications/{id}/actions/{actionKey}` request.
 *
 * §7.3 documents the body as action-specific and usually `{}`, so the request
 * sends an **empty JSON object**: the endpoint accepts no action parameter and
 * must not depend on the body to know what to do.
 *
 * @param cookie - The caller's session (`null` for the unauthenticated case).
 * @param notificationId - The feed row's id (any string; not necessarily hex).
 * @param actionKey - The action to apply.
 * @returns The request to hand the route handler.
 */
function actionRequest(cookie: string | null, notificationId: string, actionKey: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie !== null) headers.cookie = cookie;
  return new Request(
    new URL(`/api/v1/me/notifications/${notificationId}/actions/${actionKey}`, APP_ORIGIN),
    { method: "POST", headers, body: "{}" }
  );
}

/** A `GET /me/notifications` request. */
function feedRequest(cookie: string): Request {
  return new Request(new URL("/api/v1/me/notifications", APP_ORIGIN), {
    method: "GET",
    headers: { cookie },
  });
}

/* -------------------------------------------------------------------------- */
/* Readers                                                                    */
/* -------------------------------------------------------------------------- */

/** The error envelope of a failed response. */
async function errorOf(response: Response): Promise<{
  readonly code: string;
  readonly details: Record<string, unknown>;
}> {
  const parsed = await body(response);
  const error = parsed.error as { code?: string; details?: Record<string, unknown> } | undefined;
  return { code: error?.code ?? "", details: error?.details ?? {} };
}

/** The `[key, state]` pairs of a notification's in-app actions (§7.3). */
function actionPairs(row: Record<string, unknown> | undefined): [string, string][] {
  const actions = (row?.actions ?? []) as { readonly key: string; readonly state: string }[];
  return actions.map((action): [string, string] => [action.key, action.state]);
}

/** Every `event_organizers` row of the event. */
async function eventMembers(fixture: EventFixture): Promise<Record<string, unknown>[]> {
  return app.db
    .collection(COLLECTIONS.eventOrganizers)
    .find({ eventId: fixture.eventId })
    .toArray();
}

/** The outbox rows of one domain event key. */
async function outboxRows(eventKey: string): Promise<Record<string, unknown>[]> {
  return app.db.collection(COLLECTIONS.domainEvents).find({ eventKey }).toArray();
}

/** The charge intents the workspace's ledger holds, newest first. */
async function chargeRows(tenantId: ObjectId): Promise<Record<string, unknown>[]> {
  return app.db
    .collection(COLLECTIONS.billingTransactions)
    .find({ tenantId: tenantId.toHexString() })
    .toArray();
}

/** The payment-kind provider ref ids carried by the workspace's charge rows. */
function paymentRefIds(rows: readonly Record<string, unknown>[]): string[] {
  return rows.flatMap((row) => {
    const refs = (row.externalRefs ?? []) as { readonly kind: string; readonly id: string }[];
    return refs.filter((ref) => ref.kind === "payment").map((ref) => ref.id);
  });
}

/**
 * The driver's own `findOne`, captured before this file spies on it.
 *
 * Resolving `Collection.prototype.findOne` at call time would find the spy and
 * recurse, so the original is read once from the property descriptor (the
 * `billing-checkout.test.ts` `driverInsertOne` precedent).
 */
const driverFindOne = ((): typeof Collection.prototype.findOne => {
  const descriptor = Object.getOwnPropertyDescriptor(Collection.prototype, "findOne");
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    throw new Error("the driver's Collection#findOne is missing from the prototype");
  }
  return descriptor.value as typeof Collection.prototype.findOne;
})();

/** A live count of the payment provider's `chargeOnce` calls. */
interface ChargeCallCounter {
  /** How many times the endpoint asked the provider to charge. */
  readonly count: () => number;
  /** Put the config-driven provider selector back. */
  readonly restore: () => void;
}

/**
 * Count the vendor charges the endpoint issues, through the module it reaches
 * the provider by.
 *
 * The **only** observable that separates one charge from two: `recordChargeRefs`
 * `$set`s the intent's `externalRefs` and the memory provider mints the payment
 * id from the idempotency key, so a replayed `chargeOnce` overwrites one ref
 * with the same id — the ledger row count and the distinct-ref count stay `1`
 * either way.
 *
 * @returns The live counter and its restore hook (always call it).
 */
async function countChargeOnce(): Promise<ChargeCallCounter> {
  const payments = await import("@/server/payments/get-payment-provider");
  const realGetPaymentProvider = payments.getPaymentProvider;
  const calls = { total: 0 };
  const spy = vi.spyOn(payments, "getPaymentProvider").mockImplementation(() => {
    const provider = realGetPaymentProvider();
    return {
      ...provider,
      chargeOnce: (input: ChargeOnceInput): Promise<ChargeOnceResult> => {
        calls.total += 1;
        return provider.chargeOnce(input);
      },
    };
  });
  return {
    count: () => calls.total,
    restore: () => {
      spy.mockRestore();
    },
  };
}

/**
 * The timestamps a directly seeded feed row must carry.
 *
 * The feed's default `active` band reads `createdAt >= now − 30 d`, and
 * `expireAt` is the 90-day TTL horizon, so a fixture with a hard-coded past
 * instant is invisible to the read path (ADR-0148's fixture-clock class). Every
 * `insertFeedRow` call anchors its row to the real day.
 *
 * @returns The `createdAt` / `updatedAt` / `expireAt` triple to store.
 */
function freshRowTimestamps(): {
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly expireAt: Date;
} {
  const createdAt = new Date();
  return {
    createdAt,
    updatedAt: createdAt,
    expireAt: new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1000),
  };
}

/** The `collab.invite.sent` row of the caller's feed, if the feed carries one. */
async function feedInviteRow(cookie: string): Promise<Record<string, unknown> | undefined> {
  const response = await readFeed(feedRequest(cookie));
  expect(response.status).toBe(200);
  const payload = await body(response);
  const data = payload.data as Record<string, unknown>[];
  return data.find((row) => row.typeKey === INVITE_TYPE_KEY);
}

/** The maximal base64url-shaped runs in a rendered message (a token candidate). */
function tokenRuns(text: string): string[] {
  return text.match(/[A-Za-z0-9_-]{20,}/g) ?? [];
}

/**
 * Render the invitation messages the way the cron does.
 *
 * The raw token exists only inside the rendered email/SMS link (§2.3), so this
 * is the only honest way to obtain it: the dispatch rows are the artefact a
 * real invitee receives.
 */
async function settleInviteDelivery(): Promise<void> {
  await runNotificationFanOut({
    db: app.db,
    transport: getNotificationTransport(),
    recipients: mongoRecipientRepository(app.db),
    claimerId: "spec.op140-actions",
  });
}

/**
 * Read the raw token of one invitation out of its rendered message.
 *
 * @param invitationId - The invitation whose link is wanted.
 * @returns The raw token whose sha256 is the row's stored `tokenHash`.
 */
async function rawTokenOf(invitationId: string): Promise<string> {
  await settleInviteDelivery();
  const stored = await app.db
    .collection(COLLECTIONS.invitations)
    .findOne({ _id: new ObjectId(invitationId) });
  const rows = await app.db
    .collection(COLLECTIONS.dispatches)
    .find({ typeKey: INVITE_TYPE_KEY })
    .toArray();
  const rendered = rows
    .flatMap((row) =>
      [row.subject, row.body].filter((value): value is string => typeof value === "string")
    )
    .join("\n");
  const tokenByHash = new Map(tokenRuns(rendered).map((run) => [sha256Hex(run), run]));
  const rawLink = tokenByHash.get(String(stored?.tokenHash)) ?? "";
  if (rawLink.length === 0) {
    throw new Error("no rendered invitation link carries this invitation's token");
  }
  return rawLink;
}

/**
 * Create an invitation for the fixture and return its id.
 *
 * @param fixture - The event.
 * @param payload - The create payload (invitee kind and role).
 * @param cookie - The creating session (defaults to the organizer).
 * @returns The invitation id.
 */
async function invite(
  fixture: EventFixture,
  payload: Record<string, unknown>,
  cookie = fixture.workspace.organizer.cookie
): Promise<string> {
  const response = await createInvitation(createRequest(cookie, fixture, payload));
  expect(response.status).toBe(201);
  return (await body(response)).id as string;
}

/* -------------------------------------------------------------------------- */
/* I1 — accept from the feed, then again                                      */
/* -------------------------------------------------------------------------- */

describe("POST /api/v1/me/notifications/{id}/actions/{actionKey} — invitation accept", () => {
  it("I1: accepts the invitation from the feed, then answers already_resolved for the second click", async () => {
    const fixture = await seedEvent("op140-i1");
    const invitee = await signInVerified(makeIdentity("op140-i1-invitee"));
    const invitationId = await invite(fixture, userInvite(invitee.userId.toHexString()));
    await settleInviteDelivery();
    const row = await feedInviteRow(invitee.cookie);
    const notificationId = String(row?.id);
    expect(actionPairs(row)).toEqual([
      ["accept", "available"],
      ["reject", "available"],
    ]);

    // Arrange: the delegated decision and its closure are already pinned by
    // OP-121; this file pins the *delegation* ("applied exactly once").

    // Act: the first click.
    const first = await actOnNotification(actionRequest(invitee.cookie, notificationId, "accept"));

    // Assert: the §7.3 body, exactly.
    expect(first.status).toBe(200);
    const firstBody = await body(first);
    expect(Object.keys(firstBody).sort()).toEqual(ACTION_BODY_KEYS);
    expect(firstBody).toMatchObject({
      notificationId,
      actionKey: "accept",
      outcome: "applied",
      alreadyResolved: false,
      resolvedVia: "in_app",
      targetState: "accepted",
      redirectUrl: `/events/${fixture.eventId.toHexString()}/images`,
    });
    expect(typeof firstBody.message).toBe("string");
    expect(String(firstBody.message).trim().length).toBeGreaterThan(0);

    // The response carries the refreshed affordance, not the cached one.
    expect(actionPairs(firstBody)).toEqual([
      ["accept", "unavailable"],
      ["reject", "unavailable"],
    ]);

    // ...and the next feed read agrees with it.
    const afterFirst = await feedInviteRow(invitee.cookie);
    expect(actionPairs(afterFirst)).toEqual([
      ["accept", "unavailable"],
      ["reject", "unavailable"],
    ]);
    expect(afterFirst?.actionTarget).toEqual({
      kind: "invitation",
      id: invitationId,
      state: "resolved",
    });
    expect(afterFirst?.actionResolvedVia).toBe("in_app");

    // The state arm: one membership, one accepted event.
    const members = await eventMembers(fixture);
    expect(members.filter((member) => member.userId === invitee.userId.toHexString())).toHaveLength(
      1
    );
    expect(await outboxRows("collab.invite.accepted")).toHaveLength(1);

    // Act: the second click on the same affordance.
    const second = await actOnNotification(actionRequest(invitee.cookie, notificationId, "accept"));

    // Assert: a replay, never a 409.
    expect(second.status).toBe(200);
    const secondBody = await body(second);
    expect(Object.keys(secondBody).sort()).toEqual(ACTION_BODY_KEYS);
    expect(secondBody).toMatchObject({
      notificationId,
      actionKey: "accept",
      outcome: "already_resolved",
      alreadyResolved: true,
      resolvedVia: "in_app",
      targetState: "accepted",
    });
    expect(actionPairs(secondBody)).toEqual([
      ["accept", "unavailable"],
      ["reject", "unavailable"],
    ]);

    // The repeat applied nothing: still one membership, still one accepted event.
    const afterSecond = await eventMembers(fixture);
    expect(
      afterSecond.filter((member) => member.userId === invitee.userId.toHexString())
    ).toHaveLength(1);
    expect(afterSecond.filter((member) => member.role === "organizer")).toHaveLength(1);
    expect(await outboxRows("collab.invite.accepted")).toHaveLength(1);
  });

  it("I1: projects every action element to exactly {key, label, state}", async () => {
    const fixture = await seedEvent("op140-i1-projection");
    const invitee = await signInVerified(makeIdentity("op140-i1-projection-invitee"));
    await invite(fixture, userInvite(invitee.userId.toHexString()));
    await settleInviteDelivery();
    const notificationId = String((await feedInviteRow(invitee.cookie))?.id);

    // Act: the same click I1 makes — the response carries the re-read row's
    // affordance.
    const first = await actOnNotification(actionRequest(invitee.cookie, notificationId, "accept"));

    // Assert: the stored row also carries `style`, and the response is a
    // projection, so each element is exactly the three §7.3 facts — the label
    // survives and nothing else leaks.
    expect(first.status).toBe(200);
    const firstBody = await body(first);
    const actions = firstBody.actions as {
      readonly key: string;
      readonly label: string;
      readonly state: string;
    }[];
    expect(actions.map((action) => Object.keys(action).sort())).toEqual([
      ["key", "label", "state"],
      ["key", "label", "state"],
    ]);
    expect(actions.map((action) => action.label)).toEqual(["Accept", "Reject"]);
  });
});

/* -------------------------------------------------------------------------- */
/* I2 — the email token wins first                                            */
/* -------------------------------------------------------------------------- */

describe("POST /api/v1/me/notifications/{id}/actions/{actionKey} — cross-channel replay", () => {
  it("I2: answers already_resolved with resolvedVia email after an email-token accept", async () => {
    const fixture = await seedEvent("op140-i2");
    const inviteeIdentity = makeIdentity("op140-i2-invitee");
    // The account exists before the invitation so the email token's invitee
    // match has a real contact to compare against.
    const invitee = await signInVerified(inviteeIdentity);
    const invitationId = await invite(fixture, emailInvite(inviteeIdentity.email));
    // The trunk writes **no** in-app row for an email invitee: the fan-out's
    // recipient resolution reads `invitee.userId` (design §19.4), which nothing
    // stamps at create time for an email invitee, and the OP-89 lazy hook's
    // re-emit reuses the create-time dedupe key. So the row the feed *does*
    // carry for a decided invitation is seeded here; everything below it is the
    // real path — the token decision writes its closure on this very row.
    const notificationId = (
      await insertFeedRow(app.db, {
        userId: invitee.userId,
        typeKey: INVITE_TYPE_KEY,
        tenantId: fixture.workspace.tenantId.toHexString(),
        eventId: fixture.eventId,
        ...freshRowTimestamps(),
        actionTarget: { kind: "invitation", id: invitationId, state: "open" },
        actions: [
          { key: "accept", label: "Accept", style: "primary", state: "available" },
          { key: "reject", label: "Reject", style: "danger", state: "available" },
        ],
      })
    ).toHexString();
    const token = await rawTokenOf(invitationId);
    expect((await feedInviteRow(invitee.cookie))?.actionTarget).toEqual({
      kind: "invitation",
      id: invitationId,
      state: "open",
    });

    // Arrange: the email channel makes the decision first.
    expect((await acceptByToken(tokenDecision(invitee.cookie, token, "accept"))).status).toBe(200);

    // Act: the same decision, from the in-app affordance.
    const response = await actOnNotification(
      actionRequest(invitee.cookie, notificationId, "accept")
    );

    // Assert: the replay names the channel that actually won.
    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(Object.keys(payload).sort()).toEqual(ACTION_BODY_KEYS);
    expect(payload).toMatchObject({
      notificationId,
      actionKey: "accept",
      outcome: "already_resolved",
      alreadyResolved: true,
      resolvedVia: "email",
      targetState: "accepted",
    });
    expect(actionPairs(payload)).toEqual([
      ["accept", "unavailable"],
      ["reject", "unavailable"],
    ]);

    // The closure wrote the email channel, and the feed says so.
    expect((await feedInviteRow(invitee.cookie))?.actionResolvedVia).toBe("email");

    // The state arm: the email accept granted the membership, the feed click
    // grants nothing more.
    expect(
      (await eventMembers(fixture)).filter(
        (member) => member.userId === invitee.userId.toHexString()
      )
    ).toHaveLength(1);
    expect(await outboxRows("collab.invite.accepted")).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* I3 — a revoked invitation                                                  */
/* -------------------------------------------------------------------------- */

describe("POST /api/v1/me/notifications/{id}/actions/{actionKey} — a revoked target", () => {
  it("I3: answers 410 for an invitation revoked since the notification was sent", async () => {
    const fixture = await seedEvent("op140-i3");
    const invitee = await signInVerified(makeIdentity("op140-i3-invitee"));
    const invitationId = await invite(fixture, userInvite(invitee.userId.toHexString()));
    await settleInviteDelivery();
    const row = await feedInviteRow(invitee.cookie);
    expect(row?.actionTarget).toEqual({
      kind: "invitation",
      id: invitationId,
      state: "open",
    });
    const notificationId = String(row?.id);

    // Arrange: the organizer revokes, which closes the affordance (OP-121).
    // The cached `state: "unavailable"` below is exactly why the endpoint may
    // not short-circuit on it — the owning document has to answer.
    expect(
      (
        await revokeInvitation(
          revokeRequest(fixture.workspace.organizer.cookie, fixture, invitationId)
        )
      ).status
    ).toBe(200);
    expect(actionPairs(await feedInviteRow(invitee.cookie))).toEqual([
      ["accept", "unavailable"],
      ["reject", "unavailable"],
    ]);

    // Act: the invitee clicks the (now stale) accept affordance anyway.
    const response = await actOnNotification(
      actionRequest(invitee.cookie, notificationId, "accept")
    );

    // Assert: 410, because a revoked target must disappear, not report success.
    expect(response.status).toBe(410);
    expect((await errorOf(response)).code).toBe("invitation_revoked");

    // The state arm: the revocation stands and nothing was granted.
    const stored = await app.db
      .collection(COLLECTIONS.invitations)
      .findOne({ _id: new ObjectId(invitationId) });
    expect(stored?.status).toBe("revoked");
    expect(
      (await eventMembers(fixture)).filter(
        (member) => member.userId === invitee.userId.toHexString()
      )
    ).toHaveLength(0);
    expect(await outboxRows("collab.invite.accepted")).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* I4 — pay_now: applied once, and refused when the role is gone              */
/* -------------------------------------------------------------------------- */

describe("POST /api/v1/me/notifications/{id}/actions/pay_now", () => {
  /**
   * Seed the owner's `pay_now` notification.
   *
   * @param fixture - The workspace that owes money.
   * @returns The feed row's id.
   */
  async function payNowNotification(fixture: BillingFixture): Promise<string> {
    const _id = await insertFeedRow(app.db, {
      userId: fixture.owner.userId,
      typeKey: "billing.payment.failed",
      tenantId: fixture.tenantId.toHexString(),
      ...freshRowTimestamps(),
      actionTarget: {
        kind: "subscription",
        id: fixture.subscriptionId.toHexString(),
        state: "open",
      },
      actions: [{ key: "pay_now", label: "Pay now", style: "primary", state: "available" }],
    });
    return _id.toHexString();
  }

  it("I4: charges the outstanding amount once and answers already_resolved on the second click", async () => {
    const billing = await seedBillingWorkspace("op140-i4-applied");
    const notificationId = await payNowNotification(billing);

    // Act: the owner clicks "Pay now".
    const first = await actOnNotification(
      actionRequest(billing.owner.cookie, notificationId, "pay_now")
    );

    // Assert: the §7.3 body, exactly — the billing receipt's own fields are
    // projected away.
    expect(first.status).toBe(200);
    const firstBody = await body(first);
    expect(Object.keys(firstBody).sort()).toEqual(ACTION_BODY_KEYS);
    expect(firstBody).toMatchObject({
      notificationId,
      actionKey: "pay_now",
      outcome: "applied",
      alreadyResolved: false,
      resolvedVia: null,
      targetState: "past_due",
      redirectUrl: null,
    });

    // The state arm: one pending charge intent for the outstanding amount.
    const charges = await chargeRows(billing.tenantId);
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({
      status: "pending",
      amountMinor: DUE_MINOR,
      currency: "INR",
    });
    expect((charges[0]?.subscriptionId as ObjectId).toHexString()).toBe(
      billing.subscriptionId.toHexString()
    );
    const refIds = paymentRefIds(charges);
    expect(refIds).toHaveLength(1);

    // Act: a second click on the same notification.
    const second = await actOnNotification(
      actionRequest(billing.owner.cookie, notificationId, "pay_now")
    );

    // Assert: a replay, and the same single charge.
    expect(second.status).toBe(200);
    const secondBody = await body(second);
    expect(secondBody).toMatchObject({
      notificationId,
      actionKey: "pay_now",
      outcome: "already_resolved",
      alreadyResolved: true,
      targetState: "past_due",
    });
    const afterRepeat = await chargeRows(billing.tenantId);
    expect(afterRepeat).toHaveLength(1);
    // The vendor charge identity is a function of the derived idempotency key,
    // so one distinct payment ref across the two clicks means one charge.
    expect(new Set(paymentRefIds(afterRepeat)).size).toBe(1);
  });

  it("I4: refuses 403 for a caller who lost the owner role after the notification was sent", async () => {
    const billing = await seedBillingWorkspace("op140-i4-demoted");
    const notificationId = await payNowNotification(billing);

    // Arrange: the owner is demoted to `member` after the notification landed.
    await app.db
      .collection(COLLECTIONS.tenantMembers)
      .updateOne(
        { tenantId: billing.tenantId, userId: billing.owner.userId },
        { $set: { role: "member" } }
      );

    // Act: the notification's own affordance is not a permission.
    const response = await actOnNotification(
      actionRequest(billing.owner.cookie, notificationId, "pay_now")
    );

    // Assert: the delegated service's refusal, with nothing charged.
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe("forbidden");
    expect(await chargeRows(billing.tenantId)).toHaveLength(0);

    // The refusal closed nothing: the affordance is still the user's to retry.
    const feed = await readFeed(feedRequest(billing.owner.cookie));
    expect(feed.status).toBe(200);
    const rows = ((await body(feed)).data ?? []) as Record<string, unknown>[];
    const row = rows.find((item) => item.id === notificationId);
    expect(actionPairs(row)).toEqual([["pay_now", "available"]]);
  });

  it("I4: answers two concurrent pay_now clicks with one charge and no 5xx", async () => {
    const billing = await seedBillingWorkspace("op140-i4-concurrent");
    const notificationId = await payNowNotification(billing);

    // Act: both clicks race on the unique `idempotencyKey` index, so the loser
    // takes the duplicate-key exit instead of a ledger read.
    const [first, second] = await Promise.all([
      actOnNotification(actionRequest(billing.owner.cookie, notificationId, "pay_now")),
      actOnNotification(actionRequest(billing.owner.cookie, notificationId, "pay_now")),
    ]);

    // Assert: the loser answers the winner's intent, never a 500.
    expect([first.status, second.status]).toEqual([200, 200]);
    const outcomes = [await body(first), await body(second)]
      .map((payload) => String(payload.outcome))
      .sort();
    expect(outcomes).toEqual(["already_resolved", "applied"]);

    // ...and the ledger holds one intent carrying one vendor payment ref.
    const charges = await chargeRows(billing.tenantId);
    expect(charges).toHaveLength(1);
    expect(paymentRefIds(charges)).toHaveLength(1);
  });

  it("I4: answers the duplicate-key race from the ledger instead of a 500", async () => {
    const billing = await seedBillingWorkspace("op140-i4-dup-key");
    const notificationId = await payNowNotification(billing);

    // Arrange: force the cross-process shape. Both requests' idempotency probe
    // reads miss — as a second process's read does when its row lands after our
    // read — so both attempt the insert and the unique
    // `billing_transactions_idempotency_key_unique` index decides. An in-process
    // `Promise.all` alone never gets here: the loser's read follows the winner's
    // insert (the sibling case measures that shape).
    let probeReads = 0;
    const missingProbe = vi.spyOn(Collection.prototype, "findOne").mockImplementation(function (
      this: Collection,
      ...args: Parameters<typeof driverFindOne>
    ) {
      const filter: unknown = args[0];
      const keyedProbe =
        this.collectionName === COLLECTIONS.billingTransactions &&
        typeof filter === "object" &&
        filter !== null &&
        "idempotencyKey" in filter;
      if (keyedProbe && probeReads < 2) {
        probeReads += 1;
        return Promise.resolve(null);
      }
      return driverFindOne.call(this, ...args);
    } as never);

    let responses: Response[];
    try {
      responses = await Promise.all([
        actOnNotification(actionRequest(billing.owner.cookie, notificationId, "pay_now")),
        actOnNotification(actionRequest(billing.owner.cookie, notificationId, "pay_now")),
      ]);
    } finally {
      missingProbe.mockRestore();
    }

    // Assert: the loser answered the winner's intent, not the driver's error.
    expect(probeReads).toBe(2);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const charges = await chargeRows(billing.tenantId);
    expect(charges).toHaveLength(1);
    expect(paymentRefIds(charges)).toHaveLength(1);
  });

  it("I4: asks the payment provider exactly once across a double click", async () => {
    const billing = await seedBillingWorkspace("op140-i4-provider-once");
    const notificationId = await payNowNotification(billing);
    const provider = await countChargeOnce();
    try {
      // Act: the same affordance twice, as I4 clicks it.
      const first = await actOnNotification(
        actionRequest(billing.owner.cookie, notificationId, "pay_now")
      );
      const second = await actOnNotification(
        actionRequest(billing.owner.cookie, notificationId, "pay_now")
      );

      // Assert: the replay is answered from the ledger, so the vendor is asked
      // once. A second `chargeOnce` would mint the same memory payment id, so
      // neither the row count nor the distinct-ref count can see it.
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(provider.count()).toBe(1);
    } finally {
      provider.restore();
    }
  });

  it("I4: asks the payment provider once per notification for two distinct notifications", async () => {
    const billing = await seedBillingWorkspace("op140-i4-provider-twice");
    const firstNotificationId = await payNowNotification(billing);
    const secondNotificationId = await payNowNotification(billing);
    const provider = await countChargeOnce();
    try {
      // Act: two different notifications, so two different intents.
      const first = await actOnNotification(
        actionRequest(billing.owner.cookie, firstNotificationId, "pay_now")
      );
      const second = await actOnNotification(
        actionRequest(billing.owner.cookie, secondNotificationId, "pay_now")
      );

      // Assert: the count above is not satisfied by an endpoint that never
      // charges — a distinct key legitimately reaches the vendor again.
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(provider.count()).toBe(2);
    } finally {
      provider.restore();
    }
  });

  it("A3: closes the caller's pay_now affordance after a successful charge", async () => {
    const billing = await seedBillingWorkspace("op140-a3-applied");
    const notificationId = await payNowNotification(billing);
    // Read the live status the fixture seeds instead of hard-coding it: the
    // charge is confirmed by a webhook, never by this response, so the owning
    // subscription does not change and `targetState` must report its own status.
    const seededSubscription = await app.db
      .collection(COLLECTIONS.subscriptions)
      .findOne({ _id: billing.subscriptionId });
    expect(typeof seededSubscription?.status).toBe("string");
    const liveStatus = String(seededSubscription?.status);

    // Act: the owner clicks "Pay now".
    const response = await actOnNotification(
      actionRequest(billing.owner.cookie, notificationId, "pay_now")
    );

    // Assert: the switch applied, and the response already serves the closed
    // affordance (the endpoint re-reads the row after the delegation).
    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload).toMatchObject({
      notificationId,
      actionKey: "pay_now",
      outcome: "applied",
      targetState: liveStatus,
      // U2: this endpoint knows the instant, not a decision channel.
      resolvedVia: null,
    });
    const actions = payload.actions as {
      readonly key: string;
      readonly label: string;
      readonly state: string;
    }[];
    const payNow = actions.find((action) => action.key === "pay_now");
    expect(payNow).toBeDefined();
    expect(payNow?.state).not.toBe("available");
    const servedState = String(payNow?.state);

    // Assert: the stored row is closed too, at this endpoint's instant and
    // without a channel it was never told.
    const stored = await app.db
      .collection(COLLECTIONS.notifications)
      .findOne({ _id: new ObjectId(notificationId) });
    expect(stored).not.toBeNull();
    expect(stored?.actionTarget).toEqual({
      kind: "subscription",
      id: billing.subscriptionId.toHexString(),
      state: "resolved",
    });
    expect(stored?.actionResolvedAt).toBeInstanceOf(Date);
    expect(Object.prototype.hasOwnProperty.call(stored ?? {}, "actionResolvedVia")).toBe(false);

    // Assert: feed parity — the same decision is closed on every device.
    const feed = await readFeed(feedRequest(billing.owner.cookie));
    expect(feed.status).toBe(200);
    const feedRows = ((await body(feed)).data ?? []) as Record<string, unknown>[];
    const served = feedRows.find((row) => row.id === notificationId);
    expect(actionPairs(served)).toEqual([["pay_now", servedState]]);
  });

  it("A4: keeps the pay_now affordance closed on a replay and writes no second charge", async () => {
    const billing = await seedBillingWorkspace("op140-a4-replay");
    const notificationId = await payNowNotification(billing);
    const first = await actOnNotification(
      actionRequest(billing.owner.cookie, notificationId, "pay_now")
    );
    expect(first.status).toBe(200);

    // Act: the same affordance again, as a user double-tapping would.
    const second = await actOnNotification(
      actionRequest(billing.owner.cookie, notificationId, "pay_now")
    );

    // Assert: still a replay, and the replay never reopens what the first
    // click closed.
    expect(second.status).toBe(200);
    const secondBody = await body(second);
    expect(secondBody).toMatchObject({
      notificationId,
      actionKey: "pay_now",
      outcome: "already_resolved",
      alreadyResolved: true,
    });
    const actions = secondBody.actions as {
      readonly key: string;
      readonly label: string;
      readonly state: string;
    }[];
    const payNow = actions.find((action) => action.key === "pay_now");
    expect(payNow).toBeDefined();
    expect(payNow?.state).not.toBe("available");

    // Assert: exactly one charge intent for the workspace across both clicks.
    expect(await chargeRows(billing.tenantId)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* I5/I6 — ownership and the action key                                       */
/* -------------------------------------------------------------------------- */

describe("POST /api/v1/me/notifications/{id}/actions/{actionKey} — refusals", () => {
  it("I5: answers 404 for another user's notification id, granting nothing", async () => {
    const fixture = await seedEvent("op140-i5");
    const invitee = await signInVerified(makeIdentity("op140-i5-invitee"));
    const invitationId = await invite(fixture, userInvite(invitee.userId.toHexString()));
    await settleInviteDelivery();
    const notificationId = String((await feedInviteRow(invitee.cookie))?.id);
    const stranger = await signInVerified(makeIdentity("op140-i5-stranger"));

    const response = await actOnNotification(
      actionRequest(stranger.cookie, notificationId, "accept")
    );

    // Never 403: the endpoint must not become an existence oracle.
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe("not_found");
    expect(
      (await eventMembers(fixture)).filter(
        (member) => member.userId === stranger.userId.toHexString()
      )
    ).toHaveLength(0);
    const stored = await app.db
      .collection(COLLECTIONS.invitations)
      .findOne({ _id: new ObjectId(invitationId) });
    expect(stored?.status).toBe("pending");
  });

  it("I5: answers 404 for an id that names no notification", async () => {
    const caller = await signInVerified(makeIdentity("op140-i5-unknown"));

    const response = await actOnNotification(
      actionRequest(caller.cookie, new ObjectId().toHexString(), "accept")
    );

    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe("not_found");
  });

  it("I5: answers 404 for a malformed notification id, never a 500", async () => {
    const caller = await signInVerified(makeIdentity("op140-i5-malformed"));

    // A non-hex segment is not an id: the route reads it as `not_found` rather
    // than handing it to the driver, whose BSON error would answer 500.
    const response = await actOnNotification(
      actionRequest(caller.cookie, "not-an-object-id", "accept")
    );

    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe("not_found");
  });

  it("I6: answers 422 for an action key the notification does not carry", async () => {
    const fixture = await seedEvent("op140-i6-absent");
    const invitee = await signInVerified(makeIdentity("op140-i6-absent-invitee"));
    await invite(fixture, userInvite(invitee.userId.toHexString()));
    await settleInviteDelivery();
    const notificationId = String((await feedInviteRow(invitee.cookie))?.id);

    // `accept` and `reject` are the row's actions; `pay_now` is not.
    const response = await actOnNotification(
      actionRequest(invitee.cookie, notificationId, "pay_now")
    );

    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe("validation_failed");
  });

  it("I6: answers 422 for an action key the §7.3 dispatch table does not serve", async () => {
    const caller = await signInVerified(makeIdentity("op140-i6-unlisted"));
    const notificationId = (
      await insertFeedRow(app.db, {
        userId: caller.userId,
        typeKey: "collab.invite.sent",
        ...freshRowTimestamps(),
        actionTarget: { kind: "invitation", id: new ObjectId().toHexString(), state: "open" },
        actions: [{ key: "do_the_thing", label: "Do it", style: "primary", state: "available" }],
      })
    ).toHexString();

    const response = await actOnNotification(
      actionRequest(caller.cookie, notificationId, "do_the_thing")
    );

    // The row names the key but §7.3 names no service for it: refuse rather
    // than invent a delegate.
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe("validation_failed");
  });

  it("I7: answers 401 without a session", async () => {
    const caller = await signInVerified(makeIdentity("op140-i7-owner"));
    const notificationId = (
      await insertFeedRow(app.db, {
        userId: caller.userId,
        typeKey: "collab.invite.sent",
        ...freshRowTimestamps(),
        actionTarget: { kind: "invitation", id: new ObjectId().toHexString(), state: "open" },
        actions: [{ key: "accept", label: "Accept", style: "primary", state: "available" }],
      })
    ).toHexString();

    const response = await actOnNotification(actionRequest(null, notificationId, "accept"));

    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("authentication_required");
  });
});

/* -------------------------------------------------------------------------- */
/* A1/A3/A4/A5 — the producer of the pay_now affordance                       */
/* -------------------------------------------------------------------------- */

/**
 * Integration / contract — the **producer** half of the `pay_now` affordance
 * (OP-140 §4.6 of ADR-0942, contract §7.3, notification design §7).
 *
 * Every case above seeds its feed row with `insertFeedRow`, so none of them can
 * see *who is allowed to receive an affordance*. The endpoint's delegate
 * (`startOutstandingCharge`) is owner-only (`charge-outstanding.ts:97-105`), and
 * the trunk offers `actions: []` to every type but an invitation, so the shipped
 * `pay_now` arm is production code no user can reach. These cases deliver the
 * real domain event (`billing.payment.failed`, the emit at
 * `webhook-projection.ts:968`) through the real fan-out and read what the feed
 * serves:
 *
 * 1. an **owner** receives exactly one `pay_now` — the recipient the delegate
 *    will accept (A1);
 * 2. a billing contact who is an active member but **not** the owner receives
 *    the notification and **no** affordance (A3);
 * 3. a click on the produced row charges once and closes it everywhere (A4);
 * 4. the key set follows the target's stored state — `pay_now` **or**
 *    `complete_mandate`, never both (A5, ADR-0942 §4.3).
 *
 * The event goes through `emitDomainEvent`, not a hand-built outbox document, so
 * the row carries production's own validated key, expiry and dispatch flag.
 *
 * Assumptions this file makes about the implementation (ADR-0945):
 *
 * - **P-1** — the affordance's label copy is **not** pinned (only non-empty), per
 *   the card's scope note; the `style` is pinned only to §7.1's enumeration.
 * - **P-2** — `actionTarget.kind` is the emit's `subjectRef.kind` (`subscription`
 *   here), never a type→kind map (`fan-out.ts:458`).
 * - **P-3** — A5's positive half pins the *exclusion* (`pay_now` is absent from
 *   an `incomplete` row with a stored checkout, and `complete_mandate` is absent
 *   from a `past_due` one), not `complete_mandate`'s own delegate, which stays
 *   deferred (ADR-0942 §4.7).
 */
describe("billing.payment.failed — the producer of the pay_now affordance", () => {
  /** The type key whose catalogue row must offer the action. */
  const PAYMENT_FAILED_TYPE_KEY = "billing.payment.failed";

  /** The styles contract §7.1 allows on a rendered action. */
  const SHIPPED_STYLES = ["primary", "secondary", "danger"];

  /**
   * Emit one `billing.payment.failed` domain event, as the billing webhook
   * projection does, and drain it through the notification fan-out.
   *
   * The payload and subject are the projection's own (`webhook-projection.ts:968`):
   * `subjectRef: {kind: "subscription", id}`, `payload: {subscriptionId}`.
   *
   * @param fixture - The workspace whose subscription failed a charge.
   */
  async function deliverPaymentFailed(fixture: BillingFixture): Promise<void> {
    await emitDomainEvent(
      {
        eventKey: PAYMENT_FAILED_TYPE_KEY,
        tenantId: fixture.tenantId.toHexString(),
        actorRef: { kind: "system", id: "billing" },
        subjectRef: { kind: "subscription", id: fixture.subscriptionId.toHexString() },
        payload: { subscriptionId: fixture.subscriptionId.toHexString() },
      },
      { db: app.db }
    );
    await runNotificationFanOut({
      db: app.db,
      transport: getNotificationTransport(),
      recipients: mongoRecipientRepository(app.db),
      claimerId: "spec.op140-producer",
    });
  }

  /**
   * The `billing.payment.failed` rows the caller's feed serves.
   *
   * @param cookie - The caller's session.
   * @returns Every served row of that type (the `GET` projection, §7.1).
   */
  async function paymentFailedRows(cookie: string): Promise<Record<string, unknown>[]> {
    const response = await readFeed(feedRequest(cookie));
    expect(response.status).toBe(200);
    const rows = ((await body(response)).data ?? []) as Record<string, unknown>[];
    return rows.filter((row) => row.typeKey === PAYMENT_FAILED_TYPE_KEY);
  }

  /**
   * The action keys of one served row, in stored order.
   *
   * @param row - The served feed row.
   * @returns One key per served action.
   */
  function servedActionKeys(row: Record<string, unknown> | undefined): string[] {
    return ((row?.actions ?? []) as { readonly key: string }[]).map((action) => action.key);
  }

  it("A1: serves the owner's produced row exactly one pay_now action", async () => {
    const billing = await seedBillingWorkspace("op140-a1-owner");

    // Act: the event the billing projection emits after a failed charge.
    await deliverPaymentFailed(billing);

    // Assert: one row, pointing at the subscription, with one live affordance.
    const rows = await paymentFailedRows(billing.owner.cookie);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actionTarget).toEqual({
      kind: "subscription",
      id: billing.subscriptionId.toHexString(),
      state: "open",
    });
    const actions = (rows[0]?.actions ?? []) as {
      readonly key: string;
      readonly label: string;
      readonly style: string;
      readonly state: string;
    }[];
    // One action only — a second cannot ride along — and no extra element key.
    expect(actions).toHaveLength(1);
    expect(Object.keys(actions[0] ?? {}).sort()).toEqual(["key", "label", "state", "style"]);
    expect(actions[0]?.key).toBe("pay_now");
    expect(actions[0]?.state).toBe("available");
    expect(SHIPPED_STYLES).toContain(String(actions[0]?.style));
    // The copy itself is not pinned; that it exists is (P-1).
    expect((actions[0]?.label ?? "").trim().length).toBeGreaterThan(0);
  });

  it("A3: serves a non-owner billing contact the row and no action", async () => {
    const billing = await seedBillingWorkspace("op140-a3-billing-contact");
    const contact = await signInVerified(makeIdentity("op140-a3-billing-contact-user"));

    // Arrange: an active member who is not the owner is named the workspace's
    // billing contact — the owner-settable field the fan-out's `billing_contact`
    // audience reads (`notification-recipients.ts:139-145`).
    await app.db.collection(COLLECTIONS.tenantMembers).insertOne({
      tenantId: billing.tenantId,
      userId: contact.userId,
      role: "member",
      status: "active",
      joinedAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    await app.db
      .collection(COLLECTIONS.tenants)
      .updateOne({ _id: billing.tenantId }, { $set: { billingContactUserId: contact.userId } });

    // Act: the same failed charge.
    await deliverPaymentFailed(billing);

    // Assert: the audience resolved the contact — the row is theirs...
    const contactRows = await paymentFailedRows(contact.cookie);
    expect(contactRows).toHaveLength(1);
    // ...and offers no control, because `pay_now` would answer `403` to them.
    expect(contactRows[0]?.actionTarget).toBeNull();
    expect(contactRows[0]?.actions).toEqual([]);

    // The audience is `billing_contact` only, so the owner receives no row.
    expect(await paymentFailedRows(billing.owner.cookie)).toHaveLength(0);
  });

  it("A4: applies the produced pay_now once and closes the produced row", async () => {
    const billing = await seedBillingWorkspace("op140-a4-produced");
    await deliverPaymentFailed(billing);
    const rows = await paymentFailedRows(billing.owner.cookie);
    expect(rows).toHaveLength(1);
    const notificationId = String(rows[0]?.id);

    // Act: the owner clicks the affordance the fan-out just wrote.
    const first = await actOnNotification(
      actionRequest(billing.owner.cookie, notificationId, "pay_now")
    );

    // Assert: the transition applied, with one pending charge intent.
    expect(first.status).toBe(200);
    expect(await body(first)).toMatchObject({
      notificationId,
      actionKey: "pay_now",
      outcome: "applied",
      alreadyResolved: false,
    });
    const charges = await chargeRows(billing.tenantId);
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ status: "pending", amountMinor: DUE_MINOR });

    // Assert: the next feed read serves the produced row closed (§7.3 rule 3).
    const after = await paymentFailedRows(billing.owner.cookie);
    expect(after).toHaveLength(1);
    expect(after[0]?.actionTarget).toEqual({
      kind: "subscription",
      id: billing.subscriptionId.toHexString(),
      state: "resolved",
    });
    expect(actionPairs(after[0])).toEqual([["pay_now", "unavailable"]]);

    // Act: the second click.
    const second = await actOnNotification(
      actionRequest(billing.owner.cookie, notificationId, "pay_now")
    );

    // Assert: a replay, and no second charge.
    expect(second.status).toBe(200);
    expect(await body(second)).toMatchObject({
      outcome: "already_resolved",
      alreadyResolved: true,
    });
    expect(await chargeRows(billing.tenantId)).toHaveLength(1);
  });

  it("A5: never offers pay_now on an incomplete subscription that carries a checkout", async () => {
    const billing = await seedBillingWorkspace("op140-a5-incomplete");
    // Arrange: the §4.3 shape `complete_mandate` is live for — `incomplete` with
    // a stored checkout still inside its window — and no outstanding due, so
    // `pay_now`'s own condition (`pendingDueMinor > 0`) is not met either.
    await app.db.collection(COLLECTIONS.subscriptions).updateOne(
      { _id: billing.subscriptionId },
      {
        $set: {
          status: "incomplete",
          pendingDueMinor: 0,
          mandateStatus: "pending",
          checkout: {
            url: "https://payments.example.test/checkout/op140-a5",
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        },
      }
    );

    // Act: the failed charge.
    await deliverPaymentFailed(billing);

    // Assert: at most one candidate key, and never `pay_now` (§4.3, P-3).
    const rows = await paymentFailedRows(billing.owner.cookie);
    expect(rows).toHaveLength(1);
    expect(servedActionKeys(rows[0])).not.toContain("pay_now");
    expect(servedActionKeys(rows[0]).length).toBeLessThanOrEqual(1);
  });

  it("A5: never offers complete_mandate on a past_due row that still carries a checkout", async () => {
    const billing = await seedBillingWorkspace("op140-a5-past-due");
    // Arrange: a checkout left behind on a row whose charge already failed —
    // the presence of `checkout` must not be what selects the key.
    await app.db.collection(COLLECTIONS.subscriptions).updateOne(
      { _id: billing.subscriptionId },
      {
        $set: {
          checkout: {
            url: "https://payments.example.test/checkout/op140-a5-stale",
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        },
      }
    );

    // Act: the failed charge.
    await deliverPaymentFailed(billing);

    // Assert: the stale checkout does not add a second key, and `pay_now` is
    // still the one the row offers.
    const rows = await paymentFailedRows(billing.owner.cookie);
    expect(rows).toHaveLength(1);
    expect(servedActionKeys(rows[0])).toEqual(["pay_now"]);
  });
});
