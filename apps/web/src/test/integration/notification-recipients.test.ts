import { ObjectId, type Db } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { closeMongoClient } from "@/server/db/mongo";
import { mongoRecipientRepository } from "@/server/repos/notification-recipients";

import {
  createTestDb,
  MONGO_READY_HOOK_TIMEOUT_MS,
  setupMongoTestEnv,
  type TestDb,
} from "../helpers/db";

/**
 * Integration / contract — the Mongo-backed `RecipientRepository`
 * (`@/server/repos/notification-recipients`, OP-94 §2, ADR-0090, ADR-0106 §5).
 *
 * The fan-out resolves its audience at send time through the injected
 * `RecipientRepository` port; this is the production implementation of that
 * port. Until this spec it had no direct pin (ADR-0106 "Coverage gap"), so each
 * audience read is exercised here against a real replica set:
 *
 *   - `organizer` / `co_organizer` → active `eventMembers` for the event, plus
 *     pending/accepted `event_co_organizer` `invitations` (the invitee has no
 *     membership row yet), for the invitee only.
 *   - `attendee_identified` → `attendeeEventProfiles` whose `subject.kind` is
 *     `user`; a cookie-bound uploader is unreachable.
 *   - `billing_contact` → the tenant's `billingContactUserId`.
 *   - `platform_admin` → active `userProfiles` with `platformRole: "admin"`.
 *
 * Tenant-scoped ids are stored as `ObjectId`s by some writers and as hex strings
 * by others, so every id filter must match either form. A missing collection or
 * field must yield no recipients, never a crash.
 */

/** The event membership collection name (design §15.2; not in `COLLECTIONS` yet). */
const EVENT_MEMBERS = "eventMembers";
/** The tenant collection name (schema §13.3). */
const TENANTS = "tenants";

beforeAll(async () => {
  await setupMongoTestEnv();
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await closeMongoClient();
});

/** Run `fn` against a fresh throwaway database, always dropping it. */
async function withTestDb(fn: (test: TestDb) => Promise<void>): Promise<void> {
  const test = createTestDb("openpic_notification_recipients");
  try {
    await fn(test);
  } finally {
    await test.cleanup();
  }
}

/** A fresh hex id (the stored ids are ObjectIds). */
function hex(): string {
  return new ObjectId().toHexString();
}

/** Insert documents one by one (`db` here is a plain handle, not a tenant scope). */
async function insert(
  database: Db,
  collection: string,
  docs: readonly Record<string, unknown>[]
): Promise<void> {
  for (const doc of docs) {
    await database.collection(collection).insertOne(doc);
  }
}

/** Compare recipients as a set, since the repo's read order is unspecified. */
function expectIds(actual: readonly string[], expected: readonly string[]): void {
  expect(new Set(actual)).toEqual(new Set(expected));
}

describe("mongoRecipientRepository — organizer / co-organizer (event members)", () => {
  it("returns the event's active organizers, matching ids stored as ObjectId or string", async () => {
    await withTestDb(async (test) => {
      const tenantId = hex();
      const eventId = hex();
      const organizerObjectId = hex();
      const organizerString = hex();

      await insert(test.db, EVENT_MEMBERS, [
        // The same tenant/event written two ways: ObjectId-stored and string-stored.
        {
          tenantId: new ObjectId(tenantId),
          eventId: new ObjectId(eventId),
          role: "organizer",
          status: "active",
          userId: new ObjectId(organizerObjectId),
        },
        {
          tenantId,
          eventId,
          role: "organizer",
          status: "active",
          userId: organizerString,
        },
        // A removed membership is not a recipient.
        { tenantId, eventId, role: "organizer", status: "removed", userId: hex() },
        // A different role requested for a co-organizer audience.
        { tenantId, eventId, role: "co_organizer", status: "active", userId: hex() },
        // A different event / tenant.
        { tenantId, eventId: hex(), role: "organizer", status: "active", userId: hex() },
        { tenantId: hex(), eventId, role: "organizer", status: "active", userId: hex() },
      ]);

      const repository = mongoRecipientRepository(test.db);
      const recipients = await repository.listEventRoleMembers({
        tenantId,
        eventId,
        roles: ["organizer"],
      });

      expectIds(recipients, [organizerObjectId, organizerString]);
    });
  });

  it("adds pending and accepted co-organizer invitations, reaching the invitee", async () => {
    await withTestDb(async (test) => {
      const tenantId = hex();
      const eventId = hex();
      const coOrganizer = hex();
      const pendingInvitee = hex();
      const acceptedInvitee = hex();

      await insert(test.db, EVENT_MEMBERS, [
        { tenantId, eventId, role: "co_organizer", status: "active", userId: coOrganizer },
      ]);
      await insert(test.db, COLLECTIONS.invitations, [
        {
          tenantId,
          eventId,
          kind: "event_co_organizer",
          status: "pending",
          invitee: { userId: new ObjectId(pendingInvitee) },
        },
        {
          tenantId,
          eventId,
          kind: "event_co_organizer",
          status: "accepted",
          invitee: { userId: acceptedInvitee },
        },
        // Declined/revoked invitations are not recipients.
        {
          tenantId,
          eventId,
          kind: "event_co_organizer",
          status: "declined",
          invitee: { userId: hex() },
        },
        // A non-co-organizer invitation kind is never read for this audience.
        {
          tenantId,
          eventId,
          kind: "tenant_member",
          status: "pending",
          invitee: { userId: hex() },
        },
      ]);

      const repository = mongoRecipientRepository(test.db);
      const recipients = await repository.listEventRoleMembers({
        tenantId,
        eventId,
        roles: ["co_organizer"],
      });

      expectIds(recipients, [coOrganizer, pendingInvitee, acceptedInvitee]);
    });
  });

  it("does not read co-organizer invitations for an organizer-only audience", async () => {
    await withTestDb(async (test) => {
      const tenantId = hex();
      const eventId = hex();
      const invitee = hex();
      await insert(test.db, COLLECTIONS.invitations, [
        {
          tenantId,
          eventId,
          kind: "event_co_organizer",
          status: "pending",
          invitee: { userId: invitee },
        },
      ]);

      const repository = mongoRecipientRepository(test.db);
      const recipients = await repository.listEventRoleMembers({
        tenantId,
        eventId,
        roles: ["organizer"],
      });

      expect(recipients).toEqual([]);
    });
  });
});

describe("mongoRecipientRepository — identified attendees", () => {
  it("returns identified attendee user ids and never a cookie-bound uploader", async () => {
    await withTestDb(async (test) => {
      const tenantId = hex();
      const eventId = hex();
      const attendeeObjectId = hex();
      const attendeeString = hex();

      await insert(test.db, COLLECTIONS.attendeeEventProfiles, [
        {
          tenantId,
          eventId,
          subject: { kind: "user", userId: new ObjectId(attendeeObjectId) },
        },
        { tenantId, eventId, subject: { kind: "user", userId: attendeeString } },
        // An anonymous, cookie-bound uploader has no reachable account.
        { tenantId, eventId, subject: { kind: "cookie", userId: hex() } },
        { tenantId, eventId, subject: { kind: "anonymous" } },
        // A different event / tenant.
        { tenantId, eventId: hex(), subject: { kind: "user", userId: hex() } },
        { tenantId: hex(), eventId, subject: { kind: "user", userId: hex() } },
      ]);

      const repository = mongoRecipientRepository(test.db);
      const recipients = await repository.listIdentifiedAttendeeUserIds({ tenantId, eventId });

      expectIds(recipients, [attendeeObjectId, attendeeString]);
    });
  });
});

describe("mongoRecipientRepository — billing contact", () => {
  it("returns the tenant's billing contact stored as an ObjectId", async () => {
    await withTestDb(async (test) => {
      const tenantId = hex();
      const billing = hex();
      await insert(test.db, TENANTS, [
        { _id: new ObjectId(tenantId), billingContactUserId: new ObjectId(billing) },
      ]);

      const repository = mongoRecipientRepository(test.db);

      await expect(repository.getBillingContactUserId({ tenantId })).resolves.toBe(billing);
    });
  });

  it("returns the tenant's billing contact stored as a hex string", async () => {
    await withTestDb(async (test) => {
      const tenantId = hex();
      const billing = hex();
      await insert(test.db, TENANTS, [{ _id: tenantId, billingContactUserId: billing }]);

      const repository = mongoRecipientRepository(test.db);

      await expect(repository.getBillingContactUserId({ tenantId })).resolves.toBe(billing);
    });
  });

  it("returns null when the tenant has no billing contact or does not exist", async () => {
    await withTestDb(async (test) => {
      const tenantId = hex();
      await insert(test.db, TENANTS, [{ _id: new ObjectId(tenantId), name: "no billing contact" }]);

      const repository = mongoRecipientRepository(test.db);

      await expect(repository.getBillingContactUserId({ tenantId })).resolves.toBeNull();
      await expect(repository.getBillingContactUserId({ tenantId: hex() })).resolves.toBeNull();
    });
  });
});

describe("mongoRecipientRepository — platform admins", () => {
  it("returns active platform admins only", async () => {
    await withTestDb(async (test) => {
      const adminObjectId = hex();
      const adminString = hex();

      await insert(test.db, COLLECTIONS.userProfiles, [
        { userId: new ObjectId(adminObjectId), platformRole: "admin", status: "active" },
        { userId: adminString, platformRole: "admin", status: "active" },
        // A suspended admin is not a recipient, and a client is not an admin.
        { userId: hex(), platformRole: "admin", status: "suspended" },
        { userId: hex(), platformRole: "client", status: "active" },
      ]);

      const repository = mongoRecipientRepository(test.db);
      const recipients = await repository.listPlatformAdminUserIds();

      expectIds(recipients, [adminObjectId, adminString]);
    });
  });
});

describe("mongoRecipientRepository — resilience", () => {
  it("yields no recipients when the collections are empty rather than crashing", async () => {
    await withTestDb(async (test) => {
      const repository = mongoRecipientRepository(test.db);

      await expect(
        repository.listEventRoleMembers({
          tenantId: hex(),
          eventId: hex(),
          roles: ["organizer", "co_organizer"],
        })
      ).resolves.toEqual([]);
      await expect(
        repository.listIdentifiedAttendeeUserIds({ tenantId: hex(), eventId: hex() })
      ).resolves.toEqual([]);
      await expect(repository.getBillingContactUserId({ tenantId: hex() })).resolves.toBeNull();
      await expect(repository.listPlatformAdminUserIds()).resolves.toEqual([]);
    });
  });

  it("skips rows whose id field is missing rather than crashing", async () => {
    await withTestDb(async (test) => {
      const tenantId = hex();
      const eventId = hex();
      await insert(test.db, EVENT_MEMBERS, [
        { tenantId, eventId, role: "organizer", status: "active" },
      ]);
      await insert(test.db, COLLECTIONS.invitations, [
        { tenantId, eventId, kind: "event_co_organizer", status: "accepted", invitee: {} },
      ]);
      await insert(test.db, COLLECTIONS.attendeeEventProfiles, [
        { tenantId, eventId, subject: { kind: "user" } },
      ]);
      await insert(test.db, TENANTS, [{ _id: new ObjectId(tenantId) }]);
      await insert(test.db, COLLECTIONS.userProfiles, [
        { platformRole: "admin", status: "active" },
      ]);

      const repository = mongoRecipientRepository(test.db);

      await expect(
        repository.listEventRoleMembers({
          tenantId,
          eventId,
          roles: ["organizer", "co_organizer"],
        })
      ).resolves.toEqual([]);
      await expect(
        repository.listIdentifiedAttendeeUserIds({ tenantId, eventId })
      ).resolves.toEqual([]);
      await expect(repository.getBillingContactUserId({ tenantId })).resolves.toBeNull();
      await expect(repository.listPlatformAdminUserIds()).resolves.toEqual([]);
    });
  });
});
