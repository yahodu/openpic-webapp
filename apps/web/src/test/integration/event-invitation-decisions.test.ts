import { randomUUID } from "node:crypto";

import { Collection, ObjectId, type ClientSession } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import { withTransaction } from "@/server/db/transaction";
import { emitDomainEvent } from "@/server/domain/domain-events";
import {
  createLogger,
  getLogger,
  memoryTransport,
  setLogger,
  type MemoryTransport,
} from "@/server/logging";
import { runNotificationFanOut } from "@/server/notifications/fan-out";
import { invalidateNotificationTypeCache } from "@/server/notifications/notification-type-cache";
import {
  seedNotificationTemplates,
  seedNotificationTypes,
} from "@/server/notifications/seed-notification-types";
import { tenantRepo } from "@/server/repos";
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
 * ## Assumptions (ADR-0665 §Assumptions)
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
 * - **I-A6** — the concurrent accept pair is fired through `Promise.all` **and**
 *   held at the transaction boundary (`invitationRaceGate`), because `Promise.all`
 *   alone leaves the interleaving to the event loop: the second request's
 *   admission reads take milliseconds, so by the time it opens its transaction
 *   the first has usually committed and the pair measures nothing (green on
 *   every isolated run of the file, ADR-0666). The latch is a measurement device, not
 *   a requirement on the implementation: a route that serialises the pair never
 *   brings the second racer to the boundary, and the first is released by the
 *   grace expiry instead of being parked forever.
 */

/* ────────────────────────────── the race gate ───────────────────────────── */

/** How many accepts the one concurrent case fires at the same instant. */
const CONCURRENT_ACCEPTS = 2;

/**
 * How long a racer waits for its rival at the transaction boundary before a
 * serialising implementation is let through.
 *
 * The gate exists to make the case deterministic, not to require a particular
 * fix: an implementation that serialises the two accepts before their
 * transactions never brings the second racer to this line, so the first is
 * released by the expiry instead of being parked forever.
 */
const INVITATION_RACE_GRACE_MS = 250;

/**
 * How long the winning racer's transaction is held open **after** its writes
 * and **before** it commits, once its rival has met it at the boundary.
 *
 * Meeting at the boundary alone is not enough: measured on the trunk, the loser
 * spends its whole retry budget in ~5 ms and then reads the row the winner has
 * already committed, so it answers `200` by luck — 3/3 green. A peer whose
 * commit lands a little later (a loaded database, majority write concern) is
 * what turned the same pair into `[200, 500]` on CI, and no fixed retry budget
 * can bound a peer that is slower still. Holding the winner's commit for a time
 * that is far longer than any budget can spend (each attempt is one round trip)
 * makes the pair's outcome a property of the contract instead of the clock: the
 * loser must answer from the settled invitation, never from a spent budget.
 *
 * The hold is bounded and modest, so a fix that waits for the settled row
 * (the bounded-wait shape this file's member-removal cases already use) still
 * answers within its own ceiling.
 */
const INVITATION_RIVAL_HOLD_MS = 100;

/**
 * A bounded latch on the decision's transaction boundary.
 *
 * `Promise.all` alone leaves the interleaving to the event loop, and this case
 * was measured passing on the defect when the two requests happened to run one
 * after the other — a time-based stagger is not a pin (ADR-0666). Every racer
 * passes this gate **after** the decision's admission and **before** its
 * transaction opens, so both requests take their contention window together;
 * the racers that met are then held past their writes, so one of them commits
 * after the other has spent its retry budget.
 *
 * The latch is armed only by the concurrent case; every other transaction in
 * this file passes through it untouched, and a lone racer is released by the
 * grace expiry without being held.
 */
const invitationRaceGate = vi.hoisted(() => {
  let armed = false;
  let arrivals = 0;
  let expected = 0;
  let released: Promise<void> = Promise.resolve();
  let release = (): void => undefined;

  return {
    /**
     * Close the gate for `count` racers.
     *
     * @param count - How many racers must arrive before either proceeds.
     */
    close(count: number): void {
      armed = true;
      arrivals = 0;
      expected = count;
      released = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    /**
     * Wait at the gate until every racer has arrived, or the grace expires.
     *
     * @param graceMs - The longest a lone racer is held.
     * @returns `true` when a rival arrived within the grace, so this racer's
     *   transaction must be held open before it commits.
     */
    async arrive(graceMs: number): Promise<boolean> {
      if (!armed) {
        return false;
      }
      arrivals += 1;
      if (arrivals >= expected) {
        armed = false;
        release();
        return true;
      }
      let expired = false;
      const expiry = setTimeout(() => {
        expired = true;
        release();
      }, graceMs);
      await released;
      clearTimeout(expiry);
      armed = false;
      return !expired;
    },
  };
});

vi.mock("@/server/db/transaction", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db/transaction")>();
  return {
    ...actual,
    withTransaction: async <T>(
      fn: (session: ClientSession) => Promise<T>,
      options?: Parameters<typeof actual.withTransaction>[1]
    ): Promise<T> => {
      const met = await invitationRaceGate.arrive(INVITATION_RACE_GRACE_MS);
      const body = async (session: ClientSession): Promise<T> => {
        const result = await fn(session);
        if (met) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, INVITATION_RIVAL_HOLD_MS);
          });
        }
        return result;
      };
      return actual.withTransaction(body, options);
    },
  };
});

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

    // Both accepts are held at their transaction boundary until the other
    // arrives (bounded by the grace), so the pair contends for the same row
    // instead of leaving the interleaving to the event loop (ADR-0666).
    invitationRaceGate.close(CONCURRENT_ACCEPTS);

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

/* -------------------------------------------------------------------------- */
/* F1 — the member removal is one transaction                                 */
/* -------------------------------------------------------------------------- */

/**
 * The removal (`…/members/{userId}`) performs three writes — the
 * `event_organizers` update, the revoke of the granting invitation, then the
 * two `collab.member.removed` emits — inside **one** `withTransaction`, so the
 * request either moves both rows and notifies both parties, or moves neither.
 *
 * Both failure arms are injected on the driver writes the removal goes
 * through, and the same three promises are measured on each:
 *
 * - a failed removal is **never** reported as a success (`204`) — it answers
 *   `500 internal_error`;
 * - no `collab.member.removed` / `.ack` row reaches the outbox for it;
 * - neither of the two rows moved: the organizer row keeps its pre-removal
 *   `status` and a null `revokedAt`, and the granting invitation still reads
 *   `accepted`.
 *
 * That last point is what makes the removal replayable: the retry below asks
 * again with a healthy seam, answers `204` and moves both rows.
 */

/** The outbox rows of one event key (the emit seam these pins fail). */
async function outboxRows(eventKey: string): Promise<Record<string, unknown>[]> {
  return app.db.collection(COLLECTIONS.domainEvents).find({ eventKey }).toArray();
}

/** The `[key, state]` pairs of a feed row's in-app actions (§7.3). */
function actionPairs(row: Record<string, unknown> | undefined): [string, string][] {
  const actions = (row?.actions ?? []) as { readonly key: string; readonly state: string }[];
  return actions.map((action): [string, string] => [action.key, action.state]);
}

/**
 * The driver failures these pins inject.
 *
 * `code: 91` is a transient primary-election error: it is deliberately **not**
 * a duplicate key, so neither `emitDomainEvent`'s E11000 branch nor
 * `withTransaction`'s error-label retry can absorb it — the failure has to
 * reach the endpoint.
 */
function driverFailure(): Error {
  return Object.assign(new Error("not primary"), { code: 91 });
}

/**
 * Resolve the two driver prototype methods once, at module load, before any
 * spec installs a spy. Resolving them at call time inside a stub would find the
 * spy and recurse (the `billing-checkout.test.ts:177` precedent).
 */
const driverInsertOne = ((): typeof Collection.prototype.insertOne => {
  const descriptor = Object.getOwnPropertyDescriptor(Collection.prototype, "insertOne");
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    throw new Error("the driver's Collection#insertOne is missing from the prototype");
  }
  return descriptor.value as typeof Collection.prototype.insertOne;
})();

const driverUpdateMany = ((): typeof Collection.prototype.updateMany => {
  const descriptor = Object.getOwnPropertyDescriptor(Collection.prototype, "updateMany");
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    throw new Error("the driver's Collection#updateMany is missing from the prototype");
  }
  return descriptor.value as typeof Collection.prototype.updateMany;
})();

/** The driver's own argument tuples, so the stubs forward without re-declaring them. */
type DriverInsertOneArgs = Parameters<typeof driverInsertOne>;
type DriverUpdateManyArgs = Parameters<typeof driverUpdateMany>;

/**
 * Make every outbox insert fail — the driver write behind `emitDomainEvent`.
 *
 * @returns The spy, so the case can restore it in a `finally`.
 */
function failDomainEventWrites(): { mockRestore: () => void } {
  const failure = driverFailure();
  return vi.spyOn(Collection.prototype, "insertOne").mockImplementation(function (
    this: Collection,
    ...args: DriverInsertOneArgs
  ) {
    if (this.collectionName === COLLECTIONS.domainEvents) {
      return Promise.reject(failure);
    }
    return driverInsertOne.call(this, ...args);
  } as never);
}

/**
 * Make the invitation revoke fail — the removal's **second** write, which runs
 * after the `event_organizers` update has already committed.
 *
 * @returns The spy, so the case can restore it in a `finally`.
 */
function failInvitationRevoke(): { mockRestore: () => void } {
  const failure = driverFailure();
  return vi.spyOn(Collection.prototype, "updateMany").mockImplementation(function (
    this: Collection,
    ...args: DriverUpdateManyArgs
  ) {
    if (this.collectionName === COLLECTIONS.invitations) {
      return Promise.reject(failure);
    }
    return driverUpdateMany.call(this, ...args);
  } as never);
}

/**
 * Make the affordance closure fail — the `notifications` `updateMany` that
 * `closeInvitationAffordance` runs after the reject has already been written.
 *
 * @returns The spy, so the case can restore it in a `finally`.
 */
function failAffordanceClosure(): { mockRestore: () => void } {
  const failure = driverFailure();
  return vi.spyOn(Collection.prototype, "updateMany").mockImplementation(function (
    this: Collection,
    ...args: DriverUpdateManyArgs
  ) {
    if (this.collectionName === COLLECTIONS.notifications) {
      return Promise.reject(failure);
    }
    return driverUpdateMany.call(this, ...args);
  } as never);
}

/**
 * Seed an accepted co-organizer: the organizer's event, an invitation for
 * `invitee`, and the accept that inserts the membership row.
 *
 * @param prefix - A unique suite-local prefix.
 * @param invitee - The signed-in invitee (not a workspace member).
 * @returns The event and the invitation id.
 */
async function acceptedMember(
  prefix: string,
  invitee: SignedInUser
): Promise<{ readonly fixture: EventFixture; readonly invitationId: string }> {
  const fixture = await seedEvent(prefix);
  const invitationId = await invite(fixture, userInvite(invitee.userId.toHexString()));
  expect((await acceptInApp(inAppDecision(invitee.cookie, invitationId, "accept"))).status).toBe(
    200
  );
  return { fixture, invitationId };
}

describe("DELETE /api/v1/tenants/{tenantId}/events/{eventId}/members/{userId} — the write pairing (F1)", () => {
  it("F1-control: answers 204, moves both rows, emits both events and keeps the member un-admitted", async () => {
    const invitee = await signInVerified(makeIdentity("op121-f1-control-invitee"));
    const { fixture, invitationId } = await acceptedMember("op121-f1-control", invitee);
    // Arrange guard: the co-organizer really is admitted before the removal
    // (the event read runs `tenantStage({ admission: admitEventActor })`,
    // ADR-0644), so the `404` after it can only come from the removal.
    expect((await readEvent(readEventRequest(invitee.cookie, fixture))).status).toBe(200);

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

    // The notification half of the removal: one event to the removed member and
    // one to the organizer, both naming the removed user as the subject.
    const removalEvents = await outboxRows("collab.member.removed");
    expect(removalEvents).toHaveLength(1);
    expect(removalEvents.at(0)?.subjectRef).toEqual({
      kind: "user",
      id: invitee.userId.toHexString(),
    });
    expect((await outboxRows("collab.member.removed.ack")).at(0)?.subjectRef).toEqual({
      kind: "user",
      id: invitee.userId.toHexString(),
    });

    // The structural promise: access really ended.
    const afterRemoval = await readEvent(readEventRequest(invitee.cookie, fixture));
    expect(afterRemoval.status).toBe(404);
    expect((await errorOf(afterRemoval)).code).toBe("not_found");
  });

  it("F1: a failing invitation revoke answers 500 internal_error and rolls the member update back", async () => {
    const invitee = await signInVerified(makeIdentity("op121-f1-revoke-invitee"));
    const { fixture, invitationId } = await acceptedMember("op121-f1-revoke", invitee);

    const stub = failInvitationRevoke();
    let response: Response;
    try {
      response = await removeMember(
        removeMemberRequest(fixture.workspace.organizer.cookie, fixture, invitee.userId)
      );
    } finally {
      stub.mockRestore();
    }

    // The pinned invariant: a removal whose second write failed is never
    // reported as success, and it notifies nobody.
    expect(response.status).toBe(500);
    expect((await errorOf(response)).code).toBe("internal_error");
    expect(await outboxRows("collab.member.removed")).toHaveLength(0);
    expect(await outboxRows("collab.member.removed.ack")).toHaveLength(0);

    // The transaction: write 1 is rolled back with write 2, so the member is
    // still admitted and the invitation that granted the seat still reads
    // `accepted` — the two rows never disagree.
    const removed = (await eventMembers(fixture)).find(
      (row) => row.userId === invitee.userId.toHexString()
    );
    expect(removed?.status).toBe("active");
    expect(removed?.revokedAt ?? null).toBeNull();
    expect((await storedInvitation(invitationId))?.status).toBe("accepted");

    // ...and because nothing moved, the API can repair itself: the retry with
    // a healthy seam answers `204` and moves both rows.
    const retry = await removeMember(
      removeMemberRequest(fixture.workspace.organizer.cookie, fixture, invitee.userId)
    );
    expect(retry.status).toBe(204);
    expect((await storedInvitation(invitationId))?.status).toBe("revoked");
    expect(await outboxRows("collab.member.removed")).toHaveLength(1);
  });

  it("F1: a failing removal event answers 500 internal_error, drops both events and moves neither row", async () => {
    const invitee = await signInVerified(makeIdentity("op121-f1-emit-invitee"));
    const { fixture, invitationId } = await acceptedMember("op121-f1-emit", invitee);

    const stub = failDomainEventWrites();
    let response: Response;
    try {
      response = await removeMember(
        removeMemberRequest(fixture.workspace.organizer.cookie, fixture, invitee.userId)
      );
    } finally {
      stub.mockRestore();
    }

    expect(response.status).toBe(500);
    expect((await errorOf(response)).code).toBe("internal_error");
    // The first emit failed, so the loop never reached `.ack`: a swallowed
    // failure would leave one of the two rows behind and answer `204`.
    expect(await outboxRows("collab.member.removed")).toHaveLength(0);
    expect(await outboxRows("collab.member.removed.ack")).toHaveLength(0);

    // The transaction: both row writes are rolled back with the emit, so the
    // removal is still to do rather than half done.
    const removed = (await eventMembers(fixture)).find(
      (row) => row.userId === invitee.userId.toHexString()
    );
    expect(removed?.status).toBe("active");
    expect(removed?.revokedAt ?? null).toBeNull();
    expect((await storedInvitation(invitationId))?.status).toBe("accepted");

    // ...and the retry with a healthy emit seam completes it.
    const retry = await removeMember(
      removeMemberRequest(fixture.workspace.organizer.cookie, fixture, invitee.userId)
    );
    expect(retry.status).toBe(204);
    expect(await outboxRows("collab.member.removed")).toHaveLength(1);
    expect(await outboxRows("collab.member.removed.ack")).toHaveLength(1);
  });

  it("F1: two concurrent removals of the same member notify each party exactly once", async () => {
    const invitee = await signInVerified(makeIdentity("op121-f1-double-invitee"));
    const { fixture, invitationId } = await acceptedMember("op121-f1-double", invitee);

    // A double click (or a client retry racing the first request): both calls
    // pass the pre-transaction lookup, so only one may perform the removal.
    const [first, second] = await Promise.all([
      removeMember(
        removeMemberRequest(fixture.workspace.organizer.cookie, fixture, invitee.userId)
      ),
      removeMember(
        removeMemberRequest(fixture.workspace.organizer.cookie, fixture, invitee.userId)
      ),
    ]);

    // The loser is told the same thing as the winner: the removal is done.
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);

    // One removal, one notification per party — the idempotency half.
    expect(await outboxRows("collab.member.removed")).toHaveLength(1);
    expect(await outboxRows("collab.member.removed.ack")).toHaveLength(1);

    const removed = (await eventMembers(fixture)).find(
      (row) => row.userId === invitee.userId.toHexString()
    );
    expect(removed?.status).toBe("removed");
    expect((await storedInvitation(invitationId))?.status).toBe("revoked");
  });

  it("P1: a re-invited member is notified again by the second removal", async () => {
    // Arrange — an accepted co-organizer, removed once.
    const invitee = await signInVerified(makeIdentity("op121-p1-repeat-invitee"));
    const { fixture } = await acceptedMember("op121-p1-repeat", invitee);
    const firstRemoval = await removeMember(
      removeMemberRequest(fixture.workspace.organizer.cookie, fixture, invitee.userId)
    );
    expect(firstRemoval.status).toBe(204);

    // The re-invite an organizer sends after a removal: a fresh invitation for
    // the same user, accepted by the same invitee. The accept arm restores the
    // seat (`status: "active"`, `revokedAt: null`), so the second removal is a
    // real removal and not a replay of the first.
    const secondInvitationId = await invite(fixture, userInvite(invitee.userId.toHexString()));
    const accept = await acceptInApp(inAppDecision(invitee.cookie, secondInvitationId, "accept"));
    expect(accept.status).toBe(200);

    // Act — the second removal, for the seat the second invitation granted.
    const secondRemoval = await removeMember(
      removeMemberRequest(fixture.workspace.organizer.cookie, fixture, invitee.userId)
    );

    // Assert — the second removal is a removal in its own right: it answers
    // `204` and notifies both parties again. Remembering the member instead of
    // the removal (a constant `dedupeKey`, or a "has this member been notified"
    // check) collapses the repeat: measured, the constant `dedupeKey` answers
    // `500` here and a skip-if-already-notified guard leaves both counts at 1,
    // silently dropping the second, real notification pair.
    expect(secondRemoval.status).toBe(204);
    expect(await outboxRows("collab.member.removed")).toHaveLength(2);
    expect(await outboxRows("collab.member.removed.ack")).toHaveLength(2);

    const removed = (await eventMembers(fixture)).find(
      (row) => row.userId === invitee.userId.toHexString()
    );
    expect(removed?.status).toBe("removed");
    expect(removed?.revokedAt).toBeInstanceOf(Date);
    expect((await storedInvitation(secondInvitationId))?.status).toBe("revoked");
  });

  it("P2: a sequential retry of an already-removed member answers 204 and notifies nobody again", async () => {
    // Decision t_df7d6c3b makes the removal genuinely idempotent (§0.7: an
    // already-terminal transition is success, `404` is reserved for a resource
    // that is not there), so the late retry answers `204` — not the `404
    // not_found` the shipped route returns today.
    const invitee = await signInVerified(makeIdentity("op121-p2-retry-invitee"));
    const { fixture, invitationId } = await acceptedMember("op121-p2-retry", invitee);

    const first = await removeMember(
      removeMemberRequest(fixture.workspace.organizer.cookie, fixture, invitee.userId)
    );
    expect(first.status).toBe(204);

    // Act — the retry that arrives after the first removal committed, so it
    // fails the pre-transaction `revokedAt: null` lookup (unlike the
    // concurrent pair, which both pass it).
    const second = await removeMember(
      removeMemberRequest(fixture.workspace.organizer.cookie, fixture, invitee.userId)
    );

    // Assert — the same answer as the first call, and no second notification
    // pair: an already-removed member is not notified about a removal that
    // already happened.
    expect(second.status).toBe(204);
    expect(await outboxRows("collab.member.removed")).toHaveLength(1);
    expect(await outboxRows("collab.member.removed.ack")).toHaveLength(1);

    const removed = (await eventMembers(fixture)).find(
      (row) => row.userId === invitee.userId.toHexString()
    );
    expect(removed?.status).toBe("removed");
    expect((await storedInvitation(invitationId))?.status).toBe("revoked");
  });

  it("P3: a double removal writes exactly one `event member removed` log line", async () => {
    // Arrange — capture every entry the port writes (`auth-guards.test.ts`
    // and `media-signed-urls.test.ts` I7c install their sink the same way).
    const previous = getLogger();
    const sink: MemoryTransport = memoryTransport();
    setLogger(
      createLogger({ level: "info", transports: [sink], service: "openpic-web", env: "test" })
    );

    try {
      const invitee = await signInVerified(makeIdentity("op121-p3-log-invitee"));
      const { fixture } = await acceptedMember("op121-p3-log", invitee);

      // Act — the same double click the F1 pin races: both calls pass the
      // pre-transaction lookup, so the loser reaches the log call too.
      const [first, second] = await Promise.all([
        removeMember(
          removeMemberRequest(fixture.workspace.organizer.cookie, fixture, invitee.userId)
        ),
        removeMember(
          removeMemberRequest(fixture.workspace.organizer.cookie, fixture, invitee.userId)
        ),
      ]);

      // Arrange guard, not a new contract: the `204`/`204` pairing is the F1
      // pin's. Here it proves both calls reached the log call site, so the
      // count below cannot pass by one call answering before the transaction.
      expect([first.status, second.status]).toEqual([204, 204]);

      // Assert — one removal, one line: the winner's. The loser performed no
      // removal, so a line from it reports a removal that never happened.
      const removalLines = sink.entries.filter((entry) => entry.msg === "event member removed");
      expect(removalLines).toHaveLength(1);
      expect(removalLines.at(0)?.level).toBe("info");
      expect(removalLines.at(0)?.event).toBe("collab.member.removed");
    } finally {
      setLogger(previous);
    }
  });

  it("P4: a repeat removal of a re-invited (pending) member answers 204 and leaves the invitation re-acceptable", async () => {
    // Measured on the merged head `5c6060d` (probe worktree, not a code read):
    // {"secondStatus":204,"invitationBefore":"pending","invitationAfter":"pending",
    //  "memberStatus":"removed","revocations":1,"acceptAfterRemoval":200}.
    // The `204` reports the seat as removed; it says nothing about a pending
    // invitation, which this route never revokes.
    //
    // Arrange — an accepted co-organizer, removed once, then re-invited without
    // accepting the new invitation.
    const invitee = await signInVerified(makeIdentity("op121-p4-pending-invitee"));
    const { fixture } = await acceptedMember("op121-p4-pending", invitee);
    const firstRemoval = await removeMember(
      removeMemberRequest(fixture.workspace.organizer.cookie, fixture, invitee.userId)
    );
    expect(firstRemoval.status).toBe(204);

    const pendingInvitationId = await invite(fixture, userInvite(invitee.userId.toHexString()));

    // Arrange guard: the fresh invitation really is pending, so the assertions
    // below measure the repeat `DELETE`'s effect on it rather than on an
    // already terminal row.
    expect((await storedInvitation(pendingInvitationId))?.status).toBe("pending");

    // Act — the repeat removal, with the re-invite still unaccepted.
    const secondRemoval = await removeMember(
      removeMemberRequest(fixture.workspace.organizer.cookie, fixture, invitee.userId)
    );

    // Assert — `204` is the decided idempotent arm, and it leaves the pending
    // invitation alone: the in-transaction `updateOne({ _id, revokedAt: null })`
    // matches nothing for an already-removed row, so the route returns before
    // its invitation write.
    expect(secondRemoval.status).toBe(204);
    expect((await storedInvitation(pendingInvitationId))?.status).toBe("pending");

    const removed = (await eventMembers(fixture)).find(
      (row) => row.userId === invitee.userId.toHexString()
    );
    expect(removed?.status).toBe("removed");

    // The first removal's pair, and only that pair: the repeat performed no
    // removal, so it notifies nobody again.
    expect(await outboxRows("collab.member.removed")).toHaveLength(1);
    expect(await outboxRows("collab.member.removed.ack")).toHaveLength(1);

    // Assert — the invitation the `204` did not withdraw is still usable: the
    // invitee accepts it and regains the seat.
    const accept = await acceptInApp(inAppDecision(invitee.cookie, pendingInvitationId, "accept"));
    expect(accept.status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/* F2 — the reject path's status write, affordance closure and emit          */
/* -------------------------------------------------------------------------- */

/**
 * `transition()` writes the terminal status, `decideInvitation()` then closes
 * the in-app affordance and, for a reject, emits `collab.invite.rejected`.
 * Both decisions run all three writes inside one `withTransaction`, so a
 * failure on any step leaves the invitation `pending` with no `resolvedAt` and
 * the invitee's affordance `open` / `available` — the decision is still to do,
 * and a retry completes it.
 *
 * These pins inject the same failure class on both branches and measure the
 * outcome, so the pairing is asserted rather than assumed:
 *
 * - the endpoint never reports a decision it could not complete (`500`, never
 *   `200`) and writes no `collab.invite.rejected` row;
 * - the rolled-back reject is not terminal: the row still reads `pending`, the
 *   in-app actions stay `available`, and the retry with the seam healthy
 *   performs the reject and emits exactly one event;
 * - the accept branch's transaction pairs all three writes the same way: the
 *   same emit failure leaves the invitation `pending` and inserts no
 *   `event_organizers` row.
 */
describe("POST /api/v1/me/invitations/{invitationId}/reject — the write pairing (F2)", () => {
  it("F2-contrast: an accept whose event fails rolls back — the transaction pairs all three writes", async () => {
    const fixture = await seedEvent("op121-f2-accept");
    const invitee = await signInVerified(makeIdentity("op121-f2-accept-invitee"));
    const invitationId = await invite(fixture, userInvite(invitee.userId.toHexString()));

    const stub = failDomainEventWrites();
    let response: Response;
    try {
      response = await acceptInApp(inAppDecision(invitee.cookie, invitationId, "accept"));
    } finally {
      stub.mockRestore();
    }

    expect(response.status).toBe(500);
    expect((await errorOf(response)).code).toBe("internal_error");
    // The transaction aborted: no status write, no membership, no event.
    expect((await storedInvitation(invitationId))?.status).toBe("pending");
    expect(
      (await eventMembers(fixture)).filter((row) => row.userId === invitee.userId.toHexString())
    ).toHaveLength(0);
    expect(await outboxRows("collab.invite.accepted")).toHaveLength(0);
    // ...and the invitation is still acceptable afterwards, which is what a
    // rollback (not a half state) means.
    expect((await acceptInApp(inAppDecision(invitee.cookie, invitationId, "accept"))).status).toBe(
      200
    );
  });

  it("F2: a reject whose event fails answers 500 and leaves the invitation pending, so the retry completes it", async () => {
    const fixture = await seedEvent("op121-f2-reject-emit");
    const invitee = await signInVerified(makeIdentity("op121-f2-reject-emit-invitee"));
    const invitationId = await invite(fixture, userInvite(invitee.userId.toHexString()));
    await settleInviteDelivery();
    expect((await feedInviteRow(invitee.cookie))?.actionTarget).toEqual({
      kind: "invitation",
      id: invitationId,
      state: "open",
    });

    const stub = failDomainEventWrites();
    let response: Response;
    try {
      response = await rejectInApp(inAppDecision(invitee.cookie, invitationId, "reject"));
    } finally {
      stub.mockRestore();
    }

    // The pinned invariant: a rejection whose event failed is never reported.
    expect(response.status).toBe(500);
    expect((await errorOf(response)).code).toBe("internal_error");
    expect(await outboxRows("collab.invite.rejected")).toHaveLength(0);

    // The transaction: the status write and the closure are rolled back with
    // the emit, so the invitation is still pending and the invitee's actions
    // are still there to use.
    const stored = await storedInvitation(invitationId);
    expect(stored?.status).toBe("pending");
    expect(stored?.resolvedAt ?? null).toBeNull();
    const after = await feedInviteRow(invitee.cookie);
    expect(after?.actionTarget).toEqual({
      kind: "invitation",
      id: invitationId,
      state: "open",
    });
    expect(actionPairs(after)).toEqual([
      ["accept", "available"],
      ["reject", "available"],
    ]);
    expect(
      (await eventMembers(fixture)).filter((row) => row.userId === invitee.userId.toHexString())
    ).toHaveLength(0);

    // ...and the retry with the emit seam healthy performs the reject instead
    // of answering a replay: the decision was never made.
    const retry = await rejectInApp(inAppDecision(invitee.cookie, invitationId, "reject"));
    expect(retry.status).toBe(200);
    expect((await body(retry)).alreadyResolved).toBe(false);
    expect((await storedInvitation(invitationId))?.status).toBe("rejected");
    expect(await outboxRows("collab.invite.rejected")).toHaveLength(1);
    expect(actionPairs(await feedInviteRow(invitee.cookie))).toEqual([
      ["accept", "unavailable"],
      ["reject", "unavailable"],
    ]);
  });

  it("F2: a reject whose affordance write fails answers 500 and leaves the invitation pending and clickable", async () => {
    const fixture = await seedEvent("op121-f2-reject-affordance");
    const invitee = await signInVerified(makeIdentity("op121-f2-reject-affordance-invitee"));
    const invitationId = await invite(fixture, userInvite(invitee.userId.toHexString()));
    await settleInviteDelivery();
    expect(actionPairs(await feedInviteRow(invitee.cookie))).toEqual([
      ["accept", "available"],
      ["reject", "available"],
    ]);

    const stub = failAffordanceClosure();
    let response: Response;
    try {
      response = await rejectInApp(inAppDecision(invitee.cookie, invitationId, "reject"));
    } finally {
      stub.mockRestore();
    }

    expect(response.status).toBe(500);
    expect((await errorOf(response)).code).toBe("internal_error");
    expect(await outboxRows("collab.invite.rejected")).toHaveLength(0);

    // The transaction: the status write is rolled back with the closure that
    // failed, so the row is not terminal and the affordance is consistent with
    // it.
    expect((await storedInvitation(invitationId))?.status).toBe("pending");
    const after = await feedInviteRow(invitee.cookie);
    expect(after?.actionTarget).toEqual({
      kind: "invitation",
      id: invitationId,
      state: "open",
    });
    expect(actionPairs(after)).toEqual([
      ["accept", "available"],
      ["reject", "available"],
    ]);

    // ...and the retry closes the affordance, the row and the event together.
    const retry = await rejectInApp(inAppDecision(invitee.cookie, invitationId, "reject"));
    expect(retry.status).toBe(200);
    expect((await body(retry)).alreadyResolved).toBe(false);
    expect((await storedInvitation(invitationId))?.status).toBe("rejected");
    expect(await outboxRows("collab.invite.rejected")).toHaveLength(1);
    expect(actionPairs(await feedInviteRow(invitee.cookie))).toEqual([
      ["accept", "unavailable"],
      ["reject", "unavailable"],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* F1 — the removal retry-limit branch, pinned deterministically              */
/* -------------------------------------------------------------------------- */

/**
 * The removal route's retry-limit branch, pinned without waiting for the race
 * to spend the loser's budget by chance.
 *
 * A rival `withTransaction` takes the write lock on the member's
 * `event_organizers` row and holds it, so the route's own transaction can never
 * commit: its three immediate attempts (`@/server/db/transaction`) all conflict
 * and the wrapper throws `TransactionRetryLimitError` **while the rival's
 * transaction is still open**. Because the rival's flip is invisible until it
 * commits, the member row still reads `revokedAt: null` at that instant — a
 * single re-read would answer `500`, which is why the route polls.
 *
 * The rival performs the winner's real writes (the row flip, the invitation
 * revoke and both `collab.member.removed` emits) inside its own transaction, so
 * the counts below are the ones a genuinely winning request leaves behind.
 *
 * - **R1** — the rival commits the removal while the loser is waiting: the
 *   loser answers the same settled `204` the winner's effect deserves, and logs
 *   no removal of its own.
 * - **R2** — the rival commits a write that is *not* the removal: nothing was
 *   removed, so the loser's bounded wait runs out and the original error
 *   surfaces as `500 internal_error` instead of a `204` for a removal that
 *   never happened.
 *
 * Determinism: the cases never race the wall clock. They wait for the wrapper's
 * own `db.transaction.retry` lines (one per retry, so two lines mean the third
 * and last attempt was already started) before releasing the rival, so the
 * loser has certainly spent its budget. The 150 ms grace after that covers the
 * last attempt's conflict round-trip (measured: three attempts in ~19 ms), which
 * is what puts the loser in the polling loop rather than inside an attempt.
 */

/** Resolve after `ms`; the suite's only clock use, for the two bounded waits. */
async function pause(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A one-shot gate: `wait` resolves once, when `open` is called. */
interface Latch {
  readonly wait: Promise<void>;
  readonly open: () => void;
}

/**
 * Build a one-shot gate.
 *
 * @returns The gate.
 */
function latch(): Latch {
  const gate: { resolve: () => void } = { resolve: () => undefined };
  const wait = new Promise<void>((resolve) => {
    gate.resolve = resolve;
  });
  return {
    wait,
    open: () => {
      gate.resolve();
    },
  };
}

/** True for the wrapper's `db.transaction.retry` line (one per retry). */
function isRetryLine(entry: MemoryTransport["entries"][number]): boolean {
  return entry.event === "db.transaction.retry";
}

/**
 * Wait until the sink holds `count` `db.transaction.retry` lines.
 *
 * The wrapper logs one line per retry (`attempt > 1`), so two lines mean the
 * third and last attempt of the removal's transaction was already started: the
 * loser really spent the budget instead of winning the row.
 *
 * @param sink - The installed memory sink.
 * @param count - How many retry lines to wait for.
 * @throws Error when they never appear, so a vacuous run fails loudly.
 */
async function waitForTransactionRetries(sink: MemoryTransport, count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  let seen = sink.entries.filter(isRetryLine).length;
  while (seen < count) {
    if (Date.now() > deadline) {
      throw new Error(
        `the removal transaction never retried: ${String(seen)} of ${String(count)} retry lines`
      );
    }
    await pause(10);
    seen = sink.entries.filter(isRetryLine).length;
  }
}

/**
 * The awaited member row's `_id`, which the route's pre-transaction lookup
 * resolves and the rival transaction writes.
 *
 * @param fixture - The event.
 * @param userId - The member's user id.
 * @returns The `event_organizers` row id.
 */
async function memberRowId(fixture: EventFixture, userId: ObjectId): Promise<ObjectId> {
  const row = await app.db
    .collection(COLLECTIONS.eventOrganizers)
    .findOne({ eventId: fixture.eventId, userId: userId.toHexString() });
  if (row === null) {
    throw new Error("the seeded co-organizer row is missing");
  }
  return row._id;
}

/**
 * Run a rival transaction that holds the member row's write lock until the case
 * releases it.
 *
 * @param writes - The rival's writes; the first one takes the row's lock.
 * @param gates - `locked` opens once `writes` has resolved inside the open
 *   transaction, `release` lets it commit.
 */
async function holdRivalTransaction(
  writes: (session: ClientSession) => Promise<void>,
  gates: { readonly locked: Latch; readonly release: Latch }
): Promise<void> {
  await withTransaction(async (session) => {
    await writes(session);
    gates.locked.open();
    await gates.release.wait;
  });
}

/**
 * The winner's three writes, as the route performs them: the `event_organizers`
 * flip, the revoke of the granting invitation and the two outbox emits.
 *
 * @param fixture - The event.
 * @param memberId - The row the route's lookup resolves.
 * @param targetUserId - The removed member.
 * @param session - The rival transaction's session.
 */
async function winnerWrites(
  fixture: EventFixture,
  memberId: ObjectId,
  targetUserId: ObjectId,
  session: ClientSession
): Promise<void> {
  const now = new Date();
  const tenantKey = fixture.workspace.tenantId.toHexString();
  const targetHex = targetUserId.toHexString();

  await app.db
    .collection(COLLECTIONS.eventOrganizers)
    .updateOne(
      { _id: memberId, revokedAt: null },
      { $set: { status: "removed", revokedAt: now, updatedAt: now } },
      { session }
    );
  await tenantRepo(tenantKey, app.db)
    .collection(COLLECTIONS.invitations)
    .updateMany(
      { eventId: fixture.eventId, status: "accepted", "invitee.userId": targetHex },
      { $set: { status: "revoked", revokedAt: now, updatedAt: now } },
      { session }
    );
  for (const eventKey of ["collab.member.removed", "collab.member.removed.ack"] as const) {
    await emitDomainEvent(
      {
        eventKey,
        tenantId: tenantKey,
        actorRef: { kind: "user", id: fixture.workspace.organizer.userId.toHexString() },
        subjectRef: { kind: "user", id: targetHex },
        payload: { eventId: fixture.eventId.toHexString(), userId: targetHex },
      },
      { db: app.db, session }
    );
  }
}

/**
 * A competing write on the same row that is **not** the removal: it takes the
 * lock the loser needs, and leaves `revokedAt` alone.
 *
 * @param memberId - The row the route's lookup resolves.
 * @param session - The rival transaction's session.
 */
async function nonRemovalWrite(memberId: ObjectId, session: ClientSession): Promise<void> {
  await app.db
    .collection(COLLECTIONS.eventOrganizers)
    .updateOne({ _id: memberId }, { $set: { updatedAt: new Date() } }, { session });
}

/** Install a memory sink for one case and hand back its entries. */
function captureLogs(): { readonly sink: MemoryTransport; readonly restore: () => void } {
  const previous = getLogger();
  const sink: MemoryTransport = memoryTransport();
  setLogger(
    createLogger({ level: "info", transports: [sink], service: "openpic-web", env: "test" })
  );
  return {
    sink,
    restore: () => {
      setLogger(previous);
    },
  };
}

describe("DELETE /api/v1/tenants/{tenantId}/events/{eventId}/members/{userId} — the exhausted retry budget (F1)", () => {
  it("R1: answers the settled 204 when the rival's removal commits after the loser's retry budget is spent", async () => {
    const logs = captureLogs();
    try {
      // Arrange — an accepted co-organizer, and the winner's writes held open in
      // a rival transaction on the very row the route will try to flip.
      const invitee = await signInVerified(makeIdentity("op121-r1-settled-invitee"));
      const { fixture, invitationId } = await acceptedMember("op121-r1-settled", invitee);
      const memberId = await memberRowId(fixture, invitee.userId);

      const locked = latch();
      const release = latch();
      const rival = holdRivalTransaction(
        (session) => winnerWrites(fixture, memberId, invitee.userId, session),
        { locked, release }
      );

      // The rival holds the row's write lock from here on, so the route's
      // transaction can only conflict — it cannot win the row.
      await locked.wait;

      // Act — the route's own DELETE, deliberately not awaited.
      const pending = removeMember(
        removeMemberRequest(fixture.workspace.organizer.cookie, fixture, invitee.userId)
      );

      // Wait for the loser to spend all three attempts, give the last one its
      // conflict round-trip, then let the winner commit while the loser polls.
      await waitForTransactionRetries(logs.sink, 2);
      await pause(150);
      release.open();

      const [response] = await Promise.all([pending, rival]);

      // Assert — the loser reports the settled removal the winner performed.
      expect(response.status).toBe(204);
      expect((await response.arrayBuffer()).byteLength).toBe(0);

      // Arrange guard, not a new contract: the loser really spent the whole
      // three-attempt budget (two retry lines) instead of winning the row, so
      // the `204` above can only come from the retry-limit branch.
      expect(logs.sink.entries.filter(isRetryLine)).toHaveLength(2);

      const removed = (await eventMembers(fixture)).find(
        (row) => row.userId === invitee.userId.toHexString()
      );
      expect(removed?.status).toBe("removed");
      expect(removed?.revokedAt).toBeInstanceOf(Date);
      expect((await storedInvitation(invitationId))?.status).toBe("revoked");

      // The winner's two emits, and only those: the loser removed nothing, so
      // a second pair would report a removal that never happened.
      expect(await outboxRows("collab.member.removed")).toHaveLength(1);
      expect(await outboxRows("collab.member.removed.ack")).toHaveLength(1);

      // The loser performed no removal, so it reports none. The route's log call
      // is guarded by its own `removed` flag, and this is the branch where a
      // refactor could wrongly log the winner's removal a second time.
      expect(
        logs.sink.entries.filter((entry) => entry.msg === "event member removed")
      ).toHaveLength(0);
    } finally {
      logs.restore();
    }
  });

  it("R2: answers 500 internal_error when the loser's spent retry budget finds no committed removal", async () => {
    const logs = captureLogs();
    try {
      // Arrange — the same collision, but the rival's write is not a removal:
      // it holds the row's lock and leaves `revokedAt` null forever.
      const invitee = await signInVerified(makeIdentity("op121-r2-unsettled-invitee"));
      const { fixture, invitationId } = await acceptedMember("op121-r2-unsettled", invitee);
      const memberId = await memberRowId(fixture, invitee.userId);

      const locked = latch();
      const release = latch();
      const rival = holdRivalTransaction((session) => nonRemovalWrite(memberId, session), {
        locked,
        release,
      });

      await locked.wait;

      // Act — the route's own DELETE, deliberately not awaited.
      const pending = removeMember(
        removeMemberRequest(fixture.workspace.organizer.cookie, fixture, invitee.userId)
      );

      await waitForTransactionRetries(logs.sink, 2);
      await pause(150);
      release.open();

      const [response] = await Promise.all([pending, rival]);

      // Assert — nothing was removed, so the honest answer is the original
      // failure, not the `204` reserved for a settled removal.
      expect(response.status).toBe(500);
      expect((await errorOf(response)).code).toBe("internal_error");
      expect(logs.sink.entries.filter(isRetryLine)).toHaveLength(2);

      // Neither row moved and nobody was notified: a `204` here would tell the
      // organizer a seat was removed while the member is still admitted.
      const member = (await eventMembers(fixture)).find(
        (row) => row.userId === invitee.userId.toHexString()
      );
      expect(member?.status).toBe("active");
      expect(member?.revokedAt ?? null).toBeNull();
      expect((await storedInvitation(invitationId))?.status).toBe("accepted");
      expect(await outboxRows("collab.member.removed")).toHaveLength(0);
      expect(await outboxRows("collab.member.removed.ack")).toHaveLength(0);
      expect(
        logs.sink.entries.filter((entry) => entry.msg === "event member removed")
      ).toHaveLength(0);
    } finally {
      logs.restore();
    }
  });
});
