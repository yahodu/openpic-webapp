import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { crossTenantReads } from "@/server/repos";

import { startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { grantConsent, nextIp, seedTenant, submitHappyPath } from "../helpers/selfie-flow";

/**
 * Integration / contract — a signed-in attendee's submit
 * (OP-132 I13; contract §6.3, §6.7 `GET /me/events`, §0.2 `attendee`; schema
 * §15.3, §16.4; green card §3).
 *
 * **Why this exists.** The same selfie route serves two very different
 * callers: an anonymous visitor holding an `op_att` cookie, and a signed-in
 * user whose account should own the resulting profile. The difference is not
 * cosmetic — §15.3 makes `subject` the profile's identity (and the unique
 * partial index on `{eventId, "subject.userId"}` the dedupe key), and §6.7's
 * `/me/events` is "the single whitelisted cross-tenant read" that finds a
 * user's attendee events **by `subject.userId`**. If a logged-in submit wrote
 * an anonymous profile, that attendee's event would never appear in their
 * account.
 *
 * ## Contract expected of the implementation
 *
 * - A submit authenticated by a `user` session creates (or reuses) the
 *   `attendeeEventProfiles` row with `subject: {kind: "user", userId: <caller>}`
 *   — no `attendeeSessionId` key at all — and the stored `selfies` row carries
 *   the same `subject`.
 * - The profile is visible **immediately**: no claim step, no later
 *   projection. `crossTenantReads.findAttendeeProfilesBySubjectUser` (the one
 *   repository function §6.7 permits to cross tenants, and the function
 *   `/me/events` is built on) returns it as soon as the `202` has been served.
 *
 * ## Assumptions (recorded in the lane ADR)
 *
 * - **`GET /api/v1/me/events` itself is OP-134's route** and does not exist
 *   yet, so "shows it right away" is pinned at the shipped whitelisted read
 *   this card's write must satisfy. When OP-134 lands, its own spec covers the
 *   HTTP projection; this one locks the write side that makes it true.
 * - The consent used here is the signed-in caller's own (§6.2's `attendee`
 *   label admits a user principal), so no anonymous session exists and the
 *   profile cannot legitimately be anonymous.
 */

let app: TestApp;

/** The sorted keys a `user`-subject profile carries (§10.3, §15.3). */
const USER_SUBJECT_KEYS = ["kind", "userId"];

/** A stored `attendee_event_profiles` row, as these cases read it (§15.3). */
interface ProfileRow {
  readonly _id: ObjectId;
  readonly status: string;
  readonly subject: Record<string, unknown>;
}

/** A stored `selfies` row, as these cases read it (§16.4). */
interface SelfieRow {
  readonly _id: ObjectId;
  readonly profileId: ObjectId;
  readonly subject: Record<string, unknown>;
}

beforeAll(async () => {
  app = await startTestApp({ prefix: "op132-user" });
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

beforeEach(async () => {
  for (const name of [
    COLLECTIONS.events,
    COLLECTIONS.eventOrganizers,
    COLLECTIONS.tenants,
    COLLECTIONS.tenantMembers,
    COLLECTIONS.userProfiles,
    COLLECTIONS.mediaAssets,
    COLLECTIONS.attendeeSessions,
    COLLECTIONS.attendeeEventProfiles,
    COLLECTIONS.faceMatches,
    COLLECTIONS.domainEvents,
    COLLECTIONS.idempotencyKeys,
    "consents",
    "selfies",
  ]) {
    await app.db.collection(name).deleteMany({});
  }
});

/** The stored attendee-event profiles. */
async function profileRows(): Promise<ProfileRow[]> {
  return (await app.db
    .collection(COLLECTIONS.attendeeEventProfiles)
    .find({})
    .toArray()) as unknown as ProfileRow[];
}

describe("when a signed-in user submits a selfie", () => {
  it("creates a user-subject profile that the my-events read returns immediately", async () => {
    const { owner, events } = await seedTenant(app, "op132-i13");
    const [event] = events;
    if (event === undefined) {
      throw new Error("expected one seeded event");
    }
    const ip = nextIp();
    await grantConsent(event.slug, { cookie: owner.cookie, ip });

    const submitted = await submitHappyPath(event.slug, {
      cookie: owner.cookie,
      ip,
      tag: "i13",
    });

    const rows = await profileRows();
    expect(rows).toHaveLength(1);
    const [profile] = rows;
    if (profile === undefined) {
      throw new Error("expected the submit to create the attendee profile");
    }
    expect(profile._id.toHexString()).toBe(submitted.profileId);
    expect(profile.subject).toEqual({
      kind: "user",
      userId: owner.userId,
    });
    expect(Object.keys(profile.subject).sort()).toEqual(USER_SUBJECT_KEYS);
    // `attendeeEventProfiles.status` is the §15.3 union, `processing` after a
    // submit that is waiting on the worker.
    expect(profile.status).toBe("processing");

    // §6.7: the whitelisted cross-tenant read is what `/me/events` projects,
    // and it must see the row the `202` just created — no claim, no delay.
    const mine = await crossTenantReads.findAttendeeProfilesBySubjectUser(
      owner.userId.toHexString(),
      {},
      app.db
    );
    expect(mine.items.map((item) => item.id)).toEqual([submitted.profileId]);
  });

  it("stamps the stored selfie with the same user subject and no anonymous session id", async () => {
    const { owner, events } = await seedTenant(app, "op132-i13b");
    const [event] = events;
    if (event === undefined) {
      throw new Error("expected one seeded event");
    }
    const ip = nextIp();
    await grantConsent(event.slug, { cookie: owner.cookie, ip });

    const submitted = await submitHappyPath(event.slug, {
      cookie: owner.cookie,
      ip,
      tag: "i13b",
    });

    const selfies = (await app.db
      .collection("selfies")
      .find({})
      .toArray()) as unknown as SelfieRow[];
    expect(selfies).toHaveLength(1);
    const [selfie] = selfies;
    if (selfie === undefined) {
      throw new Error("expected the submit to store a selfie");
    }
    expect(selfie._id.toHexString()).toBe(submitted.selfieId);
    expect(selfie.profileId.toHexString()).toBe(submitted.profileId);
    expect(selfie.subject).toEqual({ kind: "user", userId: owner.userId });
    expect(selfie.subject).not.toHaveProperty("attendeeSessionId");
  });
});
