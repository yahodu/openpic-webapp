import type { Document, InsertOneOptions, WithId } from "mongodb";
import { Collection, ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { findForbiddenFields } from "@openpic/contracts";

import {
  DELETE as removeMember,
  PATCH as changeMemberRole,
} from "@/app/api/v1/tenants/[tenantId]/members/[userId]/route";
import { GET as listMembers } from "@/app/api/v1/tenants/[tenantId]/members/route";
import { GET as tenantGet } from "@/app/api/v1/tenants/[tenantId]/route";
import { COLLECTIONS } from "@/server/db/collections";
import {
  createLogger,
  getLogger,
  memoryTransport,
  setLogger,
  type LogEntry,
  type Logger,
  type MemoryTransport,
} from "@/server/logging";
import { platformRepo } from "@/server/repos";

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
 * Integration / contract — tenant member management (OP-101, contract §2.2,
 * schema §13.4).
 *
 * The user story: *as a tenant owner I list, re-role and remove workspace
 * members, so workspace access is controlled.*
 *
 *   I1  `GET /tenants/{t}/members` returns each member as `displayName` + a
 *       §0.13 **masked** contact (`emailMasked`) and never another user's full
 *       email — the §0.15 never-return rule, checked with the shared scanner
 *       *and* an explicit substring assertion;
 *   I2  an owner cannot change their **own** role — `409 cannot_demote_owner`
 *       (and the stored role is untouched);
 *   I3  a removed member loses access immediately: their very next
 *       `GET /tenants/{t}` is `404 not_found` because roles are re-read from
 *       `tenantMembers` on every request.
 *
 * Around those three the suite pins the ordinary behaviour the story implies:
 * the happy path of each verb, the owner-only gate, target validation, and the
 * uniform `404` (never `403`) the reusable tenant stage answers a non-member.
 *
 * ## Contract expected of the implementation
 *
 * - `@/app/api/v1/tenants/[tenantId]/members/route` exports `GET`, declared with
 *   `defineRoute({ route: "/api/v1/tenants/:tenantId/members", … })` and the
 *   reusable tenant stage; the body is the §2.2 envelope `{ data: Member[] }`
 *   where `Member = { userId, displayName, emailMasked, role, status, joinedAt,
 *   invitedByUserId, avatarUrl }`.
 * - `@/app/api/v1/tenants/[tenantId]/members/[userId]/route` exports `PATCH`
 *   (`{ role: "admin" | "member" }`, owner only) and `DELETE` (soft removal),
 *   declared with `route: "/api/v1/tenants/:tenantId/members/:userId"`.
 * - Contacts are masked with the `@openpic/contracts` helpers the unit spec
 *   pins (`maskEmail`), read from the Better Auth `user` document's `email`.
 * - Both routes resolve `{tenantId}` through the tenant stage, so they echo
 *   `X-Tenant-Id` and deny a non-member with `404 not_found`.
 *
 * ## Implementation note (not pinned by the tests)
 *
 * `tenantIdFromRequest` in `@/server/tenancy/route-stage` currently takes the
 * **last** path segment, which is the tenant only for `/tenants/:tenantId`. On
 * these nested routes the last segment is `members` (or the target `{userId}`),
 * so the stage must learn the tenant segment's *position* — otherwise every
 * request here answers `404`. The tests assert the behaviour, never the fix.
 *
 * ## Assumptions (recorded in ADR-0280)
 *
 * - **A1 — the listing is a `{ data: […] }` envelope**, exactly as §2.2 shows.
 * - **A2 — `PATCH` answers `200` with the updated member**, mirroring the §2.1
 *   `PATCH /tenants/{t}` which returns the updated DTO; §2.2 states no status
 *   for this verb. `DELETE` is `204` because §2.2 says so explicitly.
 * - **A3 — removing the owner is the same guard as demoting them**, so it uses
 *   the catalogue's only owner-protection code, `cannot_demote_owner` (409).
 *   The catalogue carries no `cannot_remove_owner`; §2.2 says only "409".
 * - **A4 — a target `{userId}` with no membership in this workspace is
 *   `404 not_found`** on both `PATCH` and `DELETE`. §2.2 does not name a status;
 *   `404` keeps the endpoint from confirming foreign ids (contract §0.4).
 * - **A5 — the list carries every membership row, removed ones included**, since
 *   §2.2's DTO has a `status` field whose only other value is `removed`. This is
 *   deliberately **not** pinned below (the spec asserts only the active rows it
 *   seeds), so a GREEN that filters to `status: "active"` is not failed.
 * - **A6 — the owner's own role may not be set at all**, not merely "not
 *   demoted": §2.2 says "cannot change the owner's own role".
 */

const CURRENT_ALIAS = "current";
const TENANTS_PATH = "/api/v1/tenants";

/** The §2.2 member DTO keys — no raw contact field exists on the wire. */
const MEMBER_DTO_KEYS = [
  "avatarUrl",
  "displayName",
  "emailMasked",
  "invitedByUserId",
  "joinedAt",
  "role",
  "status",
  "userId",
];

let app: TestApp;

beforeAll(async () => {
  // Boots a private database, the real auth surface and the readiness probe;
  // the cold connect belongs in this hook, never inside a timed spec.
  app = await startTestApp({ prefix: "op101-members" });
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
async function insertTenant(fields: {
  slug: string;
  name: string;
  status?: "active" | "suspended" | "closed";
  ownerUserId?: ObjectId;
}): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.tenants).insertOne({
    _id,
    slug: fields.slug,
    name: fields.name,
    status: fields.status ?? "active",
    ownerUserId: fields.ownerUserId ?? null,
    billingContactUserId: fields.ownerUserId ?? null,
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

/** Insert a membership row (schema §13.4). */
async function insertTenantMember(fields: {
  tenantId: ObjectId;
  userId: ObjectId;
  role: "owner" | "admin" | "member";
  status?: "active" | "removed";
}): Promise<void> {
  await app.db.collection(COLLECTIONS.tenantMembers).insertOne({
    ...fields,
    status: fields.status ?? "active",
    joinedAt: new Date(),
  });
}

/** Seed a workspace owned by `userId`, making it that user's primary tenant. */
async function seedWorkspace(options: {
  userId: ObjectId;
  role: "owner" | "admin" | "member";
  slug?: string;
  name?: string;
}): Promise<ObjectId> {
  const tenantId = await insertTenant({
    slug: options.slug ?? "op101-studio",
    name: options.name ?? "OP101 Studio",
    ownerUserId: options.role === "owner" ? options.userId : new ObjectId(),
  });
  await insertTenantMember({ tenantId, userId: options.userId, role: options.role });
  await updateProfile(options.userId, { primaryTenantId: tenantId });
  return tenantId;
}

/** Add `user` to `tenantId` with a display name and a working `current` alias. */
async function addMember(
  tenantId: ObjectId,
  user: SignedInUser,
  displayName: string,
  role: "owner" | "admin" | "member" = "member"
): Promise<void> {
  await insertTenantMember({ tenantId, userId: user.userId, role });
  await updateProfile(user.userId, { displayName, primaryTenantId: tenantId });
}

/** A `GET /tenants/{tenantId}/members` request carrying the session cookie. */
function listRequest(cookie: string, tenantId: string): Request {
  return new Request(new URL(`${TENANTS_PATH}/${tenantId}/members`, APP_ORIGIN), {
    method: "GET",
    headers: { cookie },
  });
}

/** A `PATCH`/`DELETE /tenants/{tenantId}/members/{userId}` request. */
function memberRequest(
  cookie: string,
  tenantId: string,
  userId: string,
  method: "PATCH" | "DELETE",
  payload?: unknown
): Request {
  return new Request(new URL(`${TENANTS_PATH}/${tenantId}/members/${userId}`, APP_ORIGIN), {
    method,
    headers: payload === undefined ? { cookie } : { cookie, "content-type": "application/json" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

/** A `GET /tenants/{tenantId}` request carrying the session cookie. */
function tenantRequest(cookie: string, tenantId: string): Request {
  return new Request(new URL(`${TENANTS_PATH}/${tenantId}`, APP_ORIGIN), {
    method: "GET",
    headers: { cookie },
  });
}

/** The error envelope of a failed response. */
async function errorEnvelope(response: Response): Promise<{ code: string }> {
  const parsed = await body(response);
  return parsed.error as { code: string };
}

/** Read the raw `tenantMembers` row for one user in one workspace. */
async function findMembership(
  tenantId: ObjectId,
  userId: ObjectId
): Promise<WithId<Document> | null> {
  return app.db.collection(COLLECTIONS.tenantMembers).findOne({ tenantId, userId });
}

describe("GET /api/v1/tenants/{tenantId}/members", () => {
  it("I1: lists every member with a masked email and never the full address of another user", async () => {
    const owner = await app.signIn(makeIdentity("rsvp-owner"));
    const member = await app.signIn(makeIdentity("maya-member"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
    await addMember(tenantId, member, "Priya Sharma");

    const response = await listMembers(listRequest(owner.cookie, CURRENT_ALIAS));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-tenant-id")).toBe(tenantId.toHexString());

    const payload = await body(response);
    const entries = payload.data as Record<string, unknown>[];
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(2);

    // The owner's own row is masked too: the §2.2 DTO has no raw contact field.
    const ownerEntry = entries.find((entry) => entry.userId === owner.userId.toHexString());
    expect(ownerEntry).toBeDefined();
    expect(ownerEntry?.role).toBe("owner");
    expect(ownerEntry?.status).toBe("active");
    expect(ownerEntry?.emailMasked).toBe("r•••@example.com");

    const memberEntry = entries.find((entry) => entry.userId === member.userId.toHexString());
    expect(memberEntry).toBeDefined();
    expect(memberEntry).toMatchObject({
      displayName: "Priya Sharma",
      emailMasked: "m•••@example.com",
      role: "member",
      status: "active",
      invitedByUserId: null,
      avatarUrl: null,
    });
    expect(new Date(memberEntry?.joinedAt as string).toISOString()).toBe(memberEntry?.joinedAt);

    // §2.2 fixes the DTO exactly: no `email`, no `phone`, no extra field.
    expect(Object.keys(memberEntry ?? {}).sort()).toEqual(MEMBER_DTO_KEYS);

    // §0.15: the never-return scanner finds nothing, and the raw addresses of
    // both users are provably absent from the serialized body.
    expect(findForbiddenFields(payload, "default")).toEqual([]);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(member.identity.email);
    expect(serialized).not.toContain(owner.identity.email);
    expect(serialized).not.toContain("maya-member");
  });

  it("I1: accepts an explicit workspace id as well as the `current` alias", async () => {
    const owner = await app.signIn(makeIdentity("rsvp-owner"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });

    const response = await listMembers(listRequest(owner.cookie, tenantId.toHexString()));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-tenant-id")).toBe(tenantId.toHexString());
    const entries = (await body(response)).data as Record<string, unknown>[];
    expect(entries.map((entry) => entry.userId)).toEqual([owner.userId.toHexString()]);
  });

  it("answers 404 (never 403) to a caller who is not a member of the workspace", async () => {
    const owner = await app.signIn(makeIdentity("rsvp-owner"));
    const stranger = await app.signIn(makeIdentity("nosy-stranger"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });

    const response = await listMembers(listRequest(stranger.cookie, tenantId.toHexString()));

    expect(response.status).toBe(404);
    expect((await errorEnvelope(response)).code).toBe("not_found");
  });

  it("answers 404 to a caller with no workspace reading the `current` alias", async () => {
    const attendee = await app.signIn(makeIdentity("pure-attendee"));
    await updateProfile(attendee.userId, { primaryTenantId: null });

    const response = await listMembers(listRequest(attendee.cookie, CURRENT_ALIAS));

    expect(response.status).toBe(404);
    expect((await errorEnvelope(response)).code).toBe("not_found");
  });

  it("answers 401 without a session", async () => {
    const response = await listMembers(
      new Request(new URL(`${TENANTS_PATH}/${CURRENT_ALIAS}/members`, APP_ORIGIN), {
        method: "GET",
      })
    );

    expect(response.status).toBe(401);
    expect((await errorEnvelope(response)).code).toBe("authentication_required");
  });
});

describe("PATCH /api/v1/tenants/{tenantId}/members/{userId}", () => {
  it.each(["admin", "member"] as const)(
    "I2: refuses to change the owner's own role to %s with 409 cannot_demote_owner",
    async (role) => {
      const owner = await app.signIn(makeIdentity("rsvp-owner"));
      const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });

      const response = await changeMemberRole(
        memberRequest(owner.cookie, CURRENT_ALIAS, owner.userId.toHexString(), "PATCH", { role })
      );

      expect(response.status).toBe(409);
      expect((await errorEnvelope(response)).code).toBe("cannot_demote_owner");

      // The refusal is total: the owner's stored role is untouched.
      const stored = await findMembership(tenantId, owner.userId);
      expect(stored?.role).toBe("owner");
      expect(stored?.status).toBe("active");
    }
  );

  it("promotes a member to admin and persists it", async () => {
    const owner = await app.signIn(makeIdentity("rsvp-owner"));
    const member = await app.signIn(makeIdentity("maya-member"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
    await addMember(tenantId, member, "Priya Sharma");

    const response = await changeMemberRole(
      memberRequest(owner.cookie, CURRENT_ALIAS, member.userId.toHexString(), "PATCH", {
        role: "admin",
      })
    );

    expect(response.status).toBe(200);
    const updated = await body(response);
    expect(updated.userId).toBe(member.userId.toHexString());
    expect(updated.role).toBe("admin");

    const stored = await findMembership(tenantId, member.userId);
    expect(stored?.role).toBe("admin");
    expect(stored?.status).toBe("active");
  });

  it("demotes an admin back to member and persists it", async () => {
    const owner = await app.signIn(makeIdentity("rsvp-owner"));
    const admin = await app.signIn(makeIdentity("dev-admin"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
    await addMember(tenantId, admin, "Dev Admin", "admin");

    const response = await changeMemberRole(
      memberRequest(owner.cookie, CURRENT_ALIAS, admin.userId.toHexString(), "PATCH", {
        role: "member",
      })
    );

    expect(response.status).toBe(200);
    expect((await body(response)).role).toBe("member");
    expect((await findMembership(tenantId, admin.userId))?.role).toBe("member");
  });

  it.each(["admin", "member"] as const)(
    "forbids a non-owner (%s) from changing another member's role (owner only)",
    async (actorRole) => {
      const owner = await app.signIn(makeIdentity("rsvp-owner"));
      const actor = await app.signIn(makeIdentity("acting-user"));
      const target = await app.signIn(makeIdentity("maya-member"));
      const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
      await addMember(tenantId, actor, "Acting User", actorRole);
      await addMember(tenantId, target, "Priya Sharma");

      const response = await changeMemberRole(
        memberRequest(actor.cookie, CURRENT_ALIAS, target.userId.toHexString(), "PATCH", {
          role: "admin",
        })
      );

      expect(response.status).toBe(403);
      expect((await errorEnvelope(response)).code).toBe("forbidden");
      expect((await findMembership(tenantId, target.userId))?.role).toBe("member");
    }
  );

  it("rejects a role outside admin|member with 422 validation_failed", async () => {
    const owner = await app.signIn(makeIdentity("rsvp-owner"));
    const member = await app.signIn(makeIdentity("maya-member"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
    await addMember(tenantId, member, "Priya Sharma");

    const response = await changeMemberRole(
      memberRequest(owner.cookie, CURRENT_ALIAS, member.userId.toHexString(), "PATCH", {
        role: "owner",
      })
    );

    expect(response.status).toBe(422);
    expect((await errorEnvelope(response)).code).toBe("validation_failed");
    expect((await findMembership(tenantId, member.userId))?.role).toBe("member");
  });

  it("answers 404 for a target who holds no membership in this workspace", async () => {
    const owner = await app.signIn(makeIdentity("rsvp-owner"));
    await seedWorkspace({ userId: owner.userId, role: "owner" });

    const response = await changeMemberRole(
      memberRequest(owner.cookie, CURRENT_ALIAS, new ObjectId().toHexString(), "PATCH", {
        role: "admin",
      })
    );

    expect(response.status).toBe(404);
    expect((await errorEnvelope(response)).code).toBe("not_found");
  });
});

describe("DELETE /api/v1/tenants/{tenantId}/members/{userId}", () => {
  it("I3: removes a member, keeps the row as history, and their next tenant read is 404", async () => {
    const owner = await app.signIn(makeIdentity("rsvp-owner"));
    const member = await app.signIn(makeIdentity("maya-member"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
    await addMember(tenantId, member, "Priya Sharma");
    const joinedAt = (await findMembership(tenantId, member.userId))?.joinedAt as Date;

    // Baseline: the member can read the workspace through the `current` alias.
    const before = await tenantGet(tenantRequest(member.cookie, CURRENT_ALIAS));
    expect(before.status).toBe(200);
    expect(before.headers.get("x-tenant-id")).toBe(tenantId.toHexString());

    const response = await removeMember(
      memberRequest(owner.cookie, CURRENT_ALIAS, member.userId.toHexString(), "DELETE")
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");

    // Soft removal: history is preserved, the row is not deleted.
    const stored = await findMembership(tenantId, member.userId);
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe("removed");
    expect(stored?.removedAt).toBeInstanceOf(Date);
    expect(stored?.joinedAt).toEqual(joinedAt);

    // Roles are re-read from `tenantMembers` on every request, so the very next
    // read — by alias or by explicit id — is denied.
    const afterAlias = await tenantGet(tenantRequest(member.cookie, CURRENT_ALIAS));
    expect(afterAlias.status).toBe(404);
    expect((await errorEnvelope(afterAlias)).code).toBe("not_found");

    const afterExplicit = await tenantGet(tenantRequest(member.cookie, tenantId.toHexString()));
    expect(afterExplicit.status).toBe(404);
    expect((await errorEnvelope(afterExplicit)).code).toBe("not_found");
  });

  it("refuses to remove the owner with 409 and leaves the membership active", async () => {
    const owner = await app.signIn(makeIdentity("rsvp-owner"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });

    const response = await removeMember(
      memberRequest(owner.cookie, CURRENT_ALIAS, owner.userId.toHexString(), "DELETE")
    );

    expect(response.status).toBe(409);
    expect((await errorEnvelope(response)).code).toBe("cannot_demote_owner");

    const stored = await findMembership(tenantId, owner.userId);
    expect(stored?.status).toBe("active");
    expect(stored?.role).toBe("owner");
    expect(stored?.removedAt ?? null).toBeNull();
  });

  it("forbids an admin from removing a member (owner only)", async () => {
    const owner = await app.signIn(makeIdentity("rsvp-owner"));
    const admin = await app.signIn(makeIdentity("dev-admin"));
    const target = await app.signIn(makeIdentity("maya-member"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
    await addMember(tenantId, admin, "Dev Admin", "admin");
    await addMember(tenantId, target, "Priya Sharma");

    const response = await removeMember(
      memberRequest(admin.cookie, CURRENT_ALIAS, target.userId.toHexString(), "DELETE")
    );

    expect(response.status).toBe(403);
    expect((await errorEnvelope(response)).code).toBe("forbidden");
    expect((await findMembership(tenantId, target.userId))?.status).toBe("active");
  });

  it("answers 404 for a target who holds no membership in this workspace", async () => {
    const owner = await app.signIn(makeIdentity("rsvp-owner"));
    await seedWorkspace({ userId: owner.userId, role: "owner" });

    const response = await removeMember(
      memberRequest(owner.cookie, CURRENT_ALIAS, new ObjectId().toHexString(), "DELETE")
    );

    expect(response.status).toBe(404);
    expect((await errorEnvelope(response)).code).toBe("not_found");
  });
});

/**
 * OP-101 follow-up pins — a membership row whose `joinedAt` cannot name an
 * instant (contract §2.2, ADR-0282).
 *
 * `projectMember()` normalised the join instant with a bare
 * `new Date(value).toISOString()`, which throws `RangeError: Invalid time value`
 * for an absent, `null`, `NaN` or unparseable `joinedAt`. The route has no
 * per-row recovery, so ONE corrupt `tenantMembers` row turned the whole listing
 * into a `500` for every caller of the workspace — the defect a user sees.
 *
 * The pins below fix the observable behaviour end-to-end through the real route:
 * a workspace holding one undatable membership still answers `200` with the
 * §2.2 envelope, every member stays listed (a corrupt instant may never hide a
 * row), and the undatable row's `joinedAt` is the epoch sentinel
 * `1970-01-01T00:00:00.000Z`. Contract §2.2 has no nullable `joinedAt` and
 * `memberSchema` requires `isoDateTimeSchema`, so the sentinel — not `null` — is
 * the only degradation that can reach the wire (ADR-0282 §D2). The final case is
 * the green control: the documented inputs (a `Date`, an RFC 3339 UTC string and
 * epoch milliseconds) still project to exactly today's ISO string.
 */
describe("GET /api/v1/tenants/{tenantId}/members — a membership with no usable `joinedAt`", () => {
  /** The instant an undatable `joinedAt` degrades to (ADR-0282 §D2). */
  const EPOCH_JOINED_AT_ISO = "1970-01-01T00:00:00.000Z";

  /** The instant every green control round-trips to, and its numeric form. */
  const JOINED_AT_ISO = "2026-03-04T05:06:07.890Z";
  const JOINED_AT_MILLIS = 1772600767890;

  /**
   * Insert a raw `tenantMembers` row exactly as supplied, with no defaults.
   *
   * Unlike {@link insertTenantMember} this never stamps `joinedAt`, so a spec can
   * seed the absent and unusable rows the collection's write path would never
   * produce but an older write, a migration or a manual repair can.
   */
  async function insertRawMembership(row: Record<string, unknown>): Promise<void> {
    await app.db.collection(COLLECTIONS.tenantMembers).insertOne({ ...row });
  }

  it("still answers 200 and lists the member when one membership has no `joinedAt`", async () => {
    const owner = await app.signIn(makeIdentity("rsvp-owner"));
    const member = await app.signIn(makeIdentity("maya-member"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
    await insertRawMembership({
      tenantId,
      userId: member.userId,
      role: "member",
      status: "active",
    });

    const response = await listMembers(listRequest(owner.cookie, CURRENT_ALIAS));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-tenant-id")).toBe(tenantId.toHexString());

    const entries = (await body(response)).data as Record<string, unknown>[];
    // The corrupt instant may never push a member out of the listing.
    expect(entries.map((entry) => entry.userId).sort()).toEqual(
      [member.userId.toHexString(), owner.userId.toHexString()].sort()
    );

    const memberEntry = entries.find((entry) => entry.userId === member.userId.toHexString());
    expect(memberEntry?.joinedAt).toBe(EPOCH_JOINED_AT_ISO);
    // §2.2 fixes the DTO exactly: the degraded row keeps every key.
    expect(Object.keys(memberEntry ?? {}).sort()).toEqual(MEMBER_DTO_KEYS);

    // The neighbouring, healthy row is untouched by its neighbour's corruption.
    const ownerEntry = entries.find((entry) => entry.userId === owner.userId.toHexString());
    expect(new Date(ownerEntry?.joinedAt as string).toISOString()).toBe(ownerEntry?.joinedAt);
  });

  it.each([
    ["null", null],
    ["NaN", Number.NaN],
    ["an unparseable string", "not-a-date"],
  ])(
    "still answers 200 for a membership whose `joinedAt` is %s, degrading it to the epoch",
    async (_label, joinedAt) => {
      const owner = await app.signIn(makeIdentity("rsvp-owner"));
      const member = await app.signIn(makeIdentity("maya-member"));
      const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
      await insertRawMembership({
        tenantId,
        userId: member.userId,
        role: "member",
        status: "active",
        joinedAt,
      });

      const response = await listMembers(listRequest(owner.cookie, CURRENT_ALIAS));

      expect(response.status).toBe(200);
      const entries = (await body(response)).data as Record<string, unknown>[];
      const memberEntry = entries.find((entry) => entry.userId === member.userId.toHexString());
      expect(memberEntry).toBeDefined();
      expect(memberEntry?.joinedAt).toBe(EPOCH_JOINED_AT_ISO);
    }
  );

  it.each([
    ["a stored Date", () => new Date(JOINED_AT_ISO)],
    ["an RFC 3339 UTC string", () => JOINED_AT_ISO],
    ["epoch milliseconds as a number", () => JOINED_AT_MILLIS],
  ])(
    "keeps the documented path for %s: the same ISO instant, unchanged",
    async (_label, stored) => {
      const owner = await app.signIn(makeIdentity("rsvp-owner"));
      const member = await app.signIn(makeIdentity("maya-member"));
      const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
      await insertRawMembership({
        tenantId,
        userId: member.userId,
        role: "member",
        status: "active",
        joinedAt: stored(),
      });

      const response = await listMembers(listRequest(owner.cookie, CURRENT_ALIAS));

      expect(response.status).toBe(200);
      const entries = (await body(response)).data as Record<string, unknown>[];
      const memberEntry = entries.find((entry) => entry.userId === member.userId.toHexString());
      expect(memberEntry?.joinedAt).toBe(JOINED_AT_ISO);
    }
  );
});

/**
 * OP-101 follow-up pins — a membership row whose **numeric, string or `Date`**
 * `joinedAt` names an instant outside the RFC 3339 four-digit-year range
 * (contract §2.2, ADR-0282, ADR-0284).
 *
 * The merged defensive restore makes the projection total for every value that
 * cannot name an instant, but a finite number is admitted as an instant and
 * `Date.prototype.toISOString()` leaves the four-digit-year form at
 * `|millis| >= 253402300800000` (and below `-62167219200000`), returning
 * `+010000-…`, `+275760-…`, `-271821-…` or `-000001-…`. `isoDateTimeSchema`
 * rejects those shapes, so `serializeResponse` fails and the whole listing is a
 * `5xx` for every caller of the workspace — one corrupt row denying the listing,
 * exactly what ADR-0282 exists to remove. `tenantMembers` carries no MongoDB
 * validator, so an older write, a migration or a manual repair can store such a
 * number; the write path cannot.
 *
 * The route is where the defect is observable, so these pins assert the wire
 * behaviour: `200`, the §2.2 `{ data: […] }` envelope, the member still listed,
 * and its `joinedAt` degraded to the epoch sentinel `1970-01-01T00:00:00.000Z`.
 * The final case is the control at the wire's own ceiling: one millisecond
 * inside the four-digit-year range (`9999-12-31T23:59:59.999Z`) must still be
 * served as itself, so the bound may not be tighter than the wire format.
 *
 * ## Why the epoch sentinel (ADR-0284, following ADR-0282 §D2)
 *
 * `memberSchema` requires a non-nullable `isoDateTimeSchema`, so `null` is not
 * on the wire (it would still fail `serializeResponse`) and the listing's
 * `joinedAt` sort would break on it. The epoch is a schema-valid, totally
 * ordered instant that cannot be mistaken for a real join time. ADR-0284 adds
 * the window itself — "names an instant" means an instant the wire can carry,
 * i.e. `-62167219200000 … 253402300799999`.
 *
 * ## Contract expected of the implementation
 *
 * `GET /api/v1/tenants/{tenantId}/members` must answer `200` for a workspace
 * whose `tenantMembers` rows carry any `joinedAt`, listing every
 * member, and must serve each `joinedAt` as an `isoDateTimeSchema`-valid string:
 * the exact instant inside `-62167219200000 … 253402300799999`, the epoch
 * sentinel otherwise. How the bound is enforced is not pinned here (ADR-0284).
 */
describe("GET /api/v1/tenants/{tenantId}/members — a `joinedAt` outside the four-digit-year range", () => {
  /** The instant an out-of-range `joinedAt` degrades to (ADR-0282 §D2). */
  const EPOCH_JOINED_AT_ISO = "1970-01-01T00:00:00.000Z";

  /** The last instant inside the wire's window, and its ISO form. */
  const LAST_WIRE_INSTANT_MILLIS = 253402300799999;
  const LAST_WIRE_INSTANT_ISO = "9999-12-31T23:59:59.999Z";

  /** The first instant past the ceiling, stored as the string an old write may hold. */
  const FIRST_EXPANDED_YEAR_ISO = "+010000-01-01T00:00:00.000Z";

  /**
   * Insert a raw `tenantMembers` row exactly as supplied, with no defaults.
   *
   * Unlike {@link insertTenantMember} this never stamps `joinedAt`, so a spec
   * can seed the numeric rows the collection's write path would never produce.
   */
  async function insertRawMembership(row: Record<string, unknown>): Promise<void> {
    await app.db.collection(COLLECTIONS.tenantMembers).insertOne({ ...row });
  }

  it.each([
    ["the first instant past the four-digit-year ceiling", 253402300800000],
    ["the Date maximum", 8.64e15],
    ["the Date minimum", -8.64e15],
  ])(
    "still answers 200 for a membership whose `joinedAt` is %s, degrading it to the epoch",
    async (_label, joinedAt) => {
      const owner = await app.signIn(makeIdentity("rsvp-owner"));
      const member = await app.signIn(makeIdentity("maya-member"));
      const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
      await insertRawMembership({
        tenantId,
        userId: member.userId,
        role: "member",
        status: "active",
        joinedAt,
      });

      const response = await listMembers(listRequest(owner.cookie, CURRENT_ALIAS));

      expect(response.status).toBe(200);
      expect(response.headers.get("x-tenant-id")).toBe(tenantId.toHexString());

      const entries = (await body(response)).data as Record<string, unknown>[];
      // One corrupt instant may never push a member out of the listing.
      expect(entries.map((entry) => entry.userId).sort()).toEqual(
        [member.userId.toHexString(), owner.userId.toHexString()].sort()
      );

      const memberEntry = entries.find((entry) => entry.userId === member.userId.toHexString());
      expect(memberEntry).toBeDefined();
      expect(memberEntry?.joinedAt).toBe(EPOCH_JOINED_AT_ISO);
      expect(Object.keys(memberEntry ?? {}).sort()).toEqual(MEMBER_DTO_KEYS);
    }
  );

  it("still serves a numeric `joinedAt` at the wire's own ceiling as its exact instant", async () => {
    const owner = await app.signIn(makeIdentity("rsvp-owner"));
    const member = await app.signIn(makeIdentity("maya-member"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
    await insertRawMembership({
      tenantId,
      userId: member.userId,
      role: "member",
      status: "active",
      joinedAt: LAST_WIRE_INSTANT_MILLIS,
    });

    const response = await listMembers(listRequest(owner.cookie, CURRENT_ALIAS));

    expect(response.status).toBe(200);
    const entries = (await body(response)).data as Record<string, unknown>[];
    const memberEntry = entries.find((entry) => entry.userId === member.userId.toHexString());
    expect(memberEntry?.joinedAt).toBe(LAST_WIRE_INSTANT_ISO);
  });

  it("still answers 200 for a membership whose `joinedAt` is the string `+010000-01-01T00:00:00.000Z`, degrading it to the epoch", async () => {
    // The string arm reaches the same `new Date(value).getTime()` the numeric
    // arm does, so a bound placed on numbers only would let this row deny the
    // listing with `data.0.joinedAt: Invalid ISO datetime` (ADR-0284 §D1 fixes
    // the contract for whatever the stored `joinedAt` is).
    const owner = await app.signIn(makeIdentity("rsvp-owner"));
    const member = await app.signIn(makeIdentity("maya-member"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
    await insertRawMembership({
      tenantId,
      userId: member.userId,
      role: "member",
      status: "active",
      joinedAt: FIRST_EXPANDED_YEAR_ISO,
    });

    const response = await listMembers(listRequest(owner.cookie, CURRENT_ALIAS));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-tenant-id")).toBe(tenantId.toHexString());

    const entries = (await body(response)).data as Record<string, unknown>[];
    // A corrupt instant may never push a member out of the listing.
    expect(entries.map((entry) => entry.userId).sort()).toEqual(
      [member.userId.toHexString(), owner.userId.toHexString()].sort()
    );

    const memberEntry = entries.find((entry) => entry.userId === member.userId.toHexString());
    expect(memberEntry).toBeDefined();
    expect(memberEntry?.joinedAt).toBe(EPOCH_JOINED_AT_ISO);
  });

  it("still answers 200 for a membership whose `joinedAt` is a stored `Date` past the four-digit-year ceiling, degrading it to the epoch", async () => {
    // The third arm. `joinedAtMillis` reads `value.getTime()` for a `Date`
    // before any parse, so a bound placed on the parsed millis covers it, while
    // a bound placed on the numeric and string branches alone does not — and the
    // projected `+275760-09-13T00:00:00.000Z` then denies the whole listing with
    // `data.0.joinedAt: Invalid ISO datetime` (ADR-0284 §D1, ADR-0285).
    const DATE_MAXIMUM_MILLIS = 8.64e15;
    const owner = await app.signIn(makeIdentity("rsvp-owner"));
    const member = await app.signIn(makeIdentity("maya-member"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
    await insertRawMembership({
      tenantId,
      userId: member.userId,
      role: "member",
      status: "active",
      joinedAt: new Date(DATE_MAXIMUM_MILLIS),
    });

    // Confirmed rather than assumed: the driver stores the `Date` itself, so this
    // case exercises the `Date` arm and not a coerced string.
    const stored = await app.db
      .collection(COLLECTIONS.tenantMembers)
      .findOne({ tenantId, userId: member.userId });
    expect(stored?.joinedAt).toEqual(new Date(DATE_MAXIMUM_MILLIS));

    const response = await listMembers(listRequest(owner.cookie, CURRENT_ALIAS));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-tenant-id")).toBe(tenantId.toHexString());

    const entries = (await body(response)).data as Record<string, unknown>[];
    // A corrupt instant may never push a member out of the listing.
    expect(entries.map((entry) => entry.userId).sort()).toEqual(
      [member.userId.toHexString(), owner.userId.toHexString()].sort()
    );

    const memberEntry = entries.find((entry) => entry.userId === member.userId.toHexString());
    expect(memberEntry).toBeDefined();
    expect(memberEntry?.joinedAt).toBe(EPOCH_JOINED_AT_ISO);
  });
});

/**
 * OP-101 residual pins — the member contract the stale draft PR #272 carried
 * (contract §2.2, schema §13.1/§13.2/§13.4, ADR-0283, ADR-0304, ADR-0288).
 *
 * PR #272 (`OP-101-task-tenant-members-green-restore`) was closed unmerged under
 * ADR-0304 §Consequences: its production intent reached the trunk through other
 * PRs, so the branch is not merged — but five pin clusters it carried are
 * genuinely absent from `main`, and one production difference is still live.
 * ADR-0304 asks for a fresh pin for each absent assertion, never a merge of the
 * stale branch; these are those pins.
 *
 *   R1  the listing has **no tie-break**: `listWorkspaceMembers` sorts by
 *       `joinedAt` alone (`.sort((left, right) =>
 *       left.joinedAt.localeCompare(right.joinedAt))`), so two memberships that
 *       share an instant come back in storage read order. #272's `d5be9af4`
 *       added `|| left.userId.localeCompare(right.userId)`. **This one case is
 *       expected RED at the trunk** — it is the behaviour the GREEN must add;
 *   R2  the two member mutations emit exactly one audit entry each
 *       (`member.role_changed` with the workspace, the target and the new role;
 *       `member.removed` with the workspace and the target) and neither refusal
 *       arm emits one;
 *   R3  a membership whose `user` document is gone stays listed, with its
 *       contact fully masked, instead of being dropped or denying the listing;
 *   R4  a membership whose `userProfiles` document is gone stays listed with an
 *       empty `displayName`;
 *   R5  a malformed `{userId}` is `404 not_found` on both verbs — never `500`,
 *       never `403`;
 *   R6  a path with no usable tenant segment answers the uniform logged `404`.
 *
 * R2–R6 are characterization pins: `main` already answers them, and they are
 * green on arrival by design (ADR-0288). Each is load-bearing — the GREEN's
 * refactor must keep them green, and a regression in any of them reds exactly
 * the case that names it.
 */

/** The Better Auth-owned user collection (schema §13.1), as the projection reads it. */
const USER_COLLECTION = "user";

/**
 * Three 24-hex `{userId}` values that no sign-in ever minted, fixed rather than
 * drawn from `new ObjectId()` so the ordering case below has a **known** id
 * order.
 *
 * A sign-in's id is random, so a fixture built from real users cannot tell a
 * `joinedAt`-then-`userId` sort from a `userId`-only one. These three pin it:
 * the earliest instant belongs to the **largest** id, and the tie pair is
 * stored in **descending** id order. A membership row whose `user` document
 * does not exist is still listed, with a fully masked contact — that is pinned
 * on its own by R3, and it is what lets this case name ids no sign-in minted.
 */
const ORDER_EARLIEST_JOINED_USER_ID = "ffffffffffffffffffffff00";
const ORDER_TIE_LARGER_USER_ID = "ffffffffffffffffffffff01";
const ORDER_TIE_SMALLER_USER_ID = "000000000000000000000001";

describe("OP-101 tenant-member residuals (ADR-0304 fresh pins, ADR-0288)", () => {
  /** The logger a case found installed, so the case can put it back. */
  let loggerBeforeCase: Logger | undefined;

  /**
   * Install a memory sink for one case and hand it back.
   *
   * `@/server/logging` has no `resetLogger`, so a case that left this sink in
   * place would silence every later case in the file; the `afterEach` below
   * restores the logger the case found. Call it **after** the fixture is seeded:
   * sign-in and provisioning log too, and the sink must hold only the lines the
   * case is about.
   *
   * @returns The sink the request's entries land in.
   */
  function captureLogs(): MemoryTransport {
    loggerBeforeCase = getLogger();
    const sink = memoryTransport();
    setLogger(createLogger({ level: "info", transports: [sink] }));
    return sink;
  }

  /** The entries of one `event`, in emission order. */
  function auditEntries(sink: MemoryTransport, event: string): LogEntry[] {
    return sink.entries.filter((entry) => entry.event === event);
  }

  afterEach(() => {
    if (loggerBeforeCase !== undefined) {
      setLogger(loggerBeforeCase);
      loggerBeforeCase = undefined;
    }
  });

  /**
   * R1 — the listing's total order.
   *
   * `joinedAt` ascends; two memberships that share an instant are ordered by
   * ascending `userId`, so the listing is a total order that does not depend on
   * how the storage engine happened to lay the rows out.
   */
  describe("GET /api/v1/tenants/{tenantId}/members — the total order", () => {
    /** The instant of the one untied member, who joins last and sorts last. */
    const LAST_JOINED_AT = "2026-03-03T00:00:00.000Z";

    /** The instant of the member who joins before the tie pair and sorts first. */
    const FIRST_JOINED_AT = "2026-01-01T00:00:00.000Z";

    /** The instant the tie pair shares. */
    const TIE_JOINED_AT = "2026-02-02T00:00:00.000Z";

    it("orders by joinedAt ascending and breaks an equal instant by ascending userId", async () => {
      const owner = await app.signIn(makeIdentity("rsvp-owner"));
      const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
      const memberships = app.db.collection(COLLECTIONS.tenantMembers);

      // The owner joins last, so the listing must put them last whatever their
      // random id is.
      await memberships.updateOne(
        { tenantId, userId: owner.userId },
        { $set: { joinedAt: new Date(LAST_JOINED_AT) } }
      );

      // The tie pair is stored in DESCENDING id order, so the storage read
      // order is the opposite of the order the listing promises: only a
      // `userId` tie-break produces ascending here.
      await memberships.insertOne({
        tenantId,
        userId: new ObjectId(ORDER_TIE_LARGER_USER_ID),
        role: "member",
        status: "active",
        joinedAt: new Date(TIE_JOINED_AT),
      });
      await memberships.insertOne({
        tenantId,
        userId: new ObjectId(ORDER_TIE_SMALLER_USER_ID),
        role: "member",
        status: "active",
        joinedAt: new Date(TIE_JOINED_AT),
      });
      // The earliest instant belongs to the LARGEST id, so a `userId`-only
      // sort cannot produce this ordering either.
      await memberships.insertOne({
        tenantId,
        userId: new ObjectId(ORDER_EARLIEST_JOINED_USER_ID),
        role: "member",
        status: "active",
        joinedAt: new Date(FIRST_JOINED_AT),
      });

      const response = await listMembers(listRequest(owner.cookie, CURRENT_ALIAS));

      expect(response.status).toBe(200);
      const entries = (await body(response)).data as Record<string, unknown>[];
      expect(entries.map((entry) => entry.userId)).toEqual([
        ORDER_EARLIEST_JOINED_USER_ID,
        ORDER_TIE_SMALLER_USER_ID,
        ORDER_TIE_LARGER_USER_ID,
        owner.userId.toHexString(),
      ]);
    });
  });

  /**
   * R2 — the audit trail of the two member mutations.
   *
   * `PATCH` emits exactly one `member.role_changed` carrying the resolved
   * workspace, the target and the role it set; `DELETE` emits exactly one
   * `member.removed` carrying the resolved workspace and the target. A refusal
   * is total, so it emits nothing: the entry is written only after the write it
   * reports has landed.
   */
  describe("PATCH/DELETE /api/v1/tenants/{tenantId}/members/{userId} — the audit trail", () => {
    it("emits exactly one member.role_changed, with the workspace, the target and the new role", async () => {
      const owner = await app.signIn(makeIdentity("rsvp-owner"));
      const member = await app.signIn(makeIdentity("maya-member"));
      const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
      await addMember(tenantId, member, "Priya Sharma");

      const sink = captureLogs();
      const response = await changeMemberRole(
        memberRequest(owner.cookie, CURRENT_ALIAS, member.userId.toHexString(), "PATCH", {
          role: "admin",
        })
      );

      expect(response.status).toBe(200);
      const entries = auditEntries(sink, "member.role_changed");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        level: "info",
        tenantId: tenantId.toHexString(),
        userId: member.userId.toHexString(),
        role: "admin",
      });
      // The other mutation's event belongs to the other verb.
      expect(auditEntries(sink, "member.removed")).toEqual([]);
    });

    it("emits exactly one member.removed, with the workspace and the target", async () => {
      const owner = await app.signIn(makeIdentity("rsvp-owner"));
      const member = await app.signIn(makeIdentity("maya-member"));
      const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
      await addMember(tenantId, member, "Priya Sharma");

      const sink = captureLogs();
      const response = await removeMember(
        memberRequest(owner.cookie, CURRENT_ALIAS, member.userId.toHexString(), "DELETE")
      );

      expect(response.status).toBe(204);
      const entries = auditEntries(sink, "member.removed");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        level: "info",
        tenantId: tenantId.toHexString(),
        userId: member.userId.toHexString(),
      });
      expect(auditEntries(sink, "member.role_changed")).toEqual([]);
    });

    it("emits no audit entry when a non-owner is refused (403)", async () => {
      const owner = await app.signIn(makeIdentity("rsvp-owner"));
      const admin = await app.signIn(makeIdentity("dev-admin"));
      const target = await app.signIn(makeIdentity("maya-member"));
      const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
      await addMember(tenantId, admin, "Dev Admin", "admin");
      await addMember(tenantId, target, "Priya Sharma");

      const sink = captureLogs();
      const patched = await changeMemberRole(
        memberRequest(admin.cookie, CURRENT_ALIAS, target.userId.toHexString(), "PATCH", {
          role: "admin",
        })
      );
      const deleted = await removeMember(
        memberRequest(admin.cookie, CURRENT_ALIAS, target.userId.toHexString(), "DELETE")
      );

      expect(patched.status).toBe(403);
      expect(deleted.status).toBe(403);
      expect(auditEntries(sink, "member.role_changed")).toEqual([]);
      expect(auditEntries(sink, "member.removed")).toEqual([]);
    });

    it("emits no member.removed when the owner's own removal is refused (409)", async () => {
      const owner = await app.signIn(makeIdentity("rsvp-owner"));
      await seedWorkspace({ userId: owner.userId, role: "owner" });

      const sink = captureLogs();
      const response = await removeMember(
        memberRequest(owner.cookie, CURRENT_ALIAS, owner.userId.toHexString(), "DELETE")
      );

      // §2.2 and the shipped `DELETE` cases fix the code: the owner is protected
      // by the same guard as a demotion, so the refusal is `cannot_demote_owner`
      // — Appendix A.5's only owner-protection code (ADR-0280 §D3). The card's
      // `cannot_remove_organizer` is the OP-121 *event*-member code
      // (`COLLABORATION_ERROR_CODES`), not this surface's.
      expect(response.status).toBe(409);
      expect((await errorEnvelope(response)).code).toBe("cannot_demote_owner");
      expect(auditEntries(sink, "member.removed")).toEqual([]);
    });
  });

  /**
   * R3/R4 — a membership whose joined documents are gone.
   *
   * The listing joins three collections; a membership row can outlive what it
   * references (a deleted account, a half-written provisioning). The row must
   * stay listed — one dangling reference may never drop a member or turn the
   * whole listing into a `5xx` — and the missing facts degrade to the §2.2
   * defaults the projection declares: a contact that masks to the fixed bullet
   * run, and an empty `displayName`.
   */
  describe("GET /api/v1/tenants/{tenantId}/members — a member missing a joined document", () => {
    /** The masked contact `maskEmail("")` produces (§0.13 fixed-width mask). */
    const FULLY_MASKED_CONTACT = "•••";

    it("keeps a member whose `user` document is gone listed, with the contact fully masked", async () => {
      const owner = await app.signIn(makeIdentity("rsvp-owner"));
      const member = await app.signIn(makeIdentity("maya-member"));
      const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
      await addMember(tenantId, member, "Priya Sharma");
      await app.db.collection(USER_COLLECTION).deleteOne({ _id: member.userId });

      const response = await listMembers(listRequest(owner.cookie, CURRENT_ALIAS));

      expect(response.status).toBe(200);
      const entries = (await body(response)).data as Record<string, unknown>[];
      // One dangling reference may never push a member out of the listing.
      expect(entries.map((entry) => entry.userId).sort()).toEqual(
        [member.userId.toHexString(), owner.userId.toHexString()].sort()
      );

      const memberEntry = entries.find((entry) => entry.userId === member.userId.toHexString());
      expect(memberEntry).toMatchObject({
        emailMasked: FULLY_MASKED_CONTACT,
        role: "member",
        status: "active",
        displayName: "Priya Sharma",
      });
      expect(Object.keys(memberEntry ?? {}).sort()).toEqual(MEMBER_DTO_KEYS);
    });

    it("keeps a member whose `userProfiles` document is gone listed, with an empty displayName", async () => {
      const owner = await app.signIn(makeIdentity("rsvp-owner"));
      const member = await app.signIn(makeIdentity("maya-member"));
      const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
      await addMember(tenantId, member, "Priya Sharma");
      await app.db.collection(COLLECTIONS.userProfiles).deleteOne({ userId: member.userId });

      const response = await listMembers(listRequest(owner.cookie, CURRENT_ALIAS));

      expect(response.status).toBe(200);
      const entries = (await body(response)).data as Record<string, unknown>[];
      expect(entries.map((entry) => entry.userId).sort()).toEqual(
        [member.userId.toHexString(), owner.userId.toHexString()].sort()
      );

      const memberEntry = entries.find((entry) => entry.userId === member.userId.toHexString());
      expect(memberEntry).toMatchObject({
        displayName: "",
        emailMasked: "m•••@example.com",
        role: "member",
        status: "active",
      });
      expect(Object.keys(memberEntry ?? {}).sort()).toEqual(MEMBER_DTO_KEYS);
    });
  });

  /**
   * R5 — a malformed `{userId}`.
   *
   * The target id is validated against `^[0-9a-f]{24}$/i` before it reaches
   * `new ObjectId()`. A shape outside it is `404 not_found`, so the endpoint
   * neither confirms ids it does not hold (§0.4) nor answers a `500` for a
   * client-supplied string, on either verb.
   */
  describe("/api/v1/tenants/{tenantId}/members/{userId} — a malformed target id", () => {
    it("answers 404 not_found on PATCH for a `{userId}` that is not 24 hex characters", async () => {
      const owner = await app.signIn(makeIdentity("rsvp-owner"));
      await seedWorkspace({ userId: owner.userId, role: "owner" });

      const response = await changeMemberRole(
        memberRequest(owner.cookie, CURRENT_ALIAS, "not-an-object-id", "PATCH", { role: "admin" })
      );

      expect(response.status).toBe(404);
      expect((await errorEnvelope(response)).code).toBe("not_found");
    });

    it("answers 404 not_found on DELETE for a 23-character `{userId}`", async () => {
      const owner = await app.signIn(makeIdentity("rsvp-owner"));
      await seedWorkspace({ userId: owner.userId, role: "owner" });

      // One hex digit short of an ObjectId: the shape check, not the lookup,
      // must deny it.
      const response = await removeMember(
        memberRequest(owner.cookie, CURRENT_ALIAS, "6b055762ace8c4d298b332f", "DELETE")
      );

      expect(response.status).toBe(404);
      expect((await errorEnvelope(response)).code).toBe("not_found");
    });
  });

  /**
   * R6 — a path with no usable tenant segment.
   *
   * The tenant stage locates the workspace by the segment after the literal
   * `tenants`; a path that has no such anchor yields a segment that cannot be a
   * workspace id, so the stage denies with the one uniform, logged `404`
   * (contract §0.4) instead of resolving some other workspace or answering
   * `500`. The denial is `warn`-logged as `tenancy.access_denied` and never
   * echoes `X-Tenant-Id`.
   *
   * ADR-0288 reports a documentation defect here rather than pinning it: the
   * doc comment on `tenantIdFromRequest` says such a path yields `""`, while the
   * code returns `segments[0]` (`"api"`). Only the observable below is pinned,
   * so either repair keeps this case green.
   */
  describe("GET /api/v1/tenants/{tenantId}/members — a path with no tenant anchor", () => {
    it("answers the uniform logged 404 and echoes no workspace id", async () => {
      const owner = await app.signIn(makeIdentity("rsvp-owner"));
      await seedWorkspace({ userId: owner.userId, role: "owner" });

      const sink = captureLogs();
      // No `tenants` segment exists, so there is no workspace to resolve.
      const response = await listMembers(
        new Request(new URL("/api/v1/members", APP_ORIGIN), {
          method: "GET",
          headers: { cookie: owner.cookie },
        })
      );

      expect(response.status).toBe(404);
      expect((await errorEnvelope(response)).code).toBe("not_found");
      expect(response.headers.get("x-tenant-id")).toBeNull();

      const denials = auditEntries(sink, "tenancy.access_denied");
      expect(denials).toHaveLength(1);
      // The reason is the stage's own classification; the pin is that the
      // uniform denial is logged at all, at warn level (§0.4).
      expect(denials[0]).toMatchObject({ level: "warn" });
    });
  });
});

/**
 * OP-101 / ADR-0970 — the **durable** audit record of a workspace-member
 * mutation (contract §2.2, schema §20.2/§22, ADR-0970 §D2/§D3/§D7, ADR-0971).
 *
 * The user story: *who changed this member's role, who removed them, and when* —
 * answerable for a full audit year. The two structured log lines the shipped
 * route emits are the operator's tail: no retention promise, no query surface and
 * no per-tenant index, which is why ADR-0288 R2 keeps pinning them above,
 * untouched. §20.2's `auditLogs` is the durable record, and at the head this
 * block was written nothing inserted into it — `git grep -n "auditLogs" --
 * apps/web/src` found the collection name and its TTL index and no writer.
 *
 * The observable is therefore the document itself, read through the same
 * platform handle the writer uses (`platformRepo(db).collection(
 * COLLECTIONS.auditLogs)`), never a route: `GET /admin/audit-logs` is
 * contract-only at this head (ADR-0970 §D5), so pinning a response would pin
 * something this repository does not have.
 *
 * ## Contract expected of the implementation (ADR-0970 §D2/§D3/§D7)
 *
 * - `PATCH` and `DELETE` each write **exactly one** row per successful call, and
 *   the row's key set is exactly the eight §D2 fields plus the driver's `_id`:
 *   `{ actor, action, target, tenantId, before, after, at, expireAt }`.
 * - `actor` is `{ kind: "user", id, ipHash, uaHash }` — the caller's principal
 *   id and **salted SHA-256 digests** of the request's IP and user agent, so no
 *   raw address and no raw agent is ever stored. `target` is
 *   `{ kind: "user", id: <target userId hex> }`, `tenantId` is the workspace
 *   **hex string** (the type §18.3's `domainEvents` uses), and `before`/`after`
 *   are narrowed to the field the verb changes: `{ role }` for
 *   `member.role_changed`, `{ status }` for `member.removed`.
 * - `expireAt` is exactly `400 * 24 * 60 * 60 * 1000` ms after `at` (§22).
 * - The row and the membership `updateOne` are **one transaction** (§D3): an
 *   insert failure aborts the mutation, answers the app-wide
 *   `500 internal_error`, and leaves the membership untouched — so a `200`/`204`
 *   is evidence that both writes committed, and a mutation nobody can attribute
 *   is never committed.
 *
 * ## What is RED at the branch point, and what is a control
 *
 * At the branch point nothing writes `audit_logs`, so `T1` and `T2` fail on
 * `toHaveLength(1)` against `[]`, and `T4`'s first half fails because the route
 * answers `200` and commits the membership. `T3`'s two refusal arms and `T4`'s
 * second half are **controls**: green on arrival, and every GREEN must keep them
 * green. `T4`'s second half is also the anti-vacuity guard for its first half —
 * a route that never writes a row cannot pass `T4`, because after the stub is
 * restored the same call must answer `200` and write exactly one row.
 *
 * ## Assumptions (recorded in ADR-0971)
 *
 * - **A1 — `actor.id` is the Better Auth `user._id` hex.** ADR-0970 §D2 writes
 *   `requestAuditActor(request, id)`; the route's only principal id is the
 *   session user's, which is the value every other tenancy row stores.
 * - **A2 — the fingerprints are asserted by shape, not by value.** §D2 fixes the
 *   digest (64-hex, salted) but not the salt's source, so these cases require a
 *   SHA-256 hex digest and the absence of the raw values, never a literal hash.
 * - **A3 — `at` is not pinned to an instant.** It is whatever the route's clock
 *   read; only its type and its exact distance to `expireAt` are pinned, so no
 *   case can flake on a millisecond boundary.
 * - **A4 — one row per successful call, not per state transition** (§D7): no
 *   case re-sends a mutation, so the accepted non-idempotence is neither pinned
 *   nor contradicted here.
 */
describe("OP-101 / ADR-0970 — the `auditLogs` row a workspace-member mutation writes", () => {
  /** §22 — the retention every row carries, exactly 400 days. */
  const FOUR_HUNDRED_DAYS_MS = 400 * 24 * 60 * 60 * 1000;

  /** The document's key set: the eight §D2 fields plus the driver's `_id`. */
  const AUDIT_ROW_KEYS = [
    "_id",
    "action",
    "actor",
    "after",
    "at",
    "before",
    "expireAt",
    "target",
    "tenantId",
  ];

  /** The `actor` sub-document's four keys (§D2). */
  const AUDIT_ACTOR_KEYS = ["id", "ipHash", "kind", "uaHash"];

  /** The `target` sub-document's two keys (§D2). */
  const AUDIT_TARGET_KEYS = ["id", "kind"];

  /** A 64-character lowercase hex digest — SHA-256, never a raw value. */
  const SHA256_HEX = /^[0-9a-f]{64}$/;

  /** The client address and user agent every mutation in this block presents. */
  const CALLER_IP = "198.51.100.24";
  const CALLER_USER_AGENT = "OpenPicMemberAudit/1.0 (ADR-0970 spec)";

  /**
   * The driver's own `Collection#insertOne`, resolved once when this block is
   * registered.
   *
   * The stub below must forward every other collection to the **real** method,
   * and reading `Collection.prototype.insertOne` at call time would find the
   * stub itself: an unbounded recursion answers a `RangeError`, which is also a
   * `500`, so `T4` would pass for the wrong reason
   * (`billing-checkout.test.ts:177` precedent).
   */
  const driverInsertOne = ((): typeof Collection.prototype.insertOne => {
    const descriptor = Object.getOwnPropertyDescriptor(Collection.prototype, "insertOne");
    if (descriptor === undefined || typeof descriptor.value !== "function") {
      throw new Error("expected Collection.prototype.insertOne to be a function");
    }
    return descriptor.value as typeof Collection.prototype.insertOne;
  })();

  /**
   * A `PATCH`/`DELETE /tenants/{tenantId}/members/{userId}` request that presents
   * a known IP and user agent, so the row's two digests are computed over values
   * the case can prove are absent from the document.
   */
  function mutationRequest(
    cookie: string,
    tenantId: string,
    userId: string,
    method: "PATCH" | "DELETE",
    payload?: unknown
  ): Request {
    const headers: Record<string, string> = {
      cookie,
      "user-agent": CALLER_USER_AGENT,
      "x-forwarded-for": CALLER_IP,
    };
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
    }
    return new Request(new URL(`${TENANTS_PATH}/${tenantId}/members/${userId}`, APP_ORIGIN), {
      method,
      headers,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  }

  /**
   * Every `auditLogs` document that names this workspace.
   *
   * The read matches the hex string **and** the `ObjectId`, so a row written with
   * the wrong `tenantId` type is still found and reds on the field assertion with
   * a message that names the drift — instead of making the case pass vacuously on
   * an empty list.
   */
  async function auditRows(tenantId: ObjectId): Promise<Document[]> {
    return platformRepo(app.db)
      .collection(COLLECTIONS.auditLogs)
      .find({ $or: [{ tenantId: tenantId.toHexString() }, { tenantId }] })
      .toArray();
  }

  /**
   * Assert the actor trio, the target pair and the workspace id every row
   * carries: exact keys, values by shape (§D2).
   */
  function expectActorTargetAndTenant(
    row: Record<string, unknown>,
    callerId: ObjectId,
    targetUserId: ObjectId,
    tenantId: ObjectId
  ): void {
    const actor = row.actor as Record<string, unknown>;
    expect(Object.keys(actor).sort()).toEqual(AUDIT_ACTOR_KEYS);
    expect(actor.kind).toBe("user");
    expect(actor.id).toBe(callerId.toHexString());
    expect(actor.ipHash).toMatch(SHA256_HEX);
    expect(actor.uaHash).toMatch(SHA256_HEX);

    const target = row.target as Record<string, unknown>;
    expect(Object.keys(target).sort()).toEqual(AUDIT_TARGET_KEYS);
    expect(target).toEqual({ kind: "user", id: targetUserId.toHexString() });

    expect(row.tenantId).toBe(tenantId.toHexString());
  }

  /** Assert the §22 retention: a real instant, and `expireAt` exactly 400 days on. */
  function expectRetention(row: Record<string, unknown>): void {
    expect(row.at).toBeInstanceOf(Date);
    expect(row.expireAt).toBeInstanceOf(Date);
    expect((row.expireAt as Date).getTime() - (row.at as Date).getTime()).toBe(
      FOUR_HUNDRED_DAYS_MS
    );
  }

  /**
   * T1 — the re-role's row.
   *
   * An owner promoting a `member` to `admin` is `200`, and the durable record of
   * that one call is one `member.role_changed` row naming the caller, the target,
   * the workspace, the role it moved from and the role it set, kept 400 days.
   */
  it("writes exactly one member.role_changed row when an owner re-roles a member", async () => {
    const owner = await app.signIn(makeIdentity("rsvp-owner"));
    const member = await app.signIn(makeIdentity("maya-member"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
    await addMember(tenantId, member, "Priya Sharma");

    const response = await changeMemberRole(
      mutationRequest(owner.cookie, CURRENT_ALIAS, member.userId.toHexString(), "PATCH", {
        role: "admin",
      })
    );

    expect(response.status).toBe(200);

    const rows = await auditRows(tenantId);
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;

    // §D2 fixes the key set exactly: an added `reason` or a dropped `before`
    // reds here, not in a later reader.
    expect(Object.keys(row).sort()).toEqual(AUDIT_ROW_KEYS);
    expect(row.action).toBe("member.role_changed");
    expectActorTargetAndTenant(row, owner.userId, member.userId, tenantId);
    expect(row.before).toEqual({ role: "member" });
    expect(row.after).toEqual({ role: "admin" });
    expectRetention(row);

    // §D2: the fingerprints are digests — the request's own values are never
    // stored, so a row cannot leak the caller's address or agent.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(CALLER_IP);
    expect(serialized).not.toContain(CALLER_USER_AGENT);

    // The other verb's action belongs to the other verb.
    expect(rows.filter((candidate) => candidate.action === "member.removed")).toEqual([]);
  });

  /**
   * T2 — the removal's row.
   *
   * A soft removal is `204` and writes one `member.removed` row with the same
   * actor, target and workspace keys, narrowed to the field the verb changes:
   * `before: { status: "active" }`, `after: { status: "removed" }`.
   */
  it("writes exactly one member.removed row when an owner removes a member", async () => {
    const owner = await app.signIn(makeIdentity("rsvp-owner"));
    const member = await app.signIn(makeIdentity("maya-member"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
    await addMember(tenantId, member, "Priya Sharma");

    const response = await removeMember(
      mutationRequest(owner.cookie, CURRENT_ALIAS, member.userId.toHexString(), "DELETE")
    );

    expect(response.status).toBe(204);

    const rows = await auditRows(tenantId);
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;

    expect(Object.keys(row).sort()).toEqual(AUDIT_ROW_KEYS);
    expect(row.action).toBe("member.removed");
    expectActorTargetAndTenant(row, owner.userId, member.userId, tenantId);
    expect(row.before).toEqual({ status: "active" });
    expect(row.after).toEqual({ status: "removed" });
    expectRetention(row);

    expect(rows.filter((candidate) => candidate.action === "member.role_changed")).toEqual([]);
  });

  /**
   * T3 (first arm) — a refused non-owner call writes nothing.
   *
   * The owner-only gate denies an `admin` caller on both verbs before any write,
   * so a refusal is total: no membership change (the shipped 403 cases) and no
   * audit row either. A row written before the gate — or in a `finally` — reds
   * here.
   */
  it("writes no row when a non-owner is refused on either verb", async () => {
    const owner = await app.signIn(makeIdentity("rsvp-owner"));
    const admin = await app.signIn(makeIdentity("dev-admin"));
    const target = await app.signIn(makeIdentity("maya-member"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
    await addMember(tenantId, admin, "Dev Admin", "admin");
    await addMember(tenantId, target, "Priya Sharma");

    const patched = await changeMemberRole(
      mutationRequest(admin.cookie, CURRENT_ALIAS, target.userId.toHexString(), "PATCH", {
        role: "admin",
      })
    );
    const deleted = await removeMember(
      mutationRequest(admin.cookie, CURRENT_ALIAS, target.userId.toHexString(), "DELETE")
    );

    expect(patched.status).toBe(403);
    expect((await errorEnvelope(patched)).code).toBe("forbidden");
    expect(deleted.status).toBe(403);
    expect((await errorEnvelope(deleted)).code).toBe("forbidden");

    expect(await auditRows(tenantId)).toEqual([]);
  });

  /**
   * T3 (second arm) — the owner-protection refusal writes nothing.
   *
   * §2.2's `409 cannot_demote_owner` protects the owner from their own removal.
   * The refusal happens before the transaction, so it must leave the workspace's
   * audit collection empty.
   */
  it("writes no row when the owner's own removal is refused", async () => {
    const owner = await app.signIn(makeIdentity("rsvp-owner"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });

    const response = await removeMember(
      mutationRequest(owner.cookie, CURRENT_ALIAS, owner.userId.toHexString(), "DELETE")
    );

    expect(response.status).toBe(409);
    expect((await errorEnvelope(response)).code).toBe("cannot_demote_owner");

    expect(await auditRows(tenantId)).toEqual([]);
  });

  /**
   * T4 — the row is written **inside the mutation's transaction** (§D3), the
   * load-bearing case.
   *
   * The audit insert is refused with a driver error that carries no
   * `TransientTransactionError` label (`code: 91`, a primary-election error that
   * `withTransaction` rethrows on the first attempt, so no retry can absorb it).
   * The mutation must therefore abort with the app-wide `500 internal_error`,
   * leaving the membership exactly as it was — same `role`, same `updatedAt` —
   * and no row at all: a mutation nobody can attribute is the failure mode the
   * row exists to prevent (§D3, §20.2 P5).
   *
   * The second half is the **anti-vacuity guard**: the stub is restored and the
   * same call is repeated, and it must answer `200` and write exactly one row.
   * Without it, a route that writes no row at all would pass the refusal half.
   */
  it("answers 500 and commits neither the role nor the row when the audit insert fails, then writes the row once the driver recovers", async () => {
    const owner = await app.signIn(makeIdentity("rsvp-owner"));
    const member = await app.signIn(makeIdentity("maya-member"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
    await addMember(tenantId, member, "Priya Sharma");

    // A pre-call `updatedAt` on the row, so "unchanged" is a claim a route that
    // really did commit would break.
    const preCallUpdatedAt = new Date("2026-05-05T06:07:08.900Z");
    await app.db
      .collection(COLLECTIONS.tenantMembers)
      .updateOne({ tenantId, userId: member.userId }, { $set: { updatedAt: preCallUpdatedAt } });
    const before = await findMembership(tenantId, member.userId);
    expect(before?.role).toBe("member");
    expect(before?.updatedAt).toEqual(preCallUpdatedAt);

    const driverError = Object.assign(new Error("not primary"), { code: 91 });
    const insertStub = vi.spyOn(Collection.prototype, "insertOne").mockImplementation(function (
      this: Collection,
      document: Document,
      options?: InsertOneOptions
    ) {
      if (this.collectionName === COLLECTIONS.auditLogs) {
        return Promise.reject(driverError);
      }
      return driverInsertOne.call(this, document, options);
    });

    let refused: Response;
    try {
      refused = await changeMemberRole(
        mutationRequest(owner.cookie, CURRENT_ALIAS, member.userId.toHexString(), "PATCH", {
          role: "admin",
        })
      );
    } finally {
      insertStub.mockRestore();
    }

    expect(refused.status).toBe(500);
    const error = (await errorEnvelope(refused)) as { code: string; details?: unknown };
    expect(error.code).toBe("internal_error");
    expect(error.details).toBeUndefined();

    // Nothing committed: the membership keeps its role and its instant, and the
    // workspace has no audit row.
    const after = await findMembership(tenantId, member.userId);
    expect(after?.role).toBe("member");
    expect(after?.updatedAt).toEqual(preCallUpdatedAt);
    expect(await auditRows(tenantId)).toEqual([]);

    // The anti-vacuity guard: the same call, with the driver healthy again, must
    // answer 200 and write exactly one row.
    const accepted = await changeMemberRole(
      mutationRequest(owner.cookie, CURRENT_ALIAS, member.userId.toHexString(), "PATCH", {
        role: "admin",
      })
    );

    expect(accepted.status).toBe(200);
    const rows = await auditRows(tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "member.role_changed",
      before: { role: "member" },
      after: { role: "admin" },
    });
  });

  /**
   * The driver's own `Collection#updateOne`, resolved once when this block is
   * registered.
   *
   * The reverse-direction stub below must forward every other collection to the
   * **real** method, and reading `Collection.prototype.updateOne` at call time
   * would find the stub itself: an unbounded recursion answers a `RangeError`,
   * which is also a `500`, so `R1`/`R2` would pass for the wrong reason.
   */
  const driverUpdateOne = ((): typeof Collection.prototype.updateOne => {
    const descriptor = Object.getOwnPropertyDescriptor(Collection.prototype, "updateOne");
    if (descriptor === undefined || typeof descriptor.value !== "function") {
      throw new Error("expected Collection.prototype.updateOne to be a function");
    }
    return descriptor.value as typeof Collection.prototype.updateOne;
  })();

  /** The driver's own `updateOne` argument tuple. */
  type DriverUpdateOneArgs = Parameters<typeof driverUpdateOne>;

  /**
   * The driver error every refused **membership** write in `R1`/`R2` carries.
   *
   * `code: 91` is a replica-set election and carries **no**
   * `TransientTransactionError` label, so `withTransaction` rethrows it on the
   * first attempt instead of letting a retry absorb it — the same choice `T4`
   * makes for the audit insert, in the opposite direction.
   */
  const membershipWriteError = Object.assign(new Error("injected failure: updateOne"), {
    code: 91,
  });

  /**
   * Refuse that request's membership write: every `updateOne` against
   * `tenantMembers` rejects, and every other collection is forwarded to the
   * driver.
   *
   * The **membership** write is what fails here, not the audit insert, so
   * whatever the route wrote into `audit_logs` must be gone when the
   * transaction aborts (§D3's reverse half).
   *
   * @returns The undo; call it in a `finally` so the stub cannot leak into a
   *   later case.
   */
  function refuseMembershipWrites(): () => void {
    const spy = vi.spyOn(Collection.prototype, "updateOne").mockImplementation(async function (
      this: Collection,
      ...args: DriverUpdateOneArgs
    ) {
      if (this.collectionName === COLLECTIONS.tenantMembers) {
        throw membershipWriteError;
      }
      return driverUpdateOne.call(this, ...args);
    } as never);
    return () => {
      spy.mockRestore();
    };
  }

  /**
   * R1 — the reverse half of §D3 for `PATCH`, the case `T4` does not cover.
   *
   * `T4` refuses the **audit** insert and requires the membership to stay put.
   * Here the **membership** write is refused instead, which is the only shape
   * that reds an implementation writing the audit row **outside** the
   * transaction: such a route answers the same `500` and leaves the membership
   * untouched, so `T4` stays green while an orphan row claims a change that
   * never committed.
   *
   * The route must answer `500 internal_error`, the membership must keep its
   * `role` **and** its pre-call `updatedAt`, and `audit_logs` must hold no row
   * for the workspace. The second half is the anti-vacuity guard: with the stub
   * restored the same call is repeated and must answer `200` and write exactly
   * one `member.role_changed` row, so a route that never writes a row at all
   * cannot pass either half. The measurement this case pins — the audit write
   * moved out of the transaction reds exactly here and nowhere else in the file
   * — is recorded in ADR-0974.
   */
  it("answers 500 and writes no row when the membership write fails on PATCH, then writes the member.role_changed row once the driver recovers", async () => {
    const owner = await app.signIn(makeIdentity("rsvp-owner"));
    const member = await app.signIn(makeIdentity("maya-member"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
    await addMember(tenantId, member, "Priya Sharma");

    // A pre-call `updatedAt`, so "unchanged" is a claim a route that really did
    // commit would break.
    const preCallUpdatedAt = new Date("2026-07-07T08:09:10.110Z");
    await app.db
      .collection(COLLECTIONS.tenantMembers)
      .updateOne({ tenantId, userId: member.userId }, { $set: { updatedAt: preCallUpdatedAt } });
    const before = await findMembership(tenantId, member.userId);
    expect(before?.role).toBe("member");
    expect(before?.updatedAt).toEqual(preCallUpdatedAt);

    const restore = refuseMembershipWrites();
    let refused: Response;
    try {
      refused = await changeMemberRole(
        mutationRequest(owner.cookie, CURRENT_ALIAS, member.userId.toHexString(), "PATCH", {
          role: "admin",
        })
      );
    } finally {
      restore();
    }

    expect(refused.status).toBe(500);
    expect((await errorEnvelope(refused)).code).toBe("internal_error");

    // Nothing committed: the membership keeps its role and its instant, and the
    // workspace has no audit row — an orphan row here is the defect this case
    // exists to catch.
    const after = await findMembership(tenantId, member.userId);
    expect(after?.role).toBe("member");
    expect(after?.updatedAt).toEqual(preCallUpdatedAt);
    expect(await auditRows(tenantId)).toEqual([]);

    // The anti-vacuity guard: the same call, with the driver healthy again,
    // must answer 200 and write exactly one row.
    const accepted = await changeMemberRole(
      mutationRequest(owner.cookie, CURRENT_ALIAS, member.userId.toHexString(), "PATCH", {
        role: "admin",
      })
    );

    expect(accepted.status).toBe(200);
    const rows = await auditRows(tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "member.role_changed" });
  });

  /**
   * R2 — the same reverse half for `DELETE`, the other verb `T4` never covered.
   *
   * A refused membership write must answer `500 internal_error`, leave the
   * membership `status: "active"` with its pre-call `updatedAt`, and leave
   * `audit_logs` empty for the workspace; with the stub restored the same call
   * must answer `204` and write exactly one `member.removed` row.
   */
  it("answers 500 and writes no row when the membership write fails on DELETE, then writes the member.removed row once the driver recovers", async () => {
    const owner = await app.signIn(makeIdentity("rsvp-owner"));
    const member = await app.signIn(makeIdentity("maya-member"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });
    await addMember(tenantId, member, "Priya Sharma");

    const preCallUpdatedAt = new Date("2026-07-08T09:10:11.220Z");
    await app.db
      .collection(COLLECTIONS.tenantMembers)
      .updateOne({ tenantId, userId: member.userId }, { $set: { updatedAt: preCallUpdatedAt } });
    const before = await findMembership(tenantId, member.userId);
    expect(before?.status).toBe("active");
    expect(before?.updatedAt).toEqual(preCallUpdatedAt);

    const restore = refuseMembershipWrites();
    let refused: Response;
    try {
      refused = await removeMember(
        mutationRequest(owner.cookie, CURRENT_ALIAS, member.userId.toHexString(), "DELETE")
      );
    } finally {
      restore();
    }

    expect(refused.status).toBe(500);
    expect((await errorEnvelope(refused)).code).toBe("internal_error");

    const after = await findMembership(tenantId, member.userId);
    expect(after?.status).toBe("active");
    expect(after?.updatedAt).toEqual(preCallUpdatedAt);
    expect(await auditRows(tenantId)).toEqual([]);

    // The anti-vacuity guard for this verb.
    const accepted = await removeMember(
      mutationRequest(owner.cookie, CURRENT_ALIAS, member.userId.toHexString(), "DELETE")
    );

    expect(accepted.status).toBe(204);
    const rows = await auditRows(tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "member.removed" });
  });
});
