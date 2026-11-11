import { randomUUID } from "node:crypto";

import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { findForbiddenFields, maskEmail } from "@openpic/contracts";

import { POST as acceptByToken } from "@/app/api/v1/invitations/[token]/accept/route";
import { POST as rejectByToken } from "@/app/api/v1/invitations/[token]/reject/route";
import { POST as acceptInApp } from "@/app/api/v1/me/invitations/[invitationId]/accept/route";
import { POST as rejectInApp } from "@/app/api/v1/me/invitations/[invitationId]/reject/route";
import { GET as readFeed } from "@/app/api/v1/me/notifications/route";
import { GET as readEvent } from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/route";
import {
  GET as listInvitations,
  POST as createInvitation,
} from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/invitations/route";
import { DELETE as revokeInvitation } from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/invitations/[invitationId]/route";
import { DELETE as removeMember } from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/members/[userId]/route";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { runNotificationFanOut } from "@/server/notifications/fan-out";
import { invalidateNotificationTypeCache } from "@/server/notifications/notification-type-cache";
import {
  seedNotificationTemplates,
  seedNotificationTypes,
} from "@/server/notifications/seed-notification-types";
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
  type TestIdentity,
  type TestApp,
} from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";

/**
 * Integration / contract — accepting and rejecting a co-organizer invitation
 * across email, SMS and in-app, and removing an accepted member (OP-121 I1–I11,
 * contract §2.3, §7.3, schema §13.6, §15.2).
 *
 * The user story: *as an invitee, I want accept/reject to be final and
 * idempotent across email, SMS and in-app so that double clicks or cross-channel
 * clicks never error.* §2.3 makes that a structural promise, not a courtesy:
 *
 * 1. every terminal transition is **one** conditional `findOneAndUpdate`
 *    filtered on `status: "pending"` **and** `expiresAt: { $gt: now }`;
 * 2. a write that matches nothing reads the row and answers its **current**
 *    state — `200` for `accepted`/`rejected` with `alreadyResolved: true` and
 *    the channel that originally won, `410` for `revoked`/`expired` — and
 *    **never `409`**;
 * 3. the transition closes the affordance **in every channel**: the
 *    `notifications` rows whose `actionTarget` names this invitation get
 *    `actions[].state = "unavailable"`, `actionTarget.state = "resolved"`,
 *    `actionResolvedVia` and `actionResolvedAt`;
 * 4. `revoked` and `expired` make acceptance **structurally impossible** —
 *    `410`, because the affordance must disappear rather than report success.
 *
 * ## Contract expected of the implementation
 *
 * ```
 * @/app/api/v1/me/invitations/[invitationId]/accept/route   POST  (Auth `user`)
 * @/app/api/v1/me/invitations/[invitationId]/reject/route   POST  (Auth `user`)
 * @/app/api/v1/invitations/[token]/accept/route             POST  (Auth `public`)
 * @/app/api/v1/invitations/[token]/reject/route             POST  (Auth `public`)
 * @/app/api/v1/tenants/[tenantId]/events/[eventId]/members/[userId]/route
 *                                                           DELETE (Auth `user` + event `organizer`)
 * ```
 *
 * - Every decision answers `200` with the §2.3 body
 *   `{ id, status, resolvedAt, resolvedVia, alreadyResolved }` — plus
 *   `membership: { eventId, role }` and `redirectUrl` on an `accept`, and
 *   nothing else (a decision body never carries a contact, a token, a userId or
 *   a tenant id).
 * - `resolvedVia` is `"in_app"` on the `/me` path, `"email"` on the token path
 *   and `"sms"` when the link carries `?via=sms` (§2.3).
 * - Accept inserts the `event_organizers` row (`role: "co_organizer"`,
 *   `status: "active"`, `revokedAt: null`) inside the same transaction as the
 *   invitation transition (§23) and emits `collab.invite.accepted`;
 *   reject emits `collab.invite.rejected` and inserts **no** row.
 * - The new codes are the Appendix A.5 rows the executable catalogue lacks:
 *   `invitation_revoked` (`410`), `invitation_expired` (`410`),
 *   `invitation_not_for_you` (`403`), `cannot_remove_organizer` (`409`).
 * - Removing an accepted member answers `204` with no body, sets the
 *   `event_organizers` row to `status: "removed"` **and** stamps `revokedAt`
 *   (the admission seam filters on `revokedAt: null`, so one without the other
 *   would leave access open), and revokes the originating invitation.
 *
 * ## Assumptions (ADR-0663 §Assumptions)
 *
 * - **I-A1** — a non-invitee who presents a known invitation id on the `/me`
 *   path is refused `403 invitation_not_for_you`, the same refusal the token
 *   path documents (`{ inviteeMasked }` details). An id that names no row is
 *   the uniform `404`. The card fixes only "a wrong user -> 403".
 * - **I-A2** — an unverified matching contact is refused
 *   `403 account_incomplete` (the shipped auth-guard code and message: "Your
 *   account setup is incomplete"). Appendix A.5 has no code for it, so this ADR
 *   reuses the existing `403` rather than appending a near-synonym.
 * - **I-A3** — the event detail read (`GET …/events/{eventId}`) admits an
 *   **event actor**, not only a workspace member (the `admitEventActor` seam
 *   OP-119/OP-120 already use for the member list and the invitation list,
 *   ADR-0644): a co-organizer commonly holds no `tenantMembers` row (§4.3), so
 *   otherwise the co-organizer could never read the event the story is about and
 *   "access lost after removal" would be true before the removal as well.
 * - **I-A4** — `DELETE …/members/{userId}` answers `204` with an empty body,
 *   mirroring the tenant-member removal (§2.2). §2.3 does not name a status.
 * - **I-A5** — the in-app action of §7.3 (`POST
 *   /me/notifications/{id}/actions/{actionKey}`) delegates to the `/me`
 *   decision path but is not part of this card's surface (it does not exist on
 *   the trunk), so "the in-app action returns 410" is pinned on
 *   `POST /me/invitations/{id}/accept` — the endpoint that owns the transition.
 */

/** The five keys every §2.3 decision body carries. */
const DECISION_REQUIRED_KEYS = ["alreadyResolved", "id", "resolvedAt", "resolvedVia", "status"];

/** The only other keys a decision body may carry (`membership`, `redirectUrl`). */
const DECISION_OPTIONAL_KEYS = ["membership", "redirectUrl"];

/** The invitation type key whose feed row carries the accept/reject affordance. */
const INVITE_TYPE_KEY = "collab.invite.sent";

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op121-decisions" });
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
  await app.db.collection(COLLECTIONS.tenants).insertOne({
    _id: tenantId,
    slug: `op121-${prefix}`,
    name: `OP121 ${prefix}`,
    status: "active",
    ownerUserId: organizer.userId,
    billingContactUserId: organizer.userId,
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
  await app.db.collection(COLLECTIONS.tenantMembers).insertOne({
    tenantId,
    userId: organizer.userId,
    role: "owner",
    status: "active",
    joinedAt: new Date("2026-01-02T00:00:00.000Z"),
  });
  await app.db
    .collection(COLLECTIONS.userProfiles)
    .updateOne(
      { userId: organizer.userId },
      { $set: { primaryTenantId: tenantId, displayName: `Organizer ${prefix}` } }
    );

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
        slug: `op121${String(seededSlugSeq).padStart(4, "0")}`,
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

  const planKey = `op121-coorganizers-${prefix}`;
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
 * Insert an `event_organizers` row (schema §15.2).
 *
 * @param fixture - The event.
 * @param user - The member.
 * @param role - The event role.
 * @param options - Member status and whether the caller also has a
 *   `tenantMembers` row (`workspaceMember`), which is what the plain tenant
 *   stage admits.
 */
async function addEventMember(
  fixture: EventFixture,
  user: SignedInUser,
  role: "organizer" | "co_organizer",
  options: { readonly status?: "active" | "removed"; readonly workspaceMember?: boolean } = {}
): Promise<void> {
  const status = options.status ?? "active";
  await app.db.collection(COLLECTIONS.eventOrganizers).insertOne({
    tenantId: fixture.workspace.tenantId.toHexString(),
    eventId: fixture.eventId,
    userId: user.userId.toHexString(),
    role,
    status,
    revokedAt: status === "removed" ? new Date("2026-09-10T00:00:00.000Z") : null,
    uploadedImageCount: 0,
    createdAt: new Date("2026-09-02T00:00:00.000Z"),
    updatedAt: new Date("2026-09-02T00:00:00.000Z"),
    schemaVersion: 1,
  });
  if (options.workspaceMember === true) {
    await app.db.collection(COLLECTIONS.tenantMembers).insertOne({
      tenantId: fixture.workspace.tenantId,
      userId: user.userId,
      role: "member",
      status: "active",
      joinedAt: new Date("2026-01-04T00:00:00.000Z"),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Request builders                                                           */
/* -------------------------------------------------------------------------- */

/** The create payload for an email invitee. */
function emailInvite(email: string): Record<string, unknown> {
  return { invitee: { kind: "email", email }, role: "co_organizer" };
}

/** The create payload for a user invitee. */
function userInvite(userId: string): Record<string, unknown> {
  return { invitee: { kind: "user", userId }, role: "co_organizer" };
}

/** The create payload for a phone invitee. */
function phoneInvite(phoneE164: string): Record<string, unknown> {
  return { invitee: { kind: "phone", phoneE164 }, role: "co_organizer" };
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

/** A `GET …/invitations` request. */
function listInvitationsRequest(cookie: string, fixture: EventFixture): Request {
  return new Request(
    new URL(
      `/api/v1/tenants/${fixture.workspace.tenantId.toHexString()}/events/${fixture.eventId.toHexString()}/invitations`,
      APP_ORIGIN
    ),
    { method: "GET", headers: { cookie } }
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

/** A `POST /me/invitations/{invitationId}/{decision}` request (`cookie` may be absent). */
function inAppDecision(cookie: string | null, invitationId: string, decision: string): Request {
  const headers: Record<string, string> = {};
  if (cookie !== null) headers.cookie = cookie;
  return new Request(new URL(`/api/v1/me/invitations/${invitationId}/${decision}`, APP_ORIGIN), {
    method: "POST",
    headers,
  });
}

/** A `POST /invitations/{token}/{decision}` request (`cookie` may be absent). */
function tokenDecision(cookie: string | null, token: string, decision: string, via = ""): Request {
  const headers: Record<string, string> = {};
  if (cookie !== null) headers.cookie = cookie;
  return new Request(new URL(`/api/v1/invitations/${token}/${decision}${via}`, APP_ORIGIN), {
    method: "POST",
    headers,
  });
}

/** A `DELETE …/members/{userId}` request. */
function removeMemberRequest(
  cookie: string | null,
  fixture: EventFixture,
  userId: ObjectId
): Request {
  const headers: Record<string, string> = {};
  if (cookie !== null) headers.cookie = cookie;
  return new Request(
    new URL(
      `/api/v1/tenants/${fixture.workspace.tenantId.toHexString()}/events/${fixture.eventId.toHexString()}/members/${userId.toHexString()}`,
      APP_ORIGIN
    ),
    { method: "DELETE", headers }
  );
}

/** A `GET …/events/{eventId}` request. */
function readEventRequest(cookie: string, fixture: EventFixture): Request {
  return new Request(
    new URL(
      `/api/v1/tenants/${fixture.workspace.tenantId.toHexString()}/events/${fixture.eventId.toHexString()}`,
      APP_ORIGIN
    ),
    { method: "GET", headers: { cookie } }
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

/** The maximal base64url-shaped runs in a rendered message (a token candidate). */
function tokenRuns(text: string): string[] {
  return text.match(/[A-Za-z0-9_-]{20,}/g) ?? [];
}

/** The error envelope of a failed response. */
async function errorOf(response: Response): Promise<{
  readonly code: string;
  readonly details: Record<string, unknown>;
}> {
  const parsed = await body(response);
  const error = parsed.error as { code?: string; details?: Record<string, unknown> } | undefined;
  return { code: error?.code ?? "", details: error?.details ?? {} };
}

/** The stored invitation row. */
async function storedInvitation(invitationId: string): Promise<Record<string, unknown> | null> {
  return app.db.collection(COLLECTIONS.invitations).findOne({ _id: new ObjectId(invitationId) });
}

/** Every `event_organizers` row of the event. */
async function eventMembers(fixture: EventFixture): Promise<Record<string, unknown>[]> {
  return app.db
    .collection(COLLECTIONS.eventOrganizers)
    .find({ eventId: fixture.eventId })
    .toArray();
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
    claimerId: "spec.op121-decisions",
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
  const stored = await storedInvitation(invitationId);
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

/**
 * Assert the §2.3 decision body shape.
 *
 * @param payload - The parsed response body.
 */
function expectDecisionBody(payload: Record<string, unknown>): void {
  const keys = Object.keys(payload).sort();
  expect(keys).toEqual(expect.arrayContaining(DECISION_REQUIRED_KEYS));
  expect(
    keys.filter(
      (key) => !DECISION_REQUIRED_KEYS.includes(key) && !DECISION_OPTIONAL_KEYS.includes(key)
    )
  ).toEqual([]);
}

/** The `collab.invite.sent` row of the caller's feed, if the feed carries one. */
async function feedInviteRow(cookie: string): Promise<Record<string, unknown> | undefined> {
  const response = await readFeed(feedRequest(cookie));
  expect(response.status).toBe(200);
  const payload = await body(response);
  const data = payload.data as Record<string, unknown>[];
  return data.find((row) => row.typeKey === INVITE_TYPE_KEY);
}

/* -------------------------------------------------------------------------- */
/* The in-app decision path                                                   */
/* -------------------------------------------------------------------------- */

describe("POST /api/v1/me/invitations/{invitationId}/accept", () => {
  it("accepts the invitation, grants co_organizer and answers the §2.3 body", async () => {
    const fixture = await seedEvent("op121-accept");
    const invitee = await signInVerified(makeIdentity("op121-accept-invitee"));
    const invitationId = await invite(fixture, userInvite(invitee.userId.toHexString()));

    const response = await acceptInApp(inAppDecision(invitee.cookie, invitationId, "accept"));

    expect(response.status).toBe(200);
    const payload = await body(response);
    expectDecisionBody(payload);
    expect(findForbiddenFields(payload, "default")).toEqual([]);
    expect(payload.id).toBe(invitationId);
    expect(payload.status).toBe("accepted");
    expect(payload.alreadyResolved).toBe(false);
    expect(payload.resolvedVia).toBe("in_app");
    expect(payload.resolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(payload.membership).toEqual({
      eventId: fixture.eventId.toHexString(),
      role: "co_organizer",
    });
    expect(payload.redirectUrl).toMatch(/^\/events\/[0-9a-f]{24}/);
  });

  it("records the decision on the invitation row", async () => {
    const fixture = await seedEvent("op121-accept-row");
    const invitee = await signInVerified(makeIdentity("op121-accept-row-invitee"));
    const invitationId = await invite(fixture, userInvite(invitee.userId.toHexString()));

    expect((await acceptInApp(inAppDecision(invitee.cookie, invitationId, "accept"))).status).toBe(
      200
    );

    const stored = await storedInvitation(invitationId);
    expect(stored?.status).toBe("accepted");
    expect(stored?.resolvedVia).toBe("in_app");
    expect(stored?.resolvedAt).toBeInstanceOf(Date);
  });

  it("shows the accepted status to the organizer in the invitation list", async () => {
    const fixture = await seedEvent("op121-accept-list");
    const invitee = await signInVerified(makeIdentity("op121-accept-list-invitee"));
    const invitationId = await invite(fixture, userInvite(invitee.userId.toHexString()));
    expect((await acceptInApp(inAppDecision(invitee.cookie, invitationId, "accept"))).status).toBe(
      200
    );

    const response = await listInvitations(
      listInvitationsRequest(fixture.workspace.organizer.cookie, fixture)
    );

    expect(response.status).toBe(200);
    const data = (await body(response)).data as { id: string; status: string }[];
    expect(data.map((row) => [row.id, row.status])).toEqual([[invitationId, "accepted"]]);
  });

  it("I10: inserts one co-organizer row and never a second organizer", async () => {
    const fixture = await seedEvent("op121-i10");
    const invitee = await signInVerified(makeIdentity("op121-i10-invitee"));
    const invitationId = await invite(fixture, userInvite(invitee.userId.toHexString()));

    expect((await acceptInApp(inAppDecision(invitee.cookie, invitationId, "accept"))).status).toBe(
      200
    );

    const rows = await eventMembers(fixture);
    expect(rows.map((row) => row.role).sort()).toEqual(["co_organizer", "organizer"]);
    const granted = rows.find((row) => row.userId === invitee.userId.toHexString());
    expect(granted?.role).toBe("co_organizer");
    expect(granted?.status).toBe("active");
    expect(granted?.revokedAt).toBeNull();
    expect(rows.filter((row) => row.role === "organizer")).toHaveLength(1);
  });

  it("I10: an invitation row that names organizer still yields co_organizer", async () => {
    const fixture = await seedEvent("op121-i10-forged");
    const invitee = await signInVerified(makeIdentity("op121-i10-forged-invitee"));
    const invitationId = await invite(fixture, userInvite(invitee.userId.toHexString()));
    await app.db
      .collection(COLLECTIONS.invitations)
      .updateOne({ _id: new ObjectId(invitationId) }, { $set: { role: "organizer" } });

    const response = await acceptInApp(inAppDecision(invitee.cookie, invitationId, "accept"));

    expect(response.status).toBe(200);
    expect((await body(response)).membership).toEqual({
      eventId: fixture.eventId.toHexString(),
      role: "co_organizer",
    });
    const rows = await eventMembers(fixture);
    expect(rows.filter((row) => row.role === "organizer")).toHaveLength(1);
    expect(rows.filter((row) => row.role === "co_organizer")).toHaveLength(1);
  });

  it("rejects the invitation without granting a membership", async () => {
    const fixture = await seedEvent("op121-reject");
    const invitee = await signInVerified(makeIdentity("op121-reject-invitee"));
    const invitationId = await invite(fixture, userInvite(invitee.userId.toHexString()));

    const response = await rejectInApp(inAppDecision(invitee.cookie, invitationId, "reject"));

    expect(response.status).toBe(200);
    const payload = await body(response);
    expectDecisionBody(payload);
    expect(payload.status).toBe("rejected");
    expect(payload.alreadyResolved).toBe(false);
    expect(payload.resolvedVia).toBe("in_app");
    expect(payload.membership).toBeUndefined();
    const stored = await storedInvitation(invitationId);
    expect(stored?.status).toBe("rejected");
    expect(await eventMembers(fixture)).toHaveLength(1);
  });

  it("answers a second reject with alreadyResolved and the first decision instant", async () => {
    const fixture = await seedEvent("op121-reject-twice");
    const invitee = await signInVerified(makeIdentity("op121-reject-twice-invitee"));
    const invitationId = await invite(fixture, userInvite(invitee.userId.toHexString()));

    const first = await rejectInApp(inAppDecision(invitee.cookie, invitationId, "reject"));
    expect(first.status).toBe(200);
    const firstBody = await body(first);
    const storedAfterFirst = await storedInvitation(invitationId);

    const second = await rejectInApp(inAppDecision(invitee.cookie, invitationId, "reject"));

    expect(second.status).toBe(200);
    const secondBody = await body(second);
    expectDecisionBody(secondBody);
    expect(secondBody.status).toBe("rejected");
    expect(secondBody.alreadyResolved).toBe(true);
    expect(secondBody.resolvedVia).toBe(firstBody.resolvedVia);
    expect(secondBody.resolvedAt).toBe(firstBody.resolvedAt);
    const storedAfterSecond = await storedInvitation(invitationId);
    expect(storedAfterSecond?.resolvedAt).toEqual(storedAfterFirst?.resolvedAt);
  });

  it("does not let a late reject undo an earlier accept", async () => {
    const fixture = await seedEvent("op121-final");
    const invitee = await signInVerified(makeIdentity("op121-final-invitee"));
    const invitationId = await invite(fixture, userInvite(invitee.userId.toHexString()));

    expect((await acceptInApp(inAppDecision(invitee.cookie, invitationId, "accept"))).status).toBe(
      200
    );
    const rejected = await rejectInApp(inAppDecision(invitee.cookie, invitationId, "reject"));

    expect(rejected.status).toBe(200);
    const payload = await body(rejected);
    expect(payload.status).toBe("accepted");
    expect(payload.alreadyResolved).toBe(true);
    expect(payload.resolvedVia).toBe("in_app");
    expect((await storedInvitation(invitationId))?.status).toBe("accepted");
    const rows = await eventMembers(fixture);
    expect(rows.filter((row) => row.userId === invitee.userId.toHexString())).toHaveLength(1);
  });

  it("I7: answers 403 invitation_not_for_you when another user accepts", async () => {
    const fixture = await seedEvent("op121-wrong-user");
    const invited = await signInVerified(makeIdentity("op121-wrong-user-invited"));
    const stranger = await signInVerified(makeIdentity("op121-wrong-user-stranger"));
    const invitationId = await invite(fixture, userInvite(invited.userId.toHexString()));

    const response = await acceptInApp(inAppDecision(stranger.cookie, invitationId, "accept"));

    expect(response.status).toBe(403);
    const error = await errorOf(response);
    expect(error.code).toBe("invitation_not_for_you");
    expect(typeof error.details.inviteeMasked).toBe("string");
    const stored = await storedInvitation(invitationId);
    expect(stored?.status).toBe("pending");
    expect(stored?.resolvedAt).toBeNull();
    expect(await eventMembers(fixture)).toHaveLength(1);
  });

  it("answers 404 not_found for an invitation id that does not exist", async () => {
    const caller = await signInVerified(makeIdentity("op121-missing-caller"));

    const response = await acceptInApp(
      inAppDecision(caller.cookie, new ObjectId().toHexString(), "accept")
    );

    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe("not_found");
  });

  it("answers 404 not_found for a malformed invitation id", async () => {
    const caller = await signInVerified(makeIdentity("op121-malformed-caller"));

    const response = await acceptInApp(inAppDecision(caller.cookie, "not-an-id", "accept"));

    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe("not_found");
  });

  it("answers 401 without a session", async () => {
    const fixture = await seedEvent("op121-in-app-401");
    const invitee = await signInVerified(makeIdentity("op121-in-app-401-invitee"));
    const invitationId = await invite(fixture, userInvite(invitee.userId.toHexString()));

    const response = await acceptInApp(inAppDecision(null, invitationId, "accept"));

    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("authentication_required");
    expect((await storedInvitation(invitationId))?.status).toBe("pending");
  });
});

/* -------------------------------------------------------------------------- */
/* The token (email / SMS) decision path                                      */
/* -------------------------------------------------------------------------- */

describe("POST /api/v1/invitations/{token}/accept — email and SMS", () => {
  it("I1: accepts twice, answering 200 then 200 alreadyResolved", async () => {
    const fixture = await seedEvent("op121-i1");
    const inviteeIdentity = makeIdentity("op121-i1-invitee");
    const invitationId = await invite(fixture, emailInvite(inviteeIdentity.email));
    const invitee = await signInVerified(inviteeIdentity);
    const token = await rawTokenOf(invitationId);

    const first = await acceptByToken(tokenDecision(invitee.cookie, token, "accept"));

    expect(first.status).toBe(200);
    const firstBody = await body(first);
    expectDecisionBody(firstBody);
    expect(firstBody.status).toBe("accepted");
    expect(firstBody.alreadyResolved).toBe(false);
    expect(firstBody.resolvedVia).toBe("email");
    expect(firstBody.membership).toEqual({
      eventId: fixture.eventId.toHexString(),
      role: "co_organizer",
    });

    const second = await acceptByToken(tokenDecision(invitee.cookie, token, "accept"));

    expect(second.status).toBe(200);
    const secondBody = await body(second);
    expectDecisionBody(secondBody);
    expect(secondBody.status).toBe("accepted");
    expect(secondBody.alreadyResolved).toBe(true);
    expect(secondBody.resolvedVia).toBe("email");
    expect(secondBody.resolvedAt).toBe(firstBody.resolvedAt);
    const rows = await eventMembers(fixture);
    expect(rows.filter((row) => row.userId === invitee.userId.toHexString())).toHaveLength(1);
  });

  it("I2: an email accept then an in-app accept answers alreadyResolved resolvedVia email", async () => {
    const fixture = await seedEvent("op121-i2");
    const inviteeIdentity = makeIdentity("op121-i2-invitee");
    const invitationId = await invite(fixture, emailInvite(inviteeIdentity.email));
    const invitee = await signInVerified(inviteeIdentity);
    const token = await rawTokenOf(invitationId);

    expect((await acceptByToken(tokenDecision(invitee.cookie, token, "accept"))).status).toBe(200);

    const inApp = await acceptInApp(inAppDecision(invitee.cookie, invitationId, "accept"));

    expect(inApp.status).toBe(200);
    const payload = await body(inApp);
    expectDecisionBody(payload);
    expect(payload.status).toBe("accepted");
    expect(payload.alreadyResolved).toBe(true);
    expect(payload.resolvedVia).toBe("email");
    expect(payload.membership).toEqual({
      eventId: fixture.eventId.toHexString(),
      role: "co_organizer",
    });
  });

  it("I2: accepts in-app after the invitee signed up with the invited address", async () => {
    const fixture = await seedEvent("op121-i2-signup");
    const inviteeIdentity = makeIdentity("op121-i2-signup-invitee");
    const invitationId = await invite(fixture, emailInvite(inviteeIdentity.email));
    const invitee = await signInVerified(inviteeIdentity);

    const response = await acceptInApp(inAppDecision(invitee.cookie, invitationId, "accept"));

    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload.status).toBe("accepted");
    expect(payload.resolvedVia).toBe("in_app");
    const rows = await eventMembers(fixture);
    expect(rows.filter((row) => row.userId === invitee.userId.toHexString())).toHaveLength(1);
  });

  it("records the SMS channel when the link carries ?via=sms", async () => {
    const fixture = await seedEvent("op121-via-sms");
    const inviteeIdentity = makeIdentity("op121-via-sms-invitee");
    const invitationId = await invite(fixture, emailInvite(inviteeIdentity.email));
    const invitee = await signInVerified(inviteeIdentity);
    const token = await rawTokenOf(invitationId);

    const response = await acceptByToken(
      tokenDecision(invitee.cookie, token, "accept", "?via=sms")
    );

    expect(response.status).toBe(200);
    expect((await body(response)).resolvedVia).toBe("sms");
    expect((await storedInvitation(invitationId))?.resolvedVia).toBe("sms");
  });

  it("rejects over the token path and grants nothing", async () => {
    const fixture = await seedEvent("op121-token-reject");
    const inviteeIdentity = makeIdentity("op121-token-reject-invitee");
    const invitationId = await invite(fixture, emailInvite(inviteeIdentity.email));
    const invitee = await signInVerified(inviteeIdentity);
    const token = await rawTokenOf(invitationId);

    const response = await rejectByToken(tokenDecision(invitee.cookie, token, "reject"));

    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload.status).toBe("rejected");
    expect(payload.alreadyResolved).toBe(false);
    expect(payload.resolvedVia).toBe("email");
    expect((await storedInvitation(invitationId))?.status).toBe("rejected");
    expect(await eventMembers(fixture)).toHaveLength(1);
  });

  it("I6: answers 401 with the sign-in affordance and keeps the invitation pending", async () => {
    const fixture = await seedEvent("op121-i6");
    const inviteeIdentity = makeIdentity("op121-i6-invitee");
    const invitationId = await invite(fixture, emailInvite(inviteeIdentity.email));
    const token = await rawTokenOf(invitationId);

    const response = await acceptByToken(tokenDecision(null, token, "accept"));

    expect(response.status).toBe(401);
    const error = await errorOf(response);
    expect(error.code).toBe("authentication_required");
    expect(String(error.details.loginUrl)).toContain(token);
    expect(error.details.inviteePreview).toEqual({
      emailMasked: maskEmail(inviteeIdentity.email),
    });
    const stored = await storedInvitation(invitationId);
    expect(stored?.status).toBe("pending");
    expect(stored?.resolvedAt).toBeNull();
    expect(stored?.revokedAt).toBeNull();
    expect(await eventMembers(fixture)).toHaveLength(1);
  });

  it("I7: answers 403 invitation_not_for_you for a different signed-in user", async () => {
    const fixture = await seedEvent("op121-token-wrong-user");
    const inviteeIdentity = makeIdentity("op121-token-wrong-user-invitee");
    const invitationId = await invite(fixture, emailInvite(inviteeIdentity.email));
    const stranger = await signInVerified(makeIdentity("op121-token-wrong-user-stranger"));
    const token = await rawTokenOf(invitationId);

    const response = await acceptByToken(tokenDecision(stranger.cookie, token, "accept"));

    expect(response.status).toBe(403);
    const error = await errorOf(response);
    expect(error.code).toBe("invitation_not_for_you");
    expect(error.details.inviteeMasked).toBe(maskEmail(inviteeIdentity.email));
    expect((await storedInvitation(invitationId))?.status).toBe("pending");
    expect(await eventMembers(fixture)).toHaveLength(1);
  });

  it("answers 404 not_found for a token that was never issued", async () => {
    const stranger = await signInVerified(makeIdentity("op121-token-404-caller"));

    const response = await acceptByToken(tokenDecision(stranger.cookie, "x".repeat(43), "accept"));

    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe("not_found");
  });

  it("I3: answers 410 invitation_revoked after the organizer revoked", async () => {
    const fixture = await seedEvent("op121-i3");
    const inviteeIdentity = makeIdentity("op121-i3-invitee");
    const invitationId = await invite(fixture, emailInvite(inviteeIdentity.email));
    const invitee = await signInVerified(inviteeIdentity);
    const token = await rawTokenOf(invitationId);
    expect(
      (
        await revokeInvitation(
          revokeRequest(fixture.workspace.organizer.cookie, fixture, invitationId)
        )
      ).status
    ).toBe(200);

    const response = await acceptByToken(tokenDecision(invitee.cookie, token, "accept"));

    expect(response.status).toBe(410);
    const error = await errorOf(response);
    expect(error.code).toBe("invitation_revoked");
    expect(error.details).toHaveProperty("revokedAt");
    expect((await storedInvitation(invitationId))?.status).toBe("revoked");
    expect(await eventMembers(fixture)).toHaveLength(1);
  });

  it("I3: answers 410 invitation_revoked on the in-app path after revocation", async () => {
    const fixture = await seedEvent("op121-i3-in-app");
    const invitee = await signInVerified(makeIdentity("op121-i3-in-app-invitee"));
    const invitationId = await invite(fixture, userInvite(invitee.userId.toHexString()));
    expect(
      (
        await revokeInvitation(
          revokeRequest(fixture.workspace.organizer.cookie, fixture, invitationId)
        )
      ).status
    ).toBe(200);

    const response = await acceptInApp(inAppDecision(invitee.cookie, invitationId, "accept"));

    expect(response.status).toBe(410);
    expect((await errorOf(response)).code).toBe("invitation_revoked");
    expect(await eventMembers(fixture)).toHaveLength(1);
  });

  it("I4: answers 410 invitation_expired for a row already marked expired", async () => {
    const fixture = await seedEvent("op121-i4");
    const inviteeIdentity = makeIdentity("op121-i4-invitee");
    const invitationId = await invite(fixture, emailInvite(inviteeIdentity.email));
    const invitee = await signInVerified(inviteeIdentity);
    const token = await rawTokenOf(invitationId);
    const expiredAt = new Date("2026-09-01T09:00:00.000Z");
    // The status alone decides the refusal (§2.3 rule 4); `expireAt` keeps the
    // create-time instant so the §13.6 TTL index cannot delete the row mid-case.
    await app.db
      .collection(COLLECTIONS.invitations)
      .updateOne(
        { _id: new ObjectId(invitationId) },
        { $set: { status: "expired", expiresAt: expiredAt } }
      );

    const response = await acceptByToken(tokenDecision(invitee.cookie, token, "accept"));

    expect(response.status).toBe(410);
    const error = await errorOf(response);
    expect(error.code).toBe("invitation_expired");
    expect(error.details).toHaveProperty("expiredAt");
    expect(await eventMembers(fixture)).toHaveLength(1);
  });

  it("I4: answers 410 invitation_expired for a pending row past its deadline", async () => {
    const fixture = await seedEvent("op121-i4-pending");
    const inviteeIdentity = makeIdentity("op121-i4-pending-invitee");
    const invitationId = await invite(fixture, emailInvite(inviteeIdentity.email));
    const invitee = await signInVerified(inviteeIdentity);
    const token = await rawTokenOf(invitationId);
    // The row is still `pending` — the hourly sweeper has not run — but its
    // decision window closed. `expireAt` stays in the future so the §13.6 TTL
    // index cannot delete the row mid-case.
    await app.db.collection(COLLECTIONS.invitations).updateOne(
      { _id: new ObjectId(invitationId) },
      {
        $set: {
          expiresAt: new Date(Date.now() - 60_000),
          expireAt: new Date(Date.now() + 3_600_000),
        },
      }
    );

    const response = await acceptByToken(tokenDecision(invitee.cookie, token, "accept"));

    expect(response.status).toBe(410);
    expect((await errorOf(response)).code).toBe("invitation_expired");
    expect((await storedInvitation(invitationId))?.status).toBe("pending");
    expect(await eventMembers(fixture)).toHaveLength(1);
  });

  it("I9: an invitee whose matching email is unverified cannot accept (403)", async () => {
    const fixture = await seedEvent("op121-i9-email");
    const inviteeIdentity = makeIdentity("op121-i9-email-invitee");
    const invitationId = await invite(fixture, emailInvite(inviteeIdentity.email));
    const invitee = await signInVerified(inviteeIdentity);
    const token = await rawTokenOf(invitationId);
    await app.db
      .collection("user")
      .updateOne({ _id: invitee.userId }, { $set: { emailVerified: false } });

    const response = await acceptByToken(tokenDecision(invitee.cookie, token, "accept"));

    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe("account_incomplete");
    expect((await storedInvitation(invitationId))?.status).toBe("pending");
    expect(await eventMembers(fixture)).toHaveLength(1);
  });

  it("I9: an invitee whose matching phone is unverified cannot accept (403)", async () => {
    const fixture = await seedEvent("op121-i9-phone");
    const inviteeIdentity = makeIdentity("op121-i9-phone-invitee");
    const invitee = await signInVerified(inviteeIdentity);
    const phone = "+919876500121";
    await app.db
      .collection("user")
      .updateOne(
        { _id: invitee.userId },
        { $set: { phoneNumber: phone, phoneNumberVerified: false } }
      );
    const invitationId = await invite(fixture, phoneInvite(phone));
    const token = await rawTokenOf(invitationId);

    const response = await acceptByToken(tokenDecision(invitee.cookie, token, "accept"));

    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe("account_incomplete");
    expect((await storedInvitation(invitationId))?.status).toBe("pending");
    expect(await eventMembers(fixture)).toHaveLength(1);
  });

  it("I9: an invitee whose matching phone is verified may accept", async () => {
    const fixture = await seedEvent("op121-i9-phone-ok");
    const inviteeIdentity = makeIdentity("op121-i9-phone-ok-invitee");
    const invitee = await signInVerified(inviteeIdentity);
    const phone = "+919876500122";
    await app.db
      .collection("user")
      .updateOne(
        { _id: invitee.userId },
        { $set: { phoneNumber: phone, phoneNumberVerified: true } }
      );
    const invitationId = await invite(fixture, phoneInvite(phone));
    const token = await rawTokenOf(invitationId);

    const response = await acceptByToken(tokenDecision(invitee.cookie, token, "accept"));

    expect(response.status).toBe(200);
    expect((await body(response)).status).toBe("accepted");
    const rows = await eventMembers(fixture);
    expect(rows.filter((row) => row.userId === invitee.userId.toHexString())).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Concurrency                                                                */
/* -------------------------------------------------------------------------- */

describe("concurrent decisions", () => {
  it("I5: two concurrent accepts create exactly one membership row", async () => {
    const fixture = await seedEvent("op121-i5");
    const invitee = await signInVerified(makeIdentity("op121-i5-invitee"));
    const invitationId = await invite(fixture, userInvite(invitee.userId.toHexString()));

    const [first, second] = await Promise.all([
      acceptInApp(inAppDecision(invitee.cookie, invitationId, "accept")),
      acceptInApp(inAppDecision(invitee.cookie, invitationId, "accept")),
    ]);

    expect([first.status, second.status]).toEqual([200, 200]);
    const payloads = await Promise.all([body(first), body(second)]);
    expect(payloads.map((payload) => payload.status)).toEqual(["accepted", "accepted"]);
    // Exactly one call performed the transition; the other observed it.
    expect(payloads.filter((payload) => payload.alreadyResolved === false)).toHaveLength(1);
    const rows = await eventMembers(fixture);
    expect(rows.filter((row) => row.userId === invitee.userId.toHexString())).toHaveLength(1);
    expect(rows.filter((row) => row.role === "organizer")).toHaveLength(1);
    const accepted = await app.db
      .collection(COLLECTIONS.domainEvents)
      .find({ eventKey: "collab.invite.accepted" })
      .toArray();
    expect(accepted).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* The affordance closes in every channel (§2.3 rule 3)                       */
/* -------------------------------------------------------------------------- */

describe("notifications — the decision closes the in-app affordance", () => {
  it("I11: an email accept marks the in-app actions unavailable", async () => {
    const fixture = await seedEvent("op121-affordance");
    const invitee = await signInVerified(makeIdentity("op121-affordance-invitee"));
    const invitationId = await invite(fixture, userInvite(invitee.userId.toHexString()));
    const token = await rawTokenOf(invitationId);
    const before = await feedInviteRow(invitee.cookie);
    expect(before?.actionTarget).toEqual({ kind: "invitation", id: invitationId, state: "open" });

    expect((await acceptByToken(tokenDecision(invitee.cookie, token, "accept"))).status).toBe(200);

    const after = await feedInviteRow(invitee.cookie);
    expect(after?.actionTarget).toEqual({
      kind: "invitation",
      id: invitationId,
      state: "resolved",
    });
    expect(
      (after?.actions as { key: string; state: string }[]).map((action) => [
        action.key,
        action.state,
      ])
    ).toEqual([
      ["accept", "unavailable"],
      ["reject", "unavailable"],
    ]);
    expect(after?.actionResolvedVia).toBe("email");
    expect(after?.actionResolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("I11: a revocation marks the in-app actions unavailable", async () => {
    const fixture = await seedEvent("op121-affordance-revoked");
    const invitee = await signInVerified(makeIdentity("op121-affordance-revoked-invitee"));
    const invitationId = await invite(fixture, userInvite(invitee.userId.toHexString()));
    await settleInviteDelivery();
    expect((await feedInviteRow(invitee.cookie))?.actionTarget).toMatchObject({ state: "open" });

    expect(
      (
        await revokeInvitation(
          revokeRequest(fixture.workspace.organizer.cookie, fixture, invitationId)
        )
      ).status
    ).toBe(200);

    const after = await feedInviteRow(invitee.cookie);
    expect(
      (after?.actions as { key: string; state: string }[]).map((action) => [
        action.key,
        action.state,
      ])
    ).toEqual([
      ["accept", "unavailable"],
      ["reject", "unavailable"],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Removing an accepted member                                                */
/* -------------------------------------------------------------------------- */

describe("DELETE /api/v1/tenants/{tenantId}/events/{eventId}/members/{userId}", () => {
  it("I8: removes the co-organizer and revokes the originating invitation", async () => {
    const fixture = await seedEvent("op121-i8");
    const invitee = await signInVerified(makeIdentity("op121-i8-invitee"));
    const invitationId = await invite(fixture, userInvite(invitee.userId.toHexString()));
    expect((await acceptInApp(inAppDecision(invitee.cookie, invitationId, "accept"))).status).toBe(
      200
    );

    const response = await removeMember(
      removeMemberRequest(fixture.workspace.organizer.cookie, fixture, invitee.userId)
    );

    expect(response.status).toBe(204);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
    const removed = (await eventMembers(fixture)).find(
      (row) => row.userId === invitee.userId.toHexString()
    );
    expect(removed?.status).toBe("removed");
    expect(removed?.revokedAt).toBeInstanceOf(Date);
    expect((await storedInvitation(invitationId))?.status).toBe("revoked");
  });

  it("I8: a co-organizer reads the event after accepting", async () => {
    const fixture = await seedEvent("op121-i8-access");
    const invitee = await signInVerified(makeIdentity("op121-i8-access-invitee"));
    const invitationId = await invite(fixture, userInvite(invitee.userId.toHexString()));
    expect((await acceptInApp(inAppDecision(invitee.cookie, invitationId, "accept"))).status).toBe(
      200
    );

    const response = await readEvent(readEventRequest(invitee.cookie, fixture));

    expect(response.status).toBe(200);
    expect((await body(response)).id).toBe(fixture.eventId.toHexString());
  });

  it("I8: a removed co-organizer can no longer read the event", async () => {
    const fixture = await seedEvent("op121-i8-lost");
    const invitee = await signInVerified(makeIdentity("op121-i8-lost-invitee"));
    const invitationId = await invite(fixture, userInvite(invitee.userId.toHexString()));
    expect((await acceptInApp(inAppDecision(invitee.cookie, invitationId, "accept"))).status).toBe(
      200
    );
    expect(
      (
        await removeMember(
          removeMemberRequest(fixture.workspace.organizer.cookie, fixture, invitee.userId)
        )
      ).status
    ).toBe(204);

    const response = await readEvent(readEventRequest(invitee.cookie, fixture));

    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe("not_found");
  });

  it("I8: a removed member cannot accept the invitation again (410 revoked)", async () => {
    const fixture = await seedEvent("op121-i8-reaccept");
    const invitee = await signInVerified(makeIdentity("op121-i8-reaccept-invitee"));
    const invitationId = await invite(fixture, userInvite(invitee.userId.toHexString()));
    expect((await acceptInApp(inAppDecision(invitee.cookie, invitationId, "accept"))).status).toBe(
      200
    );
    expect(
      (
        await removeMember(
          removeMemberRequest(fixture.workspace.organizer.cookie, fixture, invitee.userId)
        )
      ).status
    ).toBe(204);

    const response = await acceptInApp(inAppDecision(invitee.cookie, invitationId, "accept"));

    expect(response.status).toBe(410);
    expect((await errorOf(response)).code).toBe("invitation_revoked");
    const rows = await eventMembers(fixture);
    expect(
      rows.filter((row) => row.role === "co_organizer" && row.status === "active")
    ).toHaveLength(0);
  });

  it("I8: refuses to remove the organizer with 409 cannot_remove_organizer", async () => {
    const fixture = await seedEvent("op121-i8-organizer");

    const response = await removeMember(
      removeMemberRequest(
        fixture.workspace.organizer.cookie,
        fixture,
        fixture.workspace.organizer.userId
      )
    );

    expect(response.status).toBe(409);
    const error = await errorOf(response);
    expect(error.code).toBe("cannot_remove_organizer");
    expect(error.details).toHaveProperty("transferOwnershipUrl");
    const organizer = (await eventMembers(fixture)).find((row) => row.role === "organizer");
    expect(organizer?.revokedAt).toBeNull();
  });

  it("answers 403 to a co-organizer who tries to remove a member", async () => {
    const fixture = await seedEvent("op121-remove-forbidden");
    const coOrganizer = await signInVerified(makeIdentity("op121-remove-forbidden-co"));
    await addEventMember(fixture, coOrganizer, "co_organizer", { workspaceMember: true });
    const victim = await signInVerified(makeIdentity("op121-remove-forbidden-victim"));
    const invitationId = await invite(fixture, userInvite(victim.userId.toHexString()));
    expect((await acceptInApp(inAppDecision(victim.cookie, invitationId, "accept"))).status).toBe(
      200
    );

    const response = await removeMember(
      removeMemberRequest(coOrganizer.cookie, fixture, victim.userId)
    );

    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe("forbidden");
    const victimRow = (await eventMembers(fixture)).find(
      (row) => row.userId === victim.userId.toHexString()
    );
    expect(victimRow?.status).toBe("active");
  });

  it("answers 401 without a session", async () => {
    const fixture = await seedEvent("op121-remove-401");
    const member = await signInVerified(makeIdentity("op121-remove-401-member"));

    const response = await removeMember(removeMemberRequest(null, fixture, member.userId));

    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("authentication_required");
  });
});
