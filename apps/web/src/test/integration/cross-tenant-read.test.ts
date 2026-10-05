import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { COLLECTIONS } from "../../server/db/collections";
import { closeMongoClient } from "../../server/db/mongo";
import { crossTenantReads } from "../../server/repos";
import {
  MONGO_READY_HOOK_TIMEOUT_MS,
  createTestDb,
  setupMongoTestEnv,
  type TestDb,
} from "../helpers/db";

/**
 * Integration contract — the single whitelisted cross-tenant read (OP-77,
 * schema §10.3; API contract §6.7 `GET /api/v1/me/events`).
 *
 * An attendee is a data subject whose data lives inside several tenants'
 * boundaries, so "all my events" is the one legitimate cross-tenant query. It
 * must return *every* profile whose `subject.userId` is the caller — across any
 * number of tenants — and *never* a row belonging to anybody else, no matter
 * how the caller pages.
 *
 *   crossTenantReads.findAttendeeProfilesBySubjectUser(userId, page, db?):
 *     Promise<{ items: AttendeeProfileDto[] }>
 *   page = { limit?: number; offset?: number }
 *
 * `COLLECTIONS.attendeeEventProfiles` is the registry key for the collection
 * (schema §12, collection 14); the DTOs it returns carry a string `id` and no
 * `_id`.
 *
 * Cases: I2 the caller's rows across three tenants, and never another user's
 * rows even with crafted pagination.
 */
const PROFILES_COLLECTION = (COLLECTIONS as unknown as { readonly attendeeEventProfiles: string })
  .attendeeEventProfiles;

/**
 * The projection these specs assert on. `items` are DTOs (see `toDto`): a
 * string `id` and no `_id`.
 */
interface AttendeeProfileDto {
  readonly id: string;
  readonly tenantId: string;
  readonly subject?: { readonly userId?: string };
}

/** Narrow the module-owned page result to the fields under test. */
function itemsOf(page: {
  readonly items: readonly AttendeeProfileDto[];
}): readonly AttendeeProfileDto[] {
  return page.items;
}

beforeAll(async () => {
  await setupMongoTestEnv();
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await closeMongoClient();
});

/** Run `fn` against a fresh throwaway database, always dropping it. */
async function withTestDb(fn: (test: TestDb) => Promise<void>): Promise<void> {
  const test = createTestDb("openpic_cross_tenant");
  try {
    await fn(test);
  } finally {
    await test.cleanup();
  }
}

/** Seed three tenants; `user-1` participates in all three, `user-2` in two. */
async function seedProfiles(test: TestDb): Promise<Record<string, string>> {
  const profiles = test.db.collection(PROFILES_COLLECTION);
  const inserted = await profiles.insertMany([
    {
      tenantId: "tenant-1",
      eventId: "event-1",
      subject: { kind: "user", userId: "user-1" },
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    {
      tenantId: "tenant-1",
      eventId: "event-1",
      subject: { kind: "user", userId: "user-2" },
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    },
    {
      tenantId: "tenant-2",
      eventId: "event-2",
      subject: { kind: "user", userId: "user-1" },
      updatedAt: new Date("2026-01-03T00:00:00.000Z"),
    },
    {
      tenantId: "tenant-3",
      eventId: "event-3",
      subject: { kind: "user", userId: "user-1" },
      updatedAt: new Date("2026-01-04T00:00:00.000Z"),
    },
    {
      tenantId: "tenant-3",
      eventId: "event-3",
      subject: { kind: "user", userId: "user-2" },
      updatedAt: new Date("2026-01-05T00:00:00.000Z"),
    },
  ]);

  const asHex = (value: unknown): string => String(value);
  return {
    user1Tenant1: asHex(inserted.insertedIds[0]),
    user2Tenant1: asHex(inserted.insertedIds[1]),
    user1Tenant2: asHex(inserted.insertedIds[2]),
    user1Tenant3: asHex(inserted.insertedIds[3]),
    user2Tenant3: asHex(inserted.insertedIds[4]),
  };
}

describe("crossTenantReads.findAttendeeProfilesBySubjectUser", () => {
  it("I2: the attendeeEventProfiles collection is registered", () => {
    expect(PROFILES_COLLECTION).toBeDefined();
  });

  it("I2: returns every profile for the caller across tenants and nothing else", async () => {
    await withTestDb(async (test) => {
      const ids = await seedProfiles(test);

      const page = await crossTenantReads.findAttendeeProfilesBySubjectUser(
        "user-1",
        { limit: 100, offset: 0 },
        test.db
      );

      const returned = itemsOf(page)
        .map((item) => item.id)
        .sort();
      expect(returned).toEqual([ids.user1Tenant1, ids.user1Tenant2, ids.user1Tenant3].sort());
      expect(itemsOf(page).every((item) => item.subject?.userId === "user-1")).toBe(true);
      expect(new Set(itemsOf(page).map((item) => item.tenantId)).size).toBe(3);
      expect(returned).not.toContain(ids.user2Tenant1);
      expect(returned).not.toContain(ids.user2Tenant3);
    });
  });

  it("I2: returns DTOs that expose a string id and no _id", async () => {
    await withTestDb(async (test) => {
      await seedProfiles(test);

      const page = await crossTenantReads.findAttendeeProfilesBySubjectUser(
        "user-1",
        { limit: 1, offset: 0 },
        test.db
      );

      const first = itemsOf(page)[0];
      expect(typeof first?.id).toBe("string");
      expect(Object.prototype.hasOwnProperty.call(first, "_id")).toBe(false);
    });
  });

  it("I2: crafted pagination never reveals another user's rows", async () => {
    await withTestDb(async (test) => {
      const ids = await seedProfiles(test);

      const firstPage = await crossTenantReads.findAttendeeProfilesBySubjectUser(
        "user-1",
        { limit: 2, offset: 0 },
        test.db
      );
      const secondPage = await crossTenantReads.findAttendeeProfilesBySubjectUser(
        "user-1",
        { limit: 2, offset: 2 },
        test.db
      );
      const farPage = await crossTenantReads.findAttendeeProfilesBySubjectUser(
        "user-1",
        { limit: 100, offset: 50 },
        test.db
      );

      const paged = [...itemsOf(firstPage), ...itemsOf(secondPage)];
      expect(paged.every((item) => item.subject?.userId === "user-1")).toBe(true);
      expect(paged.map((item) => item.id).sort()).toEqual(
        [ids.user1Tenant1, ids.user1Tenant2, ids.user1Tenant3].sort()
      );
      expect(itemsOf(farPage)).toEqual([]);
    });
  });

  it("I2: with no page argument returns every matching profile (no implicit limit)", async () => {
    await withTestDb(async (test) => {
      const profiles = test.db.collection(PROFILES_COLLECTION);
      const mine = Array.from({ length: 30 }, (_value, index) => ({
        tenantId: `tenant-${String((index % 3) + 1)}`,
        eventId: `event-${String(index)}`,
        subject: { kind: "user", userId: "user-1" },
        updatedAt: new Date("2026-02-01T00:00:00.000Z"),
      }));
      const theirs = Array.from({ length: 3 }, (_value, index) => ({
        tenantId: `tenant-${String((index % 3) + 1)}`,
        eventId: `other-${String(index)}`,
        subject: { kind: "user", userId: "user-2" },
        updatedAt: new Date("2026-02-01T00:00:00.000Z"),
      }));
      await profiles.insertMany([...mine, ...theirs]);

      const page = await crossTenantReads.findAttendeeProfilesBySubjectUser(
        "user-1",
        undefined,
        test.db
      );

      expect(itemsOf(page)).toHaveLength(30);
      expect(itemsOf(page).every((item) => item.subject?.userId === "user-1")).toBe(true);
    });
  });

  it("I2: orders by ascending _id so paging is stable and non-overlapping", async () => {
    await withTestDb(async (test) => {
      const ids = await seedProfiles(test);
      // user-1's rows were inserted at indices 0, 2 and 3, so ascending _id order
      // is exactly the insertion order of those three.
      const ordered = [ids.user1Tenant1, ids.user1Tenant2, ids.user1Tenant3];

      const all = await crossTenantReads.findAttendeeProfilesBySubjectUser(
        "user-1",
        { limit: 100 },
        test.db
      );
      expect(itemsOf(all).map((item) => item.id)).toEqual(ordered);

      const first = await crossTenantReads.findAttendeeProfilesBySubjectUser(
        "user-1",
        { limit: 1, offset: 0 },
        test.db
      );
      const second = await crossTenantReads.findAttendeeProfilesBySubjectUser(
        "user-1",
        { limit: 1, offset: 1 },
        test.db
      );
      const third = await crossTenantReads.findAttendeeProfilesBySubjectUser(
        "user-1",
        { limit: 1, offset: 2 },
        test.db
      );

      const flat = [...itemsOf(first), ...itemsOf(second), ...itemsOf(third)].map(
        (item) => item.id
      );
      expect(flat).toEqual(ordered);
      expect(new Set(flat).size).toBe(3);
    });
  });

  it("I2: an offset without a limit skips rows and returns the remainder", async () => {
    await withTestDb(async (test) => {
      const ids = await seedProfiles(test);

      const page = await crossTenantReads.findAttendeeProfilesBySubjectUser(
        "user-1",
        { offset: 1 },
        test.db
      );

      expect(itemsOf(page).map((item) => item.id)).toEqual([ids.user1Tenant2, ids.user1Tenant3]);
    });
  });
});
