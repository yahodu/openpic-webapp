import { randomUUID } from "node:crypto";

import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { findForbiddenFields, maskEmail } from "@openpic/contracts";

import { GET as previewInvitation } from "@/app/api/v1/invitations/[token]/route";
import {
  GET as listInvitations,
  POST as createInvitation,
} from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/invitations/route";
import { DELETE as revokeInvitation } from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/invitations/[invitationId]/route";
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
  type TestApp,
} from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";

/**
 * Integration / contract — creating, listing, previewing and revoking
 * co-organizer invitations (OP-120 I1–I8, contract §2.3, schema §13.6).
 *
 * The user story: *as an organizer I invite co-organizers by user, email or
 * phone so they can help upload, even before they have an account.* An
 * invitation is therefore a durable business fact with a hashed one-time token
 * (§13.6) — not a notification — and the whole of this card is about the
 * invariants around it:
 *
 * - the **raw token never leaves the server** except inside the rendered
 *   email/SMS the invitee receives (§2.3 "The raw token is **never**
 *   returned"): not in the `201`, not in the domain-event outbox, and the stored
 *   row keeps only `tokenHash`;
 * - a **duplicate live invite** is refused (`409 invitation_already_pending`)
 *   rather than silently creating a second redeemable link;
 * - the **seat** is metered by `coorganizers.per_event`, counting active members
 *   **and** pending invitations, so a plan's cap cannot be overshot by mail;
 * - **revocation is idempotent** (`200` twice, §2.3), because a client that
 *   retries must not see an error for a state it already reached;
 * - the **public preview** answers `404` for a token that matches nothing, so the
 *   landing page has one non-oracle failure shape;
 * - the **ladder** is organizer-only for create/revoke (`403` for a
 *   co-organizer), self-invitation is refused (`422 cannot_invite_self`) and an
 *   invitee who is already an active co-organizer is refused (`409
 *   already_member`).
 *
 * ## Contract expected of the implementation
 *
 * - `@/app/api/v1/tenants/[tenantId]/events/[eventId]/invitations/route` exports
 *   `POST` and `GET` declared as
 *   `defineRoute({ route: "/api/v1/tenants/:tenantId/events/:eventId/invitations", … })`
 *   with `userAuth()` + the reusable `tenantStage()`; `POST` carries a
 *   **required** idempotency stage (`400 idempotency_key_required` without a key)
 *   and answers `201` with the §2.3 body:
 *   `{ id, kind, eventId, role, status, inviteeMasked, channelsNotified,
 *   expiresAt, createdAt }` — **exactly** those nine keys.
 * - `@/app/api/v1/tenants/[tenantId]/events/[eventId]/invitations/[invitationId]/route`
 *   exports `DELETE` (organizer) answering `200` with the invitation in its
 *   current state.
 * - `@/app/api/v1/invitations/[token]/route` exports `GET` — **public** (no auth
 *   stage) — answering `404 not_found` for an unknown token and the preview body
 *   for a live one.
 * - New contract codes the GREEN owes (Appendix A.5 append-only shape): the
 *   card's `cannot_invite_self` (`422`) and `already_member` (`409`), plus the
 *   `invitation_already_pending` row Appendix A.5 already documents but the
 *   executable catalogue lacks.
 *
 * ## Assumptions (ADR-0660 §Assumptions)
 *
 * - **A5** — the `201` `kind` is `"event_co_organizer"` and the `role` echoes the
 *   request's `"co_organizer"` (§2.3's own example).
 * - **A6** — `channelsNotified` is a non-empty subset of
 *   `["in_app", "email", "sms"]`; which channels a given invitee earns is a
 *   contact-availability decision (§4.6 sends all three), so only the vocabulary
 *   is pinned.
 * - **A7** — `expiresAt` is a future ISO instant within 60 days (schema §13.6
 *   says "Default 14 days"; the exact default is not pinned because no
 *   `platformSettings` field carries it yet).
 * - **A8** — the preview body carries exactly `status`, `eventName`,
 *   `inviterDisplayName`, `expiresAt`, `inviteeMasked` — §2.3 names those five
 *   facts ("`status`, event name, inviter display name, `expiresAt`, masked
 *   invitee") and the implementation must pick key names, so this ADR picks
 *   them.
 * - **A9** — creating an invitation renders a `collab.invite.sent` message whose
 *   copy carries the token, and the spec settles the delivery by draining the
 *   outbox (`runNotificationFanOut`) as the cron does. Whether the route sends
 *   synchronously or defers to the fan-out is **not** pinned — only that the
 *   rendered copy exists and is addressed to the invitee's contact.
 * - **A10** — the list answers `{ data: Invitation[] }` sorted `createdAt` desc so
 *   the newest invite is first (§2.3).
 * - **A11** — refusal precedence is **self → member → plan limit**: an organizer
 *   inviting their own account gets `422 cannot_invite_self` (not the `409` their
 *   `event_organizers` row would otherwise earn), an existing active
 *   co-organizer gets `409 already_member` (not the `403` the seat count would
 *   otherwise produce), and only a genuinely new invitee consumes the seat. The
 *   card lists the three outcomes without an order; this ADR fixes one so a
 *   correct implementation is not failed for answering the "wrong" true thing.
 */

/** The invitation type key the delivery pins observe (contract §7.6). */
const INVITE_TYPE_KEY = "collab.invite.sent";

/** The nine keys §2.3's `201` body carries — no more, no less. */
const INVITATION_BODY_KEYS = [
  "channelsNotified",
  "createdAt",
  "eventId",
  "expiresAt",
  "id",
  "inviteeMasked",
  "kind",
  "role",
  "status",
];

/** The five keys §2.3's public preview carries (assumption A8). */
const PREVIEW_BODY_KEYS = [
  "eventName",
  "expiresAt",
  "inviteeMasked",
  "inviterDisplayName",
  "status",
];

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op120-invitations" });
  await ensureIndexes(app.db);
  // The notification catalogue is production seed data; seeding it makes the
  // outbox's `notifications: "pending"` gate and the rendered copy real, so a
  // route that defers delivery to the fan-out is exercised on the same path as
  // production (assumption A9).
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

/**
 * Sign in an organizer and give them an active workspace.
 *
 * @param prefix - A unique suite-local prefix (slug and display name).
 * @returns The workspace and its organizer session.
 */
async function seedWorkspace(prefix: string): Promise<Workspace> {
  const organizer = await signInVerified(prefix);
  const tenantId = new ObjectId();
  await app.db.collection(COLLECTIONS.tenants).insertOne({
    _id: tenantId,
    slug: `op120-${prefix}`,
    name: `OP120 ${prefix}`,
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
  return { tenantId, organizer };
}

/**
 * Sign a caller in and stamp the profile a completed account has.
 *
 * @param prefix - A unique suite-local prefix.
 * @returns The signed-in caller.
 */
async function signInVerified(prefix: string): Promise<SignedInUser> {
  const user = await app.signIn(makeIdentity(prefix));
  await app.db.collection(COLLECTIONS.userProfiles).updateOne(
    { userId: user.userId },
    {
      $set: {
        displayName: `Caller ${prefix}`,
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
 * Insert an event row (schema §15.1) owned by `workspace`.
 *
 * @param workspace - The owning workspace.
 * @returns The event's id.
 */
async function seedEvent(workspace: Workspace): Promise<ObjectId> {
  const _id = new ObjectId();
  seededSlugSeq += 1;
  await app.db.collection(COLLECTIONS.events).insertOne({
    _id,
    tenantId: workspace.tenantId.toHexString(),
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
        slug: `op120${String(seededSlugSeq).padStart(4, "0")}`,
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
    createdByUserId: workspace.organizer.userId.toHexString(),
    schemaVersion: 1,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  });
  return _id;
}

/**
 * Insert an `event_organizers` row (schema §15.2).
 *
 * @param workspace - The event's workspace.
 * @param eventId - The event.
 * @param user - The member.
 * @param role - The event role.
 * @param status - The lifecycle status (`removed` rows are kept for audit).
 */
async function addEventMember(
  workspace: Workspace,
  eventId: ObjectId,
  user: SignedInUser,
  role: "organizer" | "co_organizer",
  status: "active" | "removed" = "active"
): Promise<void> {
  await app.db.collection(COLLECTIONS.eventOrganizers).insertOne({
    tenantId: workspace.tenantId.toHexString(),
    eventId,
    userId: user.userId.toHexString(),
    role,
    status,
    revokedAt: status === "removed" ? new Date("2026-09-10T00:00:00.000Z") : null,
    uploadedImageCount: 0,
    createdAt: new Date("2026-09-02T00:00:00.000Z"),
    updatedAt: new Date("2026-09-02T00:00:00.000Z"),
    schemaVersion: 1,
  });
}

/**
 * Seed a plan whose only metered key is `coorganizers.per_event`, and make it
 * the workspace's live plan.
 *
 * @param workspace - The workspace the subscription belongs to.
 * @param limit - The per-event co-organizer cap.
 */
async function seedCoOrganizerPlan(workspace: Workspace, limit: number): Promise<void> {
  const planKey = `op120-coorganizers-${String(limit)}`;
  await app.db.collection(COLLECTIONS.plans).insertOne(
    makePlan({
      key: planKey,
      entitlements: {
        "coorganizers.per_event": makeEntitlement({
          limit,
          resetPeriod: "none",
          scope: "event",
          enforcement: "hard",
        }),
      },
    })
  );
  await app.db.collection(COLLECTIONS.subscriptions).insertOne(
    makeSubscription({
      tenantId: workspace.tenantId.toHexString(),
      subscribedPlanKey: planKey,
      activePlanKey: planKey,
      status: "active",
    })
  );
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

/** A `POST …/invitations` request. */
function createRequest(
  cookie: string,
  workspace: Workspace,
  eventId: ObjectId,
  payload: Record<string, unknown>,
  idempotencyKey = randomUUID()
): Request {
  return new Request(
    new URL(
      `/api/v1/tenants/${workspace.tenantId.toHexString()}/events/${eventId.toHexString()}/invitations`,
      APP_ORIGIN
    ),
    {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify(payload),
    }
  );
}

/** A `GET …/invitations` request. */
function listRequest(cookie: string, workspace: Workspace, eventId: ObjectId, query = ""): Request {
  return new Request(
    new URL(
      `/api/v1/tenants/${workspace.tenantId.toHexString()}/events/${eventId.toHexString()}/invitations${query}`,
      APP_ORIGIN
    ),
    { method: "GET", headers: { cookie } }
  );
}

/** A `DELETE …/invitations/{invitationId}` request. */
function revokeRequest(
  cookie: string,
  workspace: Workspace,
  eventId: ObjectId,
  invitationId: string
): Request {
  return new Request(
    new URL(
      `/api/v1/tenants/${workspace.tenantId.toHexString()}/events/${eventId.toHexString()}/invitations/${invitationId}`,
      APP_ORIGIN
    ),
    { method: "DELETE", headers: { cookie } }
  );
}

/** A **public** `GET /invitations/{token}` request (no session cookie). */
function previewRequest(token: string): Request {
  return new Request(new URL(`/api/v1/invitations/${token}`, APP_ORIGIN), { method: "GET" });
}

/* -------------------------------------------------------------------------- */
/* Scanners                                                                   */
/* -------------------------------------------------------------------------- */

/** Every string value in a JSON tree, at any depth. */
function allStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item: unknown) => allStrings(item));
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap((item: unknown) => allStrings(item));
  }
  return [];
}

/** Every object key in a JSON tree, at any depth. */
function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item: unknown) => allKeys(item));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, child]) => [key, ...allKeys(child)]);
  }
  return [];
}

/** The maximal base64url-shaped runs in a rendered message (a token candidate). */
function tokenRuns(text: string): string[] {
  return text.match(/[A-Za-z0-9_-]{20,}/g) ?? [];
}

/** Read an id as a hex string, whichever representation the row stores. */
function idOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value instanceof ObjectId) return value.toHexString();
  return null;
}

/** Read a stored instant as epoch milliseconds, whatever the driver returned. */
function instantOf(value: unknown): number {
  return value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
}

/** The error envelope of a failed response. */
async function errorCode(response: Response): Promise<string> {
  const parsed = await body(response);
  const error = parsed.error as { code?: string } | undefined;
  return error?.code ?? "";
}

/**
 * Render the invitation messages the way the cron does, so a route that defers
 * delivery to the outbox is observed on the same path as production (A9).
 *
 * A route that sends synchronously has already written its dispatch rows; the
 * drain then finds nothing to claim and this is a no-op.
 */
async function settleInviteDelivery(): Promise<void> {
  await runNotificationFanOut({
    db: app.db,
    transport: getNotificationTransport(),
    recipients: mongoRecipientRepository(app.db),
    claimerId: "spec.op120-invitations",
  });
}

/** Every `collab.invite.sent` dispatch row the run produced. */
async function inviteDispatches(): Promise<Record<string, unknown>[]> {
  return app.db.collection(COLLECTIONS.dispatches).find({ typeKey: INVITE_TYPE_KEY }).toArray();
}

/** The stored invitation row behind a `201` body. */
async function storedInvitation(id: string): Promise<Record<string, unknown> | null> {
  return app.db.collection(COLLECTIONS.invitations).findOne({ _id: new ObjectId(id) });
}

/* -------------------------------------------------------------------------- */
/* I1 — the happy path and the "no raw token" scanners                        */
/* -------------------------------------------------------------------------- */

describe("POST /api/v1/tenants/{tenantId}/events/{eventId}/invitations", () => {
  it("I1: answers 201 with the §2.3 body and never a token field", async () => {
    const workspace = await seedWorkspace("op120-i1");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");

    const response = await createInvitation(
      createRequest(workspace.organizer.cookie, workspace, eventId, emailInvite("buck@example.com"))
    );

    expect(response.status).toBe(201);
    const payload = await body(response);
    expect(Object.keys(payload).sort()).toEqual(INVITATION_BODY_KEYS);
    expect(findForbiddenFields(payload, "default")).toEqual([]);
    expect(payload.id).toMatch(/^[0-9a-f]{24}$/);
    expect(payload.kind).toBe("event_co_organizer");
    expect(payload.role).toBe("co_organizer");
    expect(payload.status).toBe("pending");
    expect(payload.eventId).toBe(eventId.toHexString());
    expect(payload.inviteeMasked).toBe(maskEmail("buck@example.com"));
    expect(payload.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(payload.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const channels = payload.channelsNotified as string[];
    expect(channels.length).toBeGreaterThan(0);
    // A6: the channel vocabulary of the notification matrix.
    expect(channels.filter((channel) => !["in_app", "email", "sms"].includes(channel))).toEqual([]);
  });

  it("I1: never carries a key named like a token", async () => {
    const workspace = await seedWorkspace("op120-i1-keys");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");

    const response = await createInvitation(
      createRequest(workspace.organizer.cookie, workspace, eventId, emailInvite("buck@example.com"))
    );

    expect(response.status).toBe(201);
    const keys = allKeys(await body(response));
    expect(keys).not.toContain("token");
    expect(keys).not.toContain("tokenHash");
    expect(keys).not.toContain("rawToken");
    expect(keys).not.toContain("inviteLink");
  });

  it("I1: never returns any value whose sha256 is the stored tokenHash", async () => {
    const workspace = await seedWorkspace("op120-i1-scan");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");

    const response = await createInvitation(
      createRequest(workspace.organizer.cookie, workspace, eventId, emailInvite("buck@example.com"))
    );

    expect(response.status).toBe(201);
    const payload = await body(response);
    const stored = await storedInvitation(payload.id as string);
    expect(stored?.tokenHash).toMatch(/^[a-f0-9]{64}$/);

    // The strongest form of "the raw token is never returned": no value in the
    // response hashes to the token the row stores.
    const hashes = allStrings(payload).map((text) => sha256Hex(text));
    expect(hashes).not.toContain(stored?.tokenHash);
  });

  it("I1: stores only the hash, the normalized invitee and a pending status", async () => {
    const workspace = await seedWorkspace("op120-i1-row");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");
    const before = Date.now();

    const response = await createInvitation(
      createRequest(
        workspace.organizer.cookie,
        workspace,
        eventId,
        emailInvite("  Buck@Example.COM ")
      )
    );

    expect(response.status).toBe(201);
    const payload = await body(response);
    const stored = await storedInvitation(payload.id as string);

    expect(stored).not.toBeNull();
    expect(stored?.kind).toBe("event_co_organizer");
    expect(stored?.status).toBe("pending");
    expect(stored?.role).toBe("co_organizer");
    expect(idOf(stored?.tenantId)).toBe(workspace.tenantId.toHexString());
    expect(idOf(stored?.eventId)).toBe(eventId.toHexString());
    expect(idOf(stored?.invitedByUserId)).toBe(workspace.organizer.userId.toHexString());
    // U1 at the wire: the stored invitee is the canonical form the lazy-invite
    // hook matches on.
    expect(stored?.invitee).toEqual({ kind: "email", email: "buck@example.com" });

    const expiresAtMs = instantOf(stored?.expiresAt);
    expect(expiresAtMs).toBeGreaterThan(before);
    expect(expiresAtMs).toBeLessThan(before + 60 * 86_400_000);
    expect(payload.expiresAt).toBe(new Date(expiresAtMs).toISOString());
  });

  it("I1: renders the link in the invitee's message, and its token hashes to the stored hash", async () => {
    const workspace = await seedWorkspace("op120-i1-dispatch");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");
    const inviteeEmail = "buck@example.com";

    const response = await createInvitation(
      createRequest(workspace.organizer.cookie, workspace, eventId, emailInvite(inviteeEmail))
    );
    expect(response.status).toBe(201);
    const payload = await body(response);
    const stored = await storedInvitation(payload.id as string);

    await settleInviteDelivery();

    const rows = await inviteDispatches();
    const renderedText = rows.flatMap((row) =>
      [row.subject, row.body].filter((value): value is string => typeof value === "string")
    );
    const hashes = renderedText.flatMap(tokenRuns).map((run) => sha256Hex(run));

    expect(hashes).toContain(stored?.tokenHash);
  });

  it("I1: addresses the rendered message to the invitee's own contact", async () => {
    const workspace = await seedWorkspace("op120-i1-contact");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");
    const inviteeEmail = "buck@example.com";

    const response = await createInvitation(
      createRequest(workspace.organizer.cookie, workspace, eventId, emailInvite(inviteeEmail))
    );
    expect(response.status).toBe(201);

    await settleInviteDelivery();

    const rows = await inviteDispatches();
    expect(rows.map((row) => row.contactHash)).toContain(sha256Hex(inviteeEmail));
  });

  it("I1: keeps the raw token out of the domain-event outbox", async () => {
    const workspace = await seedWorkspace("op120-i1-outbox");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");

    const response = await createInvitation(
      createRequest(workspace.organizer.cookie, workspace, eventId, emailInvite("buck@example.com"))
    );
    expect(response.status).toBe(201);
    const payload = await body(response);
    const stored = await storedInvitation(payload.id as string);

    const events = await app.db.collection(COLLECTIONS.domainEvents).find({}).toArray();
    const hashes = events
      .flatMap((row) => allStrings(row.payload ?? {}))
      .map((value) => sha256Hex(value));

    expect(hashes).not.toContain(stored?.tokenHash);
  });

  it("I2: refuses a duplicate live invite with 409 and keeps one redeemable row", async () => {
    const workspace = await seedWorkspace("op120-i2");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");
    const payload = emailInvite("buck@example.com");

    const first = await createInvitation(
      createRequest(workspace.organizer.cookie, workspace, eventId, payload)
    );
    expect(first.status).toBe(201);

    const second = await createInvitation(
      createRequest(workspace.organizer.cookie, workspace, eventId, payload)
    );

    expect(second.status).toBe(409);
    expect(await errorCode(second)).toBe("invitation_already_pending");
    const stored = await app.db
      .collection(COLLECTIONS.invitations)
      .find({ "invitee.email": "buck@example.com" })
      .toArray();
    expect(stored).toHaveLength(1);
  });

  it("I2: a revoked invite frees the slot, so the same invitee can be invited again", async () => {
    const workspace = await seedWorkspace("op120-i2-reinvite");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");
    const payload = emailInvite("buck@example.com");

    const first = await createInvitation(
      createRequest(workspace.organizer.cookie, workspace, eventId, payload)
    );
    expect(first.status).toBe(201);
    const firstBody = await body(first);

    const revoked = await revokeInvitation(
      revokeRequest(workspace.organizer.cookie, workspace, eventId, firstBody.id as string)
    );
    expect(revoked.status).toBe(200);

    const second = await createInvitation(
      createRequest(workspace.organizer.cookie, workspace, eventId, payload)
    );
    expect(second.status).toBe(201);
  });

  it("I3: refuses an invite over coorganizers.per_event with 403 plan_limit_exceeded", async () => {
    const workspace = await seedWorkspace("op120-i3");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");
    const coOrganizer = await signInVerified("op120-i3-co");
    await addEventMember(workspace, eventId, coOrganizer, "co_organizer");
    // One organizer + one co-organizer already fills a cap of 1.
    await seedCoOrganizerPlan(workspace, 1);

    const response = await createInvitation(
      createRequest(workspace.organizer.cookie, workspace, eventId, emailInvite("buck@example.com"))
    );

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("plan_limit_exceeded");
    const parsed = await body(response);
    const error = parsed.error as { details?: { entitlementKey?: string } };
    expect(error.details?.entitlementKey).toBe("coorganizers.per_event");
  });

  it("I3: a pending invite already owns the seat, so the next invite is 403", async () => {
    const workspace = await seedWorkspace("op120-i3-pending");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");
    // A cap of 2: the organizer fills one seat, the pending invite the second.
    await seedCoOrganizerPlan(workspace, 2);

    const first = await createInvitation(
      createRequest(workspace.organizer.cookie, workspace, eventId, emailInvite("buck@example.com"))
    );
    expect(first.status).toBe(201);

    const second = await createInvitation(
      createRequest(
        workspace.organizer.cookie,
        workspace,
        eventId,
        emailInvite("priya@example.com")
      )
    );

    expect(second.status).toBe(403);
    expect(await errorCode(second)).toBe("plan_limit_exceeded");
  });

  it("I6: refuses a co-organizer who tries to create an invite", async () => {
    const workspace = await seedWorkspace("op120-i6");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");
    const coOrganizer = await signInVerified("op120-i6-co");
    await addEventMember(workspace, eventId, coOrganizer, "co_organizer");
    // The co-organizer is a workspace member too, so the tenant stage admits
    // them and the refusal is the event role, not a non-oracle 404.
    await app.db.collection(COLLECTIONS.tenantMembers).insertOne({
      tenantId: workspace.tenantId,
      userId: coOrganizer.userId,
      role: "member",
      status: "active",
      joinedAt: new Date("2026-01-04T00:00:00.000Z"),
    });

    const response = await createInvitation(
      createRequest(coOrganizer.cookie, workspace, eventId, emailInvite("buck@example.com"))
    );

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("forbidden");
  });

  it("I7: refuses an organizer inviting their own user id", async () => {
    const workspace = await seedWorkspace("op120-i7");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");

    const response = await createInvitation(
      createRequest(
        workspace.organizer.cookie,
        workspace,
        eventId,
        userInvite(workspace.organizer.userId.toHexString())
      )
    );

    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("cannot_invite_self");
  });

  it("I7: refuses an organizer inviting their own email", async () => {
    const workspace = await seedWorkspace("op120-i7-email");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");

    const response = await createInvitation(
      createRequest(
        workspace.organizer.cookie,
        workspace,
        eventId,
        emailInvite(workspace.organizer.identity.email.toUpperCase())
      )
    );

    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("cannot_invite_self");
  });

  it("I8: refuses an invitee who is already an active co-organizer", async () => {
    const workspace = await seedWorkspace("op120-i8");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");
    const coOrganizer = await signInVerified("op120-i8-co");
    await addEventMember(workspace, eventId, coOrganizer, "co_organizer");

    const response = await createInvitation(
      createRequest(
        workspace.organizer.cookie,
        workspace,
        eventId,
        userInvite(coOrganizer.userId.toHexString())
      )
    );

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("already_member");
    const stored = await app.db.collection(COLLECTIONS.invitations).find({}).toArray();
    expect(stored).toHaveLength(0);
  });

  it("answers 401 without a session", async () => {
    const workspace = await seedWorkspace("op120-401");
    const eventId = await seedEvent(workspace);

    const response = await createInvitation(
      new Request(
        new URL(
          `/api/v1/tenants/${workspace.tenantId.toHexString()}/events/${eventId.toHexString()}/invitations`,
          APP_ORIGIN
        ),
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
          body: JSON.stringify(emailInvite("buck@example.com")),
        }
      )
    );

    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("authentication_required");
  });

  it("answers the uniform 404 for a caller who is not in the workspace", async () => {
    const workspace = await seedWorkspace("op120-404");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");
    const outsider = await signInVerified("op120-outsider");

    const response = await createInvitation(
      createRequest(outsider.cookie, workspace, eventId, emailInvite("buck@example.com"))
    );

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("not_found");
  });
});

/* -------------------------------------------------------------------------- */
/* I9 — the list                                                              */
/* -------------------------------------------------------------------------- */

describe("GET /api/v1/tenants/{tenantId}/events/{eventId}/invitations", () => {
  it("I9: a co-organizer may read the list, newest first", async () => {
    const workspace = await seedWorkspace("op120-list");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");
    const coOrganizer = await signInVerified("op120-list-co");
    await addEventMember(workspace, eventId, coOrganizer, "co_organizer");

    const first = await createInvitation(
      createRequest(workspace.organizer.cookie, workspace, eventId, emailInvite("buck@example.com"))
    );
    expect(first.status).toBe(201);
    const firstId = (await body(first)).id as string;
    const second = await createInvitation(
      createRequest(
        workspace.organizer.cookie,
        workspace,
        eventId,
        emailInvite("priya@example.com")
      )
    );
    expect(second.status).toBe(201);
    const secondId = (await body(second)).id as string;

    // Pin the ordering deterministically: two rows created in the same
    // millisecond would otherwise rely on Mongo's unspecified tie-break.
    await app.db
      .collection(COLLECTIONS.invitations)
      .updateOne(
        { _id: new ObjectId(firstId) },
        { $set: { createdAt: new Date("2026-11-01T00:00:00.000Z") } }
      );
    await app.db
      .collection(COLLECTIONS.invitations)
      .updateOne(
        { _id: new ObjectId(secondId) },
        { $set: { createdAt: new Date("2026-11-02T00:00:00.000Z") } }
      );

    const response = await listInvitations(listRequest(coOrganizer.cookie, workspace, eventId));

    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(findForbiddenFields(payload, "default")).toEqual([]);
    const data = payload.data as { id: string; status: string }[];
    expect(data.map((row) => row.status)).toEqual(["pending", "pending"]);
    // §2.3: sorted `createdAt` desc, so the newest invite is first.
    expect(data.map((row) => row.id)).toEqual([secondId, firstId]);
    expect(allKeys(payload)).not.toContain("token");
    expect(allKeys(payload)).not.toContain("tokenHash");
  });

  it("I9: ?status=pending hides a revoked invite", async () => {
    const workspace = await seedWorkspace("op120-list-filter");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");

    const kept = await createInvitation(
      createRequest(workspace.organizer.cookie, workspace, eventId, emailInvite("buck@example.com"))
    );
    const revoked = await createInvitation(
      createRequest(
        workspace.organizer.cookie,
        workspace,
        eventId,
        emailInvite("priya@example.com")
      )
    );
    expect(kept.status).toBe(201);
    expect(revoked.status).toBe(201);
    const revokedBody = await body(revoked);
    expect(
      (
        await revokeInvitation(
          revokeRequest(workspace.organizer.cookie, workspace, eventId, revokedBody.id as string)
        )
      ).status
    ).toBe(200);

    const response = await listInvitations(
      listRequest(workspace.organizer.cookie, workspace, eventId, "?status=pending")
    );

    expect(response.status).toBe(200);
    const data = (await body(response)).data as { id: string; status: string }[];
    expect(data).toHaveLength(1);
    expect(data[0]?.id).toBe((await body(kept)).id);
  });

  it("I9: answers 401 without a session", async () => {
    const workspace = await seedWorkspace("op120-list-401");
    const eventId = await seedEvent(workspace);

    const response = await listInvitations(
      new Request(
        new URL(
          `/api/v1/tenants/${workspace.tenantId.toHexString()}/events/${eventId.toHexString()}/invitations`,
          APP_ORIGIN
        ),
        { method: "GET" }
      )
    );

    expect(response.status).toBe(401);
  });
});

/* -------------------------------------------------------------------------- */
/* I4 — revoke is idempotent                                                  */
/* -------------------------------------------------------------------------- */

describe("DELETE /api/v1/tenants/{tenantId}/events/{eventId}/invitations/{invitationId}", () => {
  it("I4: revoking twice answers 200 both times and keeps the first revokedAt", async () => {
    const workspace = await seedWorkspace("op120-i4");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");

    const created = await createInvitation(
      createRequest(workspace.organizer.cookie, workspace, eventId, emailInvite("buck@example.com"))
    );
    expect(created.status).toBe(201);
    const invitationId = (await body(created)).id as string;

    const first = await revokeInvitation(
      revokeRequest(workspace.organizer.cookie, workspace, eventId, invitationId)
    );
    expect(first.status).toBe(200);
    const firstBody = await body(first);
    expect(firstBody.status).toBe("revoked");
    const afterFirst = await storedInvitation(invitationId);
    const firstRevokedAt = instantOf(afterFirst?.revokedAt);

    const second = await revokeInvitation(
      revokeRequest(workspace.organizer.cookie, workspace, eventId, invitationId)
    );

    expect(second.status).toBe(200);
    const secondBody = await body(second);
    expect(secondBody.status).toBe("revoked");
    expect(secondBody.id).toBe(invitationId);

    // Idempotent means the state does not move: the second call must not
    // re-stamp the revocation instant, nor write a second row.
    const afterSecond = await storedInvitation(invitationId);
    expect(instantOf(afterSecond?.revokedAt)).toBe(firstRevokedAt);
    expect(firstRevokedAt).toBeGreaterThan(0);
    expect(idOf(afterSecond?.revokedByUserId)).toBe(workspace.organizer.userId.toHexString());

    const stored = await app.db.collection(COLLECTIONS.invitations).find({}).toArray();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe("revoked");
  });

  it("I4: a co-organizer may not revoke (403)", async () => {
    const workspace = await seedWorkspace("op120-i4-forbidden");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");
    const coOrganizer = await signInVerified("op120-i4-co");
    await addEventMember(workspace, eventId, coOrganizer, "co_organizer");
    await app.db.collection(COLLECTIONS.tenantMembers).insertOne({
      tenantId: workspace.tenantId,
      userId: coOrganizer.userId,
      role: "member",
      status: "active",
      joinedAt: new Date("2026-01-04T00:00:00.000Z"),
    });

    const created = await createInvitation(
      createRequest(workspace.organizer.cookie, workspace, eventId, emailInvite("buck@example.com"))
    );
    expect(created.status).toBe(201);
    const invitationId = (await body(created)).id as string;

    const response = await revokeInvitation(
      revokeRequest(coOrganizer.cookie, workspace, eventId, invitationId)
    );

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("forbidden");
    const stored = await storedInvitation(invitationId);
    expect(stored?.status).toBe("pending");
  });
});

/* -------------------------------------------------------------------------- */
/* I5 + the preview                                                           */
/* -------------------------------------------------------------------------- */

describe("GET /api/v1/invitations/{token}", () => {
  it("I5: answers 404 not_found for a token that matches nothing", async () => {
    const response = await previewInvitation(previewRequest("not-a-real-invitation-token"));

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("not_found");
  });

  it("I5: answers 404 for a well-shaped token that was never issued", async () => {
    const response = await previewInvitation(previewRequest("x".repeat(43)));

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("not_found");
  });

  it("previews a live invitation publicly, with the masked invitee and no internals", async () => {
    const workspace = await seedWorkspace("op120-preview");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");
    const inviteeEmail = "buck@example.com";

    const created = await createInvitation(
      createRequest(workspace.organizer.cookie, workspace, eventId, emailInvite(inviteeEmail))
    );
    expect(created.status).toBe(201);
    const invitationId = (await body(created)).id as string;

    await settleInviteDelivery();
    const rows = await inviteDispatches();
    const renderedText = rows
      .flatMap((row) =>
        [row.subject, row.body].filter((value): value is string => typeof value === "string")
      )
      .join("\n");
    const stored = await storedInvitation(invitationId);
    const token = tokenRuns(renderedText).find((run) => sha256Hex(run) === stored?.tokenHash);
    expect(token).toBeDefined();

    const response = await previewInvitation(previewRequest(token ?? ""));

    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(Object.keys(payload).sort()).toEqual(PREVIEW_BODY_KEYS);
    expect(payload.status).toBe("pending");
    expect(payload.inviteeMasked).toBe(maskEmail(inviteeEmail));
    expect(payload.eventName).toBe("Rahul & Priya's Wedding");
    expect(findForbiddenFields(payload, "default")).toEqual([]);
    // §2.3: the preview never returns the token, user ids or tenant internals.
    expect(JSON.stringify(payload)).not.toContain(inviteeEmail);
    expect(JSON.stringify(payload)).not.toContain(token ?? "");
    expect(JSON.stringify(payload)).not.toContain(invitationId);
    expect(JSON.stringify(payload)).not.toContain(workspace.tenantId.toHexString());
  });
});
