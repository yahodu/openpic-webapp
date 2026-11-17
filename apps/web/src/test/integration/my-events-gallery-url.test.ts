import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";

import {
  claimBodyOf,
  claimSession,
  createBoundAttendeeSession,
  myEvents,
  myEventsBodyOf,
  seedProfile,
} from "../helpers/attendee-claim-flow";
import { makeIdentity, startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { nextIp, seedTenant, type SeededEvent } from "../helpers/selfie-flow";

/**
 * Integration / contract — `galleryUrl` on the two §6.7 surfaces for an event
 * with **no active access link** (OP-134 F4; contract §6.7; ADR-0819).
 *
 * **Why this exists.** §6.7 has two answers that describe the *same*
 * participation: the list (`GET /api/v1/me/events`) and the claim
 * (`POST /api/v1/me/attendee-sessions:claim`). A review of the shipped lane
 * measured them disagreeing on one fixture — a caller's own profile whose
 * event carries no `active: true` access link — where the claim answers
 * `galleryUrl: ""` and the list answers `"/e//gallery"`, which is not a URL at
 * all and would send the browser to the wrong route.
 *
 * The pin therefore fixes **one** representation — the empty string, the one
 * §6.7's claim already ships — and asserts it on the list. `slug` stays `""` in
 * the same answer: it is the raw active slug and §6.7 does not invent one.
 *
 * ## Contract expected of the implementation
 *
 * - `GET /me/events` item for an event with no `active: true` access link:
 *   `slug === ""` **and** `galleryUrl === ""`.
 * - The same item for an event **with** an active link: `slug === <slug>` and
 *   `galleryUrl === "/e/{slug}/gallery"`, identical to the claim's
 *   `claimed[].galleryUrl` for that event. The control case exists so a fix
 *   cannot pass by emptying every `galleryUrl`.
 * - The claim's answer is not to be changed: it already answers `""` for the
 *   same fixture, and that is the representation the list adopts.
 *
 * ## Why the fixture is seeded, not driven
 *
 * No shipped route produces a participation on an event with no active access
 * link: the event is created with one active link and consent/upload resolve
 * the event **through** it (§1.5). The state the review measured is therefore
 * reached by seeding the profile and, where a session is needed, creating the
 * real session first and deactivating the link afterwards — the same
 * "re-point the row, keep everything else" shape that the claim itself
 * understands.
 */

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op134-f4-gallery-url" });
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

/** One seeded tenant with one published event (which starts with an active link). */
async function tenantEvent(prefix: string): Promise<{
  readonly tenantKey: string;
  readonly event: SeededEvent;
}> {
  const seeded = await seedTenant(app, prefix);
  const event = seeded.events[0];
  if (event === undefined) {
    throw new Error("expected one seeded event");
  }
  return { tenantKey: seeded.tenantKey, event };
}

/** Replace an event's access links, so the fixture states the link state a case needs. */
async function setAccessLinks(event: SeededEvent, links: readonly unknown[]): Promise<void> {
  const result = await app.db
    .collection(COLLECTIONS.events)
    .updateOne({ _id: event.id }, { $set: { accessLinks: links } });
  if (result.matchedCount !== 1) {
    throw new Error("expected the seeded event to exist");
  }
}

/** The single item of a one-event list, failing loudly when the list is not one item. */
function singleItem(body: Awaited<ReturnType<typeof myEventsBodyOf>>): {
  readonly slug: string;
  readonly galleryUrl: string;
} {
  const [item] = body.data;
  if (item === undefined) {
    throw new Error("expected the caller's event in the list");
  }
  return item;
}

describe("when the caller's event has no active access link", () => {
  it("F4: lists galleryUrl as an empty string, the representation the claim gives", async () => {
    // Arrange — the caller owns a profile on an event whose accessLinks is empty,
    // i.e. every link was revoked. This is the exact fixture the review measured.
    const { tenantKey, event } = await tenantEvent("op134-f4-empty");
    await setAccessLinks(event, []);
    const user = await app.signIn(makeIdentity("op134-f4-empty-user"));
    await seedProfile(app, {
      tenantKey,
      eventId: event.id,
      subject: { kind: "user", userId: user.userId },
    });

    // Act
    const response = await myEvents({ cookie: user.cookie, ip: nextIp() });
    const body = await myEventsBodyOf(response);

    // Assert — `slug` is the raw active slug, and there is none.
    const item = singleItem(body);
    expect(item.slug).toBe("");

    // Assert — §6.7 shows a path only when the gallery is reachable, so an event
    // with no active link answers the empty string, never "/e//gallery".
    expect(item.galleryUrl).toBe("");
  });

  it("F4: lists galleryUrl as an empty string when the only access link is dead", async () => {
    // Arrange — one rotated-away link. `active: false` is a link an attendee can
    // no longer reach, so it cannot be the gallery's path either.
    const { tenantKey, event } = await tenantEvent("op134-f4-dead");
    await setAccessLinks(event, [
      {
        slug: event.slug,
        active: false,
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        revokedAt: new Date("2026-01-03T00:00:00.000Z"),
        scanCount: 0,
      },
    ]);
    const user = await app.signIn(makeIdentity("op134-f4-dead-user"));
    await seedProfile(app, {
      tenantKey,
      eventId: event.id,
      subject: { kind: "user", userId: user.userId },
    });

    // Act
    const response = await myEvents({ cookie: user.cookie, ip: nextIp() });
    const body = await myEventsBodyOf(response);

    // Assert
    const item = singleItem(body);
    expect(item.slug).toBe("");
    expect(item.galleryUrl).toBe("");
  });

  it("F4: the claim answers galleryUrl as an empty string for the same fixture", async () => {
    // Arrange — a real anonymous session on an event whose link is then revoked,
    // and the anonymous profile that session owns. This is the claim's own view
    // of the state the two cases above put the list in, so it records which
    // representation the list has to adopt.
    const { tenantKey, event } = await tenantEvent("op134-f4-claim");
    const session = await createBoundAttendeeSession(app, event.slug);
    await seedProfile(app, {
      tenantKey,
      eventId: event.id,
      subject: { kind: "anonymous", attendeeSessionId: session.sessionId },
    });
    await setAccessLinks(event, []);
    const user = await app.signIn(makeIdentity("op134-f4-claim-user"));

    // Act
    const response = await claimSession({
      cookie: user.cookie,
      ip: nextIp(),
      sessionToken: session.token,
    });
    const body = await claimBodyOf(response);

    // Assert — one claimed event, and its gallery path is the empty string.
    const [claimed] = body.claimed;
    if (claimed === undefined) {
      throw new Error("expected the claim to report the session's event");
    }
    expect(claimed.eventId).toBe(event.id.toHexString());
    expect(claimed.galleryUrl).toBe("");
  });
});

describe("when the caller's event has an active access link", () => {
  it("F4 control: the list and the claim both answer /e/{slug}/gallery", async () => {
    // Arrange — the shipped fixture: one active link, a real anonymous session
    // bound to it and the anonymous profile behind it.
    const { tenantKey, event } = await tenantEvent("op134-f4-control");
    const session = await createBoundAttendeeSession(app, event.slug);
    await seedProfile(app, {
      tenantKey,
      eventId: event.id,
      subject: { kind: "anonymous", attendeeSessionId: session.sessionId },
    });
    const user = await app.signIn(makeIdentity("op134-f4-control-user"));
    const expected = `/e/${event.slug}/gallery`;

    // Act — the claim re-points the very row the list then has to describe.
    const claimResponse = await claimSession({
      cookie: user.cookie,
      ip: nextIp(),
      sessionToken: session.token,
    });
    const claim = await claimBodyOf(claimResponse);

    // Assert — both §6.7 surfaces agree on the reachable gallery's path.
    const [claimed] = claim.claimed;
    if (claimed === undefined) {
      throw new Error("expected the claim to report the session's event");
    }
    expect(claimed.galleryUrl).toBe(expected);

    const listResponse = await myEvents({ cookie: user.cookie, ip: nextIp() });
    const list = await myEventsBodyOf(listResponse);
    const item = singleItem(list);
    expect(item.slug).toBe(event.slug);
    expect(item.galleryUrl).toBe(expected);
  });
});
