import type { Document, WithId } from "mongodb";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findForbiddenFields } from "@openpic/contracts";

import {
  DELETE as removeMember,
  PATCH as changeMemberRole,
} from "@/app/api/v1/tenants/[tenantId]/members/[userId]/route";
import { GET as listMembers } from "@/app/api/v1/tenants/[tenantId]/members/route";
import { GET as tenantGet } from "@/app/api/v1/tenants/[tenantId]/route";
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
    const owner = await app.signIn(makeIdentity("rsvp-owner"));
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });

    const response = await listMembers(
      new Request(new URL(`${TENANTS_PATH}/${CURRENT_ALIAS}/members`, APP_ORIGIN), {
        method: "GET",
      })
    );

    expect(response.status).toBe(401);
    expect((await errorEnvelope(response)).code).toBe("authentication_required");
    expect(tenantId).toBeInstanceOf(ObjectId);
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
    "forbids a %s from changing another member's role (owner only)",
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
    const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner" });

    const response = await changeMemberRole(
      memberRequest(owner.cookie, CURRENT_ALIAS, new ObjectId().toHexString(), "PATCH", {
        role: "admin",
      })
    );

    expect(response.status).toBe(404);
    expect((await errorEnvelope(response)).code).toBe("not_found");
    expect(tenantId).toBeInstanceOf(ObjectId);
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
