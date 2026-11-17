import { randomUUID } from "node:crypto";

import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { findForbiddenFields, maskEmail, maskPhone } from "@openpic/contracts";

import { GET as previewInvitation } from "@/app/api/v1/invitations/[token]/route";
import {
  GET as listInvitations,
  POST as createInvitation,
} from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/invitations/route";
import { DELETE as revokeInvitation } from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/invitations/[invitationId]/route";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import {
  createLogger,
  getLogger,
  memoryTransport,
  setLogger,
  type Logger,
  type MemoryTransport,
} from "@/server/logging";
import { runNotificationFanOut } from "@/server/notifications/fan-out";
import type { MessageTransport } from "@/server/notifications/message-transport";
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
    // One body read (the Response body is one-shot): derive both the code and
    // the details from the same parse (OP-115 D2 — `errorCodeOf` + `body` on
    // the same response threw `Body has already been read`).
    const parsed = (await body(response)) as {
      error: { code: string; details?: { entitlementKey?: string } };
    };
    expect(parsed.error.code).toBe("plan_limit_exceeded");
    expect(parsed.error.details?.entitlementKey).toBe("coorganizers.per_event");
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

  it("refuses a create with no Idempotency-Key, so a retry cannot double-mail", async () => {
    const workspace = await seedWorkspace("op120-idem");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");

    // The create is a required-idempotency route (§2.3): a client that cannot
    // name its attempt must be refused rather than mailed twice on a retry.
    const response = await createInvitation(
      new Request(
        new URL(
          `/api/v1/tenants/${workspace.tenantId.toHexString()}/events/${eventId.toHexString()}/invitations`,
          APP_ORIGIN
        ),
        {
          method: "POST",
          headers: { cookie: workspace.organizer.cookie, "content-type": "application/json" },
          body: JSON.stringify(emailInvite("buck@example.com")),
        }
      )
    );

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("idempotency_key_required");
    const stored = await app.db.collection(COLLECTIONS.invitations).find({}).toArray();
    expect(stored).toHaveLength(0);
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

/* -------------------------------------------------------------------------- */
/* Round-1 gap pins (ADR-0662)                                                */
/*                                                                            */
/* Five behaviours the first RED left unpinned, each of which lets a plausible */
/* wrong GREEN pass (OP-120 review round 1, card `t_b91b009e`):               */
/*                                                                            */
/* - **F2** — nothing observed the *logger*. The four existing scanners watch  */
/*   the response keys, the response value preimages, the `domainEvents`       */
/*   payload values and the rendered dispatch copy, so a route that wrote the  */
/*   raw token (or its link, or the raw invitee address) into a log line would */
/*   have passed every one of them.                                           */
/* - **F3** — the story is "by user, email **or phone**", but no case ever sent */
/*   a `phone` invitee, so a normalizer/projection/delivery path that only     */
/*   handled `email` and `user` passed.                                       */
/* - **F4** — every list case had exactly one event, so a list filtered by     */
/*   tenant alone passed.                                                     */
/* - **F5** — only the *sequential* duplicate was pinned; the §13.6 unique     */
/*   partial index is the mechanism that makes the refusal race-safe.         */
/* - **F6** — the preview promised `status`, but a lookup filtered on          */
/*   `status: "pending"` answers `404` and passed every case.                  */
/* -------------------------------------------------------------------------- */

/**
 * Install a `debug`-floored memory logger as the process logger, so every
 * record the invitation surface emits lands in one sink (the OP-113
 * `media-signed-url-never-logged` precedent).
 *
 * @returns The memory sink every entry the port emits lands in.
 */
function captureLogs(): MemoryTransport {
  const sink = memoryTransport();
  setLogger(
    createLogger({
      level: "debug",
      transports: [sink],
      service: "openpic-web",
      env: "test",
      version: "test-sha",
    })
  );
  return sink;
}

/**
 * Recover the raw token behind a stored `tokenHash`.
 *
 * The token exists only inside the rendered invitee message, so the spec reads
 * it from the dispatch ledger exactly as the invitee would — never from the
 * response and never from the row.
 *
 * @param tokenHash - The hash the invitation row stores.
 * @returns The raw token whose sha256 is `tokenHash`.
 * @throws When the rendered copy carries no such token (the delivery pin, not
 *   this one, owns that failure — this message names the cause instead).
 */
async function tokenForHash(tokenHash: unknown): Promise<string> {
  await settleInviteDelivery();
  const rows = await inviteDispatches();
  const runs = rows
    .flatMap((row) =>
      [row.subject, row.body].filter((value): value is string => typeof value === "string")
    )
    .flatMap(tokenRuns);
  const raw = runs.find((run) => sha256Hex(run) === tokenHash);
  if (raw === undefined) {
    throw new Error(
      "the rendered invitation message carried no token hashing to the stored tokenHash"
    );
  }
  return raw;
}

/** The E.164 number the phone-kind pins invite (schema §13.6 `phoneE164`). */
const PHONE_E164 = "+919876543210";

/** Everything a captured record says, flattened, so no field can hide a leak. */
function recordTexts(sink: MemoryTransport): string[] {
  return sink.entries.map((entry) => JSON.stringify(entry));
}

/* -------------------------------------------------------------------------- */
/* F2 — no record carries the token, its link or the raw invitee contact      */
/* -------------------------------------------------------------------------- */

describe("F2 — the invitation surface never logs a token-bearing value", () => {
  let previousLogger: Logger;

  beforeAll(() => {
    previousLogger = getLogger();
  });

  afterAll(() => {
    setLogger(previousLogger);
  });

  it("F2: a create emits its audit line and no record carrying the token, its link or the email", async () => {
    // Arrange — a live capture, floored at debug so a debug leak cannot hide.
    const sink = captureLogs();
    const workspace = await seedWorkspace("op120-f2-create");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");
    const inviteeEmail = "buck@example.com";

    // Act
    const response = await createInvitation(
      createRequest(workspace.organizer.cookie, workspace, eventId, emailInvite(inviteeEmail))
    );

    // Assert — the invitation really was created and its token really exists …
    expect(response.status).toBe(201);
    const payload = await body(response);
    const stored = await storedInvitation(payload.id as string);
    const token = await tokenForHash(stored?.tokenHash);

    // … the capture is live for this route (its own audit line reached the
    // sink, so the negative assertions below are not vacuous) …
    expect(sink.entries.map((entry) => entry.event)).toContain("collab.invite.created");

    // … and no record, at any level and under any field, carries the token,
    // the link the invitee receives, the token's hash or the raw address.
    const records = recordTexts(sink);
    expect(records.filter((record) => record.includes(token))).toEqual([]);
    expect(records.filter((record) => record.includes(`/invitations/${token}`))).toEqual([]);
    expect(records.filter((record) => record.includes(sha256Hex(token)))).toEqual([]);
    expect(records.filter((record) => record.includes(inviteeEmail))).toEqual([]);
  });

  it("F2: a preview emits no record carrying the token or its link", async () => {
    // Arrange
    const sink = captureLogs();
    const workspace = await seedWorkspace("op120-f2-preview");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");
    const inviteeEmail = "buck@example.com";

    const created = await createInvitation(
      createRequest(workspace.organizer.cookie, workspace, eventId, emailInvite(inviteeEmail))
    );
    expect(created.status).toBe(201);
    const stored = await storedInvitation((await body(created)).id as string);
    const token = await tokenForHash(stored?.tokenHash);

    // A rejected lookup proves the capture is live for this pipeline (the
    // 404 path is the one shape that logs), so the live-preview assertions
    // below cannot pass because nothing was observed.
    const missing = await previewInvitation(previewRequest("x".repeat(43)));
    expect(missing.status).toBe(404);
    expect(sink.entries.map((entry) => entry.event)).toContain("http.request.rejected");

    // Act — the live preview, the request whose path carries the raw token.
    const response = await previewInvitation(previewRequest(token));

    // Assert
    expect(response.status).toBe(200);
    const records = recordTexts(sink);
    expect(records.filter((record) => record.includes(token))).toEqual([]);
    expect(records.filter((record) => record.includes(`/invitations/${token}`))).toEqual([]);
    expect(records.filter((record) => record.includes(sha256Hex(token)))).toEqual([]);
    expect(records.filter((record) => record.includes(inviteeEmail))).toEqual([]);
  });

  it("F2: a failed delivery records the failure without the token, its link or the address", async () => {
    // Arrange — a live capture, and one channel whose transport rejects: the
    // in-memory outbox never fails, so this is the only case that drives
    // `deliverInvite`'s catch, the branch that logs `collab.invite.delivery_failed`.
    const sink = captureLogs();
    const workspace = await seedWorkspace("op120-f2-delivery-failed");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");
    const inviteeEmail = "buck@example.com";
    const failingTransport: MessageTransport = {
      send: () => Promise.reject(new Error("smtp unavailable")),
    };
    const transportModule = await import("@/server/services/notification-transport");
    const transport = vi
      .spyOn(transportModule, "getNotificationTransport")
      .mockReturnValue(failingTransport);

    // Act — one create whose single email leg fails; the spy is restored as soon
    // as the request settles, so the harness below still sees the real outbox.
    const response = await createInvitation(
      createRequest(workspace.organizer.cookie, workspace, eventId, emailInvite(inviteeEmail))
    ).finally(() => {
      transport.mockRestore();
    });

    // Assert — a delivery failure never fails the create …
    expect(response.status).toBe(201);
    const stored = await storedInvitation((await body(response)).id as string);
    const token = await tokenForHash(stored?.tokenHash);

    // … the operator-visible failure record really reached the sink, so the
    // negatives below cannot pass because nothing was observed …
    expect(sink.entries.map((entry) => entry.event)).toContain("collab.invite.delivery_failed");

    // … and no record, at any level and under any field, carries the token, the
    // link the invitee receives, the token's hash or the raw invitee address.
    const records = recordTexts(sink);
    expect(records.filter((record) => record.includes(token))).toEqual([]);
    expect(records.filter((record) => record.includes(`/invitations/${token}`))).toEqual([]);
    expect(records.filter((record) => record.includes(sha256Hex(token)))).toEqual([]);
    expect(records.filter((record) => record.includes(inviteeEmail))).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* F3 — the phone invitee path                                                */
/* -------------------------------------------------------------------------- */

describe("F3 — a phone invitee", () => {
  it("F3: creates a phone invitation with the nine-key body and a masked number", async () => {
    // Arrange
    const workspace = await seedWorkspace("op120-f3");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");

    // Act — the third invitee kind the user story names, sent exactly as §13.6
    // stores it.
    const response = await createInvitation(
      createRequest(workspace.organizer.cookie, workspace, eventId, {
        invitee: { kind: "phone", phoneE164: PHONE_E164 },
        role: "co_organizer",
      })
    );

    // Assert
    expect(response.status).toBe(201);
    const payload = await body(response);
    expect(Object.keys(payload).sort()).toEqual(INVITATION_BODY_KEYS);
    expect(payload.kind).toBe("event_co_organizer");
    expect(payload.status).toBe("pending");
    expect(payload.eventId).toBe(eventId.toHexString());
    // §0.13: the number is masked, never echoed.
    expect(payload.inviteeMasked).toBe(maskPhone(PHONE_E164));
    expect(String(payload.inviteeMasked)).not.toContain("9876");
    expect(JSON.stringify(payload)).not.toContain(PHONE_E164);

    const stored = await storedInvitation(payload.id as string);
    expect(stored?.invitee).toEqual({ kind: "phone", phoneE164: PHONE_E164 });
    expect(stored?.status).toBe("pending");
    expect(stored?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    // A phone invitee is reachable over SMS (§4.6), so the recorded channel
    // must be SMS-capable.
    const channels = payload.channelsNotified as string[];
    expect(channels).toContain("sms");
    expect(stored?.channelsNotified).toEqual(channels);
  });

  it("F3: delivers the phone invitation over SMS to the invitee's own number", async () => {
    // Arrange
    const workspace = await seedWorkspace("op120-f3-sms");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");

    // Act
    const response = await createInvitation(
      createRequest(workspace.organizer.cookie, workspace, eventId, {
        invitee: { kind: "phone", phoneE164: PHONE_E164 },
        role: "co_organizer",
      })
    );

    // Assert — the SMS leg addressed the invitee's number, and the rendered
    // copy carried a token hashing to the stored one (so the channel is a real
    // delivery, not a label).
    expect(response.status).toBe(201);
    const stored = await storedInvitation((await body(response)).id as string);
    await settleInviteDelivery();
    const rows = await inviteDispatches();
    expect(rows.map((row) => row.channel)).toContain("sms");
    expect(rows.map((row) => row.contactHash)).toContain(sha256Hex(PHONE_E164));
    const rendered = rows
      .flatMap((row) =>
        [row.subject, row.body].filter((value): value is string => typeof value === "string")
      )
      .flatMap(tokenRuns);
    expect(rendered.map((run) => sha256Hex(run))).toContain(stored?.tokenHash);
  });
});

/* -------------------------------------------------------------------------- */
/* F4 — the list is event-scoped                                             */
/* -------------------------------------------------------------------------- */

describe("F4 — GET …/invitations is scoped to the event in the path", () => {
  it("F4: returns only the event's own rows when a sibling event has one too", async () => {
    // Arrange — two events in ONE tenant, an invitation in each, and one
    // organizer who is a member of both: a list filtered by tenant alone would
    // answer both rows.
    const workspace = await seedWorkspace("op120-f4");
    const eventA = await seedEvent(workspace);
    const eventB = await seedEvent(workspace);
    await addEventMember(workspace, eventA, workspace.organizer, "organizer");
    await addEventMember(workspace, eventB, workspace.organizer, "organizer");

    const createdA = await createInvitation(
      createRequest(workspace.organizer.cookie, workspace, eventA, emailInvite("buck@example.com"))
    );
    const createdB = await createInvitation(
      createRequest(workspace.organizer.cookie, workspace, eventB, emailInvite("priya@example.com"))
    );
    expect(createdA.status).toBe(201);
    expect(createdB.status).toBe(201);
    const idA = (await body(createdA)).id as string;
    const idB = (await body(createdB)).id as string;

    // Act
    const listA = await listInvitations(listRequest(workspace.organizer.cookie, workspace, eventA));

    // Assert
    expect(listA.status).toBe(200);
    const dataA = (await body(listA)).data as { id: string; eventId: string }[];
    expect(dataA.map((row) => row.id)).toEqual([idA]);
    expect(dataA.map((row) => row.eventId)).toEqual([eventA.toHexString()]);

    // The converse, so a route that answered whichever event it liked first
    // cannot pass: event B's list is event B's row.
    const listB = await listInvitations(listRequest(workspace.organizer.cookie, workspace, eventB));
    expect(listB.status).toBe(200);
    const dataB = (await body(listB)).data as { id: string; eventId: string }[];
    expect(dataB.map((row) => row.id)).toEqual([idB]);
    expect(dataB.map((row) => row.eventId)).toEqual([eventB.toHexString()]);
  });

  it("F4: refuses a co-organizer of another event the list (404), so admission is event-scoped too", async () => {
    // Arrange — a co-organizer of event A only, holding no `tenantMembers` row
    // (the I9 reader shape), and an invitation on event B.
    const workspace = await seedWorkspace("op120-f4-member");
    const eventA = await seedEvent(workspace);
    const eventB = await seedEvent(workspace);
    await addEventMember(workspace, eventA, workspace.organizer, "organizer");
    await addEventMember(workspace, eventB, workspace.organizer, "organizer");
    const coOrganizer = await signInVerified("op120-f4-co");
    await addEventMember(workspace, eventA, coOrganizer, "co_organizer");
    const createdB = await createInvitation(
      createRequest(workspace.organizer.cookie, workspace, eventB, emailInvite("priya@example.com"))
    );
    expect(createdB.status).toBe(201);

    // Act — event A is theirs, event B is not.
    const allowed = await listInvitations(listRequest(coOrganizer.cookie, workspace, eventA));
    const refused = await listInvitations(listRequest(coOrganizer.cookie, workspace, eventB));

    // Assert
    expect(allowed.status).toBe(200);
    expect(refused.status).toBe(404);
    expect(await errorCode(refused)).toBe("not_found");
  });
});

/* -------------------------------------------------------------------------- */
/* F5 — the concurrent duplicate create                                      */
/* -------------------------------------------------------------------------- */

describe("F5 — two simultaneous creates for one invitee", () => {
  it("F5: answers exactly one 201 and one 409 invitation_already_pending, and stores one row", async () => {
    // Arrange — two independent attempts (distinct `Idempotency-Key`s, so the
    // replay stage cannot be the thing that refuses the loser) for the same
    // (eventId, invitee). The §13.6 unique partial index is the arbiter.
    const workspace = await seedWorkspace("op120-f5");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");
    const payload = emailInvite("buck@example.com");

    // Act — both requests are in flight together.
    const responses = await Promise.all([
      createInvitation(
        createRequest(workspace.organizer.cookie, workspace, eventId, payload, randomUUID())
      ),
      createInvitation(
        createRequest(workspace.organizer.cookie, workspace, eventId, payload, randomUUID())
      ),
    ]);

    // Assert — one winner, one refusal, whichever order they settle in.
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const winner = responses.find((response) => response.status === 201);
    const loser = responses.find((response) => response.status === 409);
    if (winner === undefined || loser === undefined) {
      throw new Error("expected exactly one 201 and one 409 from the concurrent pair");
    }
    expect(await errorCode(loser)).toBe("invitation_already_pending");

    // Exactly one redeemable row exists, and it is the winner's.
    const rows = await app.db
      .collection(COLLECTIONS.invitations)
      .find({ "invitee.email": "buck@example.com" })
      .toArray();
    expect(rows).toHaveLength(1);
    expect(rows.map((row) => String(row._id))).toEqual([(await body(winner)).id]);
  });
});

/* -------------------------------------------------------------------------- */
/* F6 — the preview of a non-pending invitation                              */
/* -------------------------------------------------------------------------- */

describe("F6 — the preview of a revoked invitation", () => {
  it("F6: answers 200 with status revoked, not the 404 a pending-only lookup would give", async () => {
    // Arrange — a real invitation, its token recovered from the message the
    // invitee receives, then revoked by the organizer.
    const workspace = await seedWorkspace("op120-f6");
    const eventId = await seedEvent(workspace);
    await addEventMember(workspace, eventId, workspace.organizer, "organizer");
    const inviteeEmail = "buck@example.com";

    const created = await createInvitation(
      createRequest(workspace.organizer.cookie, workspace, eventId, emailInvite(inviteeEmail))
    );
    expect(created.status).toBe(201);
    const invitationId = (await body(created)).id as string;
    const stored = await storedInvitation(invitationId);
    const token = await tokenForHash(stored?.tokenHash);

    const revoked = await revokeInvitation(
      revokeRequest(workspace.organizer.cookie, workspace, eventId, invitationId)
    );
    expect(revoked.status).toBe(200);
    expect((await storedInvitation(invitationId))?.status).toBe("revoked");

    // Act — the invitee opens the link after the organizer revoked it.
    const response = await previewInvitation(previewRequest(token));

    // Assert — §2.3: the preview reports the invitation's `status`; a lookup
    // filtered on `status: "pending"` would answer the non-oracle 404 and pass
    // every other case in this file.
    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(Object.keys(payload).sort()).toEqual(PREVIEW_BODY_KEYS);
    expect(payload.status).toBe("revoked");
    expect(payload.inviteeMasked).toBe(maskEmail(inviteeEmail));
    expect(payload.eventName).toBe("Rahul & Priya's Wedding");
    expect(findForbiddenFields(payload, "default")).toEqual([]);
    expect(JSON.stringify(payload)).not.toContain(token);
  });
});
