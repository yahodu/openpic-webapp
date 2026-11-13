import { type ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import {
  createLogger,
  getLogger,
  memoryTransport,
  setLogger,
  type MemoryTransport,
} from "@/server/logging";

import {
  allProfiles,
  claimBodyOf,
  claimSession,
  createBoundAttendeeSession,
  lapseSession,
  readSessionRow,
  seedProfile,
  seedSelfie,
  selfieIds,
  type ClaimProfileRow,
} from "../helpers/attendee-claim-flow";
import { makeIdentity, startTestApp, type TestApp } from "../helpers/authed-app";
import { setCookies } from "../helpers/auth-requests";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import {
  errorBody,
  grantConsent,
  nextIp,
  outboxLength,
  seedTenant,
  submitHappyPath,
} from "../helpers/selfie-flow";

/**
 * Integration / contract — claiming an anonymous attendee session (OP-134 I1,
 * I2, I4, I7; contract §6.7, §0.12; schema §13.5, §15.3; ADR-0813).
 *
 * **Why this exists.** §6.7 is the PRD's *"she doesn't have to re-visit and
 * re-upload"*. Its whole value is that a claim **moves no data**: the profile
 * row keeps its `_id`, its `matchCount`, its `selfies` and its `faceMatches`;
 * only `subject` changes, in one atomic write per profile, and the matcher is
 * never re-armed. Three regressions are cheap to write and expensive to live
 * with, and each has a case here:
 *
 * - a "claim" implemented as delete-and-recreate (new profile id, new selfie,
 *   new match run) — passes a status-code eye test, destroys the attendee's
 *   gallery;
 * - a claim that also enqueues `q:selfie`, so every sign-in costs a face
 *   embedding;
 * - a claim by a **second** account on a session that is already spoken for —
 *   the worst outcome, because the second account would then see the first
 *   person's matched photos.
 *
 * ## Contract expected of the implementation
 *
 * ```ts
 * // apps/web/src/app/api/v1/me/attendee-sessions:claim/route.ts
 * export const POST: (request: Request) => Promise<Response>;
 * ```
 *
 * - Auth `user` (contract §0.2, Appendix D "Claim anonymous session" = identified
 *   attendee only). A caller with no session cookie is `401
 *   authentication_required`.
 * - Body `{sessionToken?: string}`; when absent, the `op_att` cookie names the
 *   session.
 * - `200 { claimed: [{eventId, eventName, profileId, matchCount, galleryUrl}],
 *   skipped: [{eventId, reason: "already_claimed_by_this_user"}] }` — exactly the
 *   two documented keys.
 * - Per anonymous profile of that session, one atomic update: `subject.kind`
 *   `anonymous` → `user`, `subject.userId` = the caller, `subject.attendeeSessionId`
 *   unset, `claimedAt` set (schema §15.3's `updateOne`).
 * - `409 session_claimed_by_other_user` when `attendeeSessions.claimedByUserId`
 *   already names a different user. Nothing is re-pointed.
 * - `401 attendee_session_expired` past the 30-day TTL (§13.5).
 * - The response clears `op_att` (§6.7 "Also clears the `op_att` cookie").
 * - One `attendee.event.linked` domain event **per claimed event** (§6.7; the
 *   key is already in `NOTIFICATION_TYPE_KEYS`, in-app only).
 * - `info` log `attendee.claimed` carrying the counts (green card §1).
 *
 * ## Assumptions (recorded in ADR-0813)
 *
 * - `claimed[]` lists only events whose profile was **re-pointed**; an event the
 *   caller already owns is reported in `skipped[]` and nowhere else.
 * - A claim on a session that is already claimed by *this* user is a no-op
 *   `200` (nothing left to re-point), not an error.
 * - The claim walks the **profiles** whose `subject.attendeeSessionId` is this
 *   session, not `attendeeSessions.eventIds`: §6.7 says "every
 *   `attendeeEventProfiles` row", and a profile can exist for an event the
 *   session was never explicitly bound to (the attendee reached that event's
 *   page holding the cookie she already had).
 */

let app: TestApp;

/** A stored `selfies` row, as these cases read it (§16.4). */
interface SelfieRow {
  readonly _id: ObjectId;
  readonly profileId: ObjectId;
  readonly subject: Record<string, unknown>;
}

beforeAll(async () => {
  app = await startTestApp({ prefix: "op134-claim" });
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

/** Install a capturing logger and return its transport. */
function installMemoryLogger(): MemoryTransport {
  const sink = memoryTransport();
  setLogger(
    createLogger({
      level: "info",
      transports: [sink],
      service: "openpic-web",
      env: "test",
      version: "test-sha",
    })
  );
  return sink;
}

/** A seeded tenant and its one event, asserting the fixture built what a case needs. */
async function seededEvent(prefix: string): Promise<{
  readonly tenantKey: string;
  readonly eventId: ObjectId;
  readonly slug: string;
  readonly name: string;
}> {
  const { tenantKey, events } = await seedTenant(app, prefix);
  const event = events[0];
  if (event === undefined) {
    throw new Error("expected one seeded event");
  }
  return { tenantKey, eventId: event.id, slug: event.slug, name: event.name };
}

/** A seeded tenant and its events, asserting the fixture built what a case needs. */
async function seededEvents(
  prefix: string,
  count: number
): Promise<{
  readonly tenantKey: string;
  readonly events: readonly {
    readonly eventId: ObjectId;
    readonly slug: string;
    readonly name: string;
  }[];
}> {
  const { tenantKey, events } = await seedTenant(app, prefix, count);
  if (events.length !== count) {
    throw new Error(`expected ${String(count)} seeded events`);
  }
  return {
    tenantKey,
    events: events.map((event) => ({ eventId: event.id, slug: event.slug, name: event.name })),
  };
}

/** Read the stored selfies of one case. */
async function selfieRows(): Promise<SelfieRow[]> {
  return (await app.db.collection("selfies").find({}).toArray()) as unknown as SelfieRow[];
}

/** A stored `domain_events` row, reduced to what these cases read (§18.3). */
interface DomainEventRow {
  readonly eventKey: string;
  readonly tenantId: string;
  readonly subjectRef: { readonly kind: string; readonly id: string };
}

/** The `attendee.event.linked` rows the claim wrote — one per claimed event. */
async function linkedEvents(): Promise<DomainEventRow[]> {
  return (await app.db
    .collection(COLLECTIONS.domainEvents)
    .find({ eventKey: "attendee.event.linked" })
    .toArray()) as unknown as DomainEventRow[];
}

/** The single stored profile of a fixture, failing loudly when it is not single. */
function singleProfile(rows: readonly ClaimProfileRow[]): ClaimProfileRow {
  const [profile] = rows;
  if (profile === undefined) {
    throw new Error("expected exactly one attendee profile");
  }
  return profile;
}

describe("when an attendee claims an anonymous session", () => {
  it("I1: re-points the profile, keeps every selfie id and enqueues no reprocessing", async () => {
    // Arrange — a real anonymous attendance: consent created the profile, the
    // selfie route stored the selfie and enqueued exactly one embed job.
    const event = await seededEvent("op134-i1");
    const session = await createBoundAttendeeSession(app, event.slug);
    await grantConsent(event.slug, { cookie: session.cookie, ip: nextIp() });
    const submitted = await submitHappyPath(event.slug, {
      cookie: session.cookie,
      ip: nextIp(),
      tag: "op134-i1",
    });
    const before = await allProfiles(app);
    expect(before).toHaveLength(1);
    const profileBefore = singleProfile(before);
    expect(profileBefore._id.toHexString()).toBe(submitted.profileId);
    expect(profileBefore.subject).toEqual({
      kind: "anonymous",
      attendeeSessionId: session.sessionId,
    });
    // A sign-in **without** the op_att cookie must not claim anything, so the
    // claim below is the only thing that can move the row.
    const user = await app.signIn(makeIdentity("op134-i1-user"));
    expect((await readSessionRow(app, session.token)).claimedByUserId ?? null).toBeNull();

    // Act
    const previousLogger = getLogger();
    const sink = installMemoryLogger();
    const queuedBefore = outboxLength();
    const response = await claimSession({
      cookie: user.cookie,
      ip: nextIp(),
      sessionToken: session.token,
    });
    const body = await claimBodyOf(response);
    const queuedAfter = outboxLength();
    setLogger(previousLogger);

    // Assert — the response names the event and the row it re-pointed.
    expect(Object.keys(body).sort()).toEqual(["claimed", "skipped"]);
    expect(body.claimed).toHaveLength(1);
    expect(body.claimed[0]).toEqual({
      eventId: event.eventId.toHexString(),
      eventName: event.name,
      profileId: profileBefore._id.toHexString(),
      matchCount: 0,
      galleryUrl: `/e/${event.slug}/gallery`,
    });
    expect(body.skipped).toEqual([]);

    // Assert — "no data moves": same row, same id, same selfie, same matches.
    const after = await allProfiles(app);
    expect(after).toHaveLength(1);
    const profileAfter = singleProfile(after);
    expect(profileAfter._id.toHexString()).toBe(profileBefore._id.toHexString());
    expect(profileAfter.subject).toEqual({ kind: "user", userId: user.userId });
    expect(Object.keys(profileAfter.subject).sort()).toEqual(["kind", "userId"]);
    expect(profileAfter.claimedAt).toBeInstanceOf(Date);

    const selfies = await selfieRows();
    expect(selfies).toHaveLength(1);
    const [selfie] = selfies;
    if (selfie === undefined) {
      throw new Error("expected the anonymous submit to store one selfie");
    }
    expect(selfie._id.toHexString()).toBe(submitted.selfieId);
    expect(selfie.profileId.toHexString()).toBe(submitted.profileId);
    expect(await selfieIds(app)).toEqual([submitted.selfieId]);

    // Assert — no reprocessing: the claim enqueued nothing.
    expect(queuedAfter).toBe(queuedBefore);

    // Assert — §6.7's confirmation event, once, about the caller.
    const linked = await linkedEvents();
    expect(linked).toHaveLength(1);
    expect(linked[0]?.subjectRef.id).toBe(user.userId.toHexString());
    expect(linked[0]?.tenantId).toBe(event.tenantKey);

    // Assert — the session itself records who claimed it (§13.5).
    const sessionRow = await readSessionRow(app, session.token);
    expect(sessionRow.claimedByUserId).toEqual(user.userId);
    expect(sessionRow.claimedAt).toBeInstanceOf(Date);

    // Assert — the green card requires an info record with the counts.
    const record = sink.entries.find((entry) => entry.event === "attendee.claimed");
    expect(record?.level).toBe("info");
    expect(record?.claimed).toBe(1);
    expect(record?.skipped).toBe(0);
    // The raw bearer token is never logged (§0.15).
    expect(JSON.stringify(sink.entries)).not.toContain(session.token);
  });

  it("I1: one call re-points every profile of the session, across two events", async () => {
    // Arrange — one browser, one `op_att` cookie, two events. The attendee
    // visited the second event's page with the cookie she already held, which
    // does not re-issue the session, so both profiles carry this session id
    // while the session's own `eventIds` names only the first (§13.5).
    const seeded = await seededEvents("op134-i1-two", 2);
    const [first, second] = seeded.events;
    if (first === undefined || second === undefined) {
      throw new Error("expected two seeded events");
    }
    const session = await createBoundAttendeeSession(app, first.slug);
    const subject = { kind: "anonymous", attendeeSessionId: session.sessionId };
    const firstProfileId = await seedProfile(app, {
      tenantKey: seeded.tenantKey,
      eventId: first.eventId,
      subject,
    });
    const secondProfileId = await seedProfile(app, {
      tenantKey: seeded.tenantKey,
      eventId: second.eventId,
      subject,
    });
    const user = await app.signIn(makeIdentity("op134-i1-two-user"));

    // Act — the browser holds both cookies; the body carries no token, so the
    // `op_att` cookie is what names the session.
    const queuedBefore = outboxLength();
    const body = await claimBodyOf(
      await claimSession({ cookie: `${user.cookie}; ${session.cookie}`, ip: nextIp() })
    );
    const queuedAfter = outboxLength();

    // Assert — both events are claimed, each naming its own profile row.
    expect(body.skipped).toEqual([]);
    expect(body.claimed.map((claimed) => claimed.eventId).sort()).toEqual(
      [first.eventId.toHexString(), second.eventId.toHexString()].sort()
    );
    const byEvent = new Map(body.claimed.map((claimed) => [claimed.eventId, claimed.profileId]));
    expect(byEvent.get(first.eventId.toHexString())).toBe(firstProfileId.toHexString());
    expect(byEvent.get(second.eventId.toHexString())).toBe(secondProfileId.toHexString());
    expect(body.claimed.map((claimed) => claimed.eventName).sort()).toEqual(
      [first.name, second.name].sort()
    );

    // Assert — "every row": both profiles now belong to the caller, and the
    // anonymous subject is gone from each.
    const rows = await allProfiles(app);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.subject)).toEqual([
      { kind: "user", userId: user.userId },
      { kind: "user", userId: user.userId },
    ]);
    expect(rows.map((row) => row.claimedAt !== undefined && row.claimedAt !== null)).toEqual([
      true,
      true,
    ]);

    // Assert — no reprocessing, and the session is spoken for once.
    expect(queuedAfter).toBe(queuedBefore);
    expect((await readSessionRow(app, session.token)).claimedByUserId).toEqual(user.userId);

    // Assert — §6.7's event is emitted **per claimed event**, not once per call.
    const linked = await linkedEvents();
    expect(linked).toHaveLength(2);
    expect(linked.map((row) => row.subjectRef.id)).toEqual([
      user.userId.toHexString(),
      user.userId.toHexString(),
    ]);
  });
});

describe("when a session is already spoken for", () => {
  it("I2: a second user claiming the same session is refused with 409 session_claimed_by_other_user", async () => {
    // Arrange — an anonymous profile, claimed once by the first account.
    const event = await seededEvent("op134-i2");
    const session = await createBoundAttendeeSession(app, event.slug);
    const profileId = await seedProfile(app, {
      tenantKey: event.tenantKey,
      eventId: event.eventId,
      subject: { kind: "anonymous", attendeeSessionId: session.sessionId },
    });
    const first = await app.signIn(makeIdentity("op134-i2-first"));
    await claimBodyOf(
      await claimSession({ cookie: first.cookie, ip: nextIp(), sessionToken: session.token })
    );
    const second = await app.signIn(makeIdentity("op134-i2-second"));

    // Act
    const response = await claimSession({
      cookie: second.cookie,
      ip: nextIp(),
      sessionToken: session.token,
    });

    // Assert — the catalogue code, not a generic 409.
    expect(response.status).toBe(409);
    expect((await errorBody(response)).code).toBe("session_claimed_by_other_user");

    // Assert — nothing moved: the profile still belongs to the first account and
    // the second account owns no profile at all.
    const rows = await allProfiles(app);
    expect(rows).toHaveLength(1);
    expect(singleProfile(rows)._id.toHexString()).toBe(profileId.toHexString());
    expect(singleProfile(rows).subject).toEqual({ kind: "user", userId: first.userId });
    expect(rows.map((row) => row.subject.userId)).toEqual([first.userId]);
  });

  it("I2: a repeat claim by the same user answers 200 and claims nothing further", async () => {
    // Arrange — the caller claims the session once.
    const event = await seededEvent("op134-i2-again");
    const session = await createBoundAttendeeSession(app, event.slug);
    await seedProfile(app, {
      tenantKey: event.tenantKey,
      eventId: event.eventId,
      subject: { kind: "anonymous", attendeeSessionId: session.sessionId },
    });
    const user = await app.signIn(makeIdentity("op134-i2-again-user"));
    const firstBody = await claimBodyOf(
      await claimSession({ cookie: user.cookie, ip: nextIp(), sessionToken: session.token })
    );
    expect(firstBody.claimed).toHaveLength(1);

    // Act — the same account claims the same session again. A `409` belongs to
    // a **different** user; the owner calling twice is a no-op.
    const response = await claimSession({
      cookie: user.cookie,
      ip: nextIp(),
      sessionToken: session.token,
    });

    // Assert — `200` with nothing left to re-point, and nothing moved.
    expect(response.status).toBe(200);
    const secondBody = await claimBodyOf(response);
    expect(secondBody.claimed).toEqual([]);

    const rows = await allProfiles(app);
    expect(rows).toHaveLength(1);
    expect(singleProfile(rows).subject).toEqual({ kind: "user", userId: user.userId });
    expect((await readSessionRow(app, session.token)).claimedByUserId).toEqual(user.userId);
  });

  it("I2: a lapsed session is refused with 401 attendee_session_expired", async () => {
    // Arrange — past the 30-day TTL (§13.5); the TTL monitor has not swept it yet.
    const event = await seededEvent("op134-i2-expired");
    const session = await createBoundAttendeeSession(app, event.slug);
    await seedProfile(app, {
      tenantKey: event.tenantKey,
      eventId: event.eventId,
      subject: { kind: "anonymous", attendeeSessionId: session.sessionId },
    });
    await lapseSession(app, session.token);
    const user = await app.signIn(makeIdentity("op134-i2-expired-user"));

    // Act
    const response = await claimSession({
      cookie: user.cookie,
      ip: nextIp(),
      sessionToken: session.token,
    });

    // Assert — a lapsed session is an actionable 401, not a silent no-op.
    expect(response.status).toBe(401);
    expect((await errorBody(response)).code).toBe("attendee_session_expired");
    const rows = await allProfiles(app);
    expect(singleProfile(rows).subject).toEqual({
      kind: "anonymous",
      attendeeSessionId: session.sessionId,
    });
  });

  it("I2: a caller with no credential is refused with 401 authentication_required", async () => {
    // Arrange — the session exists, but the request carries no user session.
    const event = await seededEvent("op134-i2-anon");
    const session = await createBoundAttendeeSession(app, event.slug);
    await seedProfile(app, {
      tenantKey: event.tenantKey,
      eventId: event.eventId,
      subject: { kind: "anonymous", attendeeSessionId: session.sessionId },
    });

    // Act — only the anonymous credential, which cannot claim itself.
    const response = await claimSession({ cookie: session.cookie, ip: nextIp() });

    // Assert — Appendix D: "Claim anonymous session" is identified-attendee only.
    expect(response.status).toBe(401);
    expect((await errorBody(response)).code).toBe("authentication_required");
  });
});

describe("when the claim answers", () => {
  it("I4: the response clears the op_att cookie", async () => {
    // Arrange — the session is named by the cookie alone (no body field).
    const event = await seededEvent("op134-i4");
    const session = await createBoundAttendeeSession(app, event.slug);
    await seedProfile(app, {
      tenantKey: event.tenantKey,
      eventId: event.eventId,
      subject: { kind: "anonymous", attendeeSessionId: session.sessionId },
    });
    const user = await app.signIn(makeIdentity("op134-i4-user"));

    // Act
    const response = await claimSession({
      cookie: `${user.cookie}; ${session.cookie}`,
      ip: nextIp(),
    });

    // Assert — §6.7 "Also clears the op_att cookie": an expired cookie with an
    // empty value, not merely an absent one (a browser keeps an unset cookie).
    await claimBodyOf(response);
    const cleared = setCookies(response).find((cookie) => cookie.startsWith("op_att="));
    expect(cleared).toBeDefined();
    expect(cleared?.split(";")[0]).toBe("op_att=");
    expect(cleared?.toLowerCase()).toContain("max-age=0");
    expect(cleared?.toLowerCase()).toContain("path=/");
    expect(cleared).toContain("HttpOnly");
    expect(cleared).toContain("SameSite=Lax");
  });
});

describe("when the user already owns a profile for the event", () => {
  it("I7: the event is skipped and the newer anonymous selfie is adopted", async () => {
    // Arrange — the caller already has a profile here, and the anonymous upload
    // is the more recent face photo.
    const event = await seededEvent("op134-i7-newer");
    const session = await createBoundAttendeeSession(app, event.slug);
    const user = await app.signIn(makeIdentity("op134-i7-newer-user"));
    const older = new Date("2027-01-01T09:00:00.000Z");
    const newer = new Date("2027-01-02T09:00:00.000Z");

    const userProfileId = await seedProfile(app, {
      tenantKey: event.tenantKey,
      eventId: event.eventId,
      subject: { kind: "user", userId: user.userId },
      matchCount: 4,
    });
    const existingSelfieId = await seedSelfie(app, {
      tenantKey: event.tenantKey,
      eventId: event.eventId,
      profileId: userProfileId,
      subject: { kind: "user", userId: user.userId },
      createdAt: older,
    });
    await app.db
      .collection(COLLECTIONS.attendeeEventProfiles)
      .updateOne({ _id: userProfileId }, { $set: { activeSelfieId: existingSelfieId } });

    const anonymousProfileId = await seedProfile(app, {
      tenantKey: event.tenantKey,
      eventId: event.eventId,
      subject: { kind: "anonymous", attendeeSessionId: session.sessionId },
    });
    const anonymousSelfieId = await seedSelfie(app, {
      tenantKey: event.tenantKey,
      eventId: event.eventId,
      profileId: anonymousProfileId,
      subject: { kind: "anonymous", attendeeSessionId: session.sessionId },
      createdAt: newer,
    });
    await app.db
      .collection(COLLECTIONS.attendeeEventProfiles)
      .updateOne({ _id: anonymousProfileId }, { $set: { activeSelfieId: anonymousSelfieId } });
    const selfiesBefore = await selfieIds(app);

    // Act
    const queuedBefore = outboxLength();
    const body = await claimBodyOf(
      await claimSession({ cookie: user.cookie, ip: nextIp(), sessionToken: session.token })
    );
    const queuedAfter = outboxLength();

    // Assert — nothing was re-pointed; the event is reported as skipped.
    expect(body.claimed).toEqual([]);
    expect(body.skipped).toEqual([
      { eventId: event.eventId.toHexString(), reason: "already_claimed_by_this_user" },
    ]);

    // Assert — the documented merge rule: keep the newest active selfie.
    const rows = await allProfiles(app);
    expect(rows).toHaveLength(2);
    const userRow = rows.find((row) => row._id.toHexString() === userProfileId.toHexString());
    const anonymousRow = rows.find(
      (row) => row._id.toHexString() === anonymousProfileId.toHexString()
    );
    expect(userRow?.activeSelfieId?.toHexString()).toBe(anonymousSelfieId.toHexString());
    expect(userRow?.subject).toEqual({ kind: "user", userId: user.userId });
    // The anonymous row is untouched: a re-point would collide with the unique
    // partial index on `{eventId, "subject.userId"}`.
    expect(anonymousRow?.subject).toEqual({
      kind: "anonymous",
      attendeeSessionId: session.sessionId,
    });

    // Assert — no selfie was replaced or deleted, and nothing was reprocessed.
    expect(await selfieIds(app)).toEqual(selfiesBefore);
    expect(queuedAfter).toBe(queuedBefore);

    // Assert — the session is spoken for, so a later claim cannot steal it.
    expect((await readSessionRow(app, session.token)).claimedByUserId).toEqual(user.userId);
  });

  it("I7: the user's own newer selfie is kept", async () => {
    // Arrange — the mirror image: the account's own photo is the newer one.
    const event = await seededEvent("op134-i7-older");
    const session = await createBoundAttendeeSession(app, event.slug);
    const user = await app.signIn(makeIdentity("op134-i7-older-user"));
    const older = new Date("2027-01-01T09:00:00.000Z");
    const newer = new Date("2027-01-02T09:00:00.000Z");

    const userProfileId = await seedProfile(app, {
      tenantKey: event.tenantKey,
      eventId: event.eventId,
      subject: { kind: "user", userId: user.userId },
    });
    const existingSelfieId = await seedSelfie(app, {
      tenantKey: event.tenantKey,
      eventId: event.eventId,
      profileId: userProfileId,
      subject: { kind: "user", userId: user.userId },
      createdAt: newer,
    });
    await app.db
      .collection(COLLECTIONS.attendeeEventProfiles)
      .updateOne({ _id: userProfileId }, { $set: { activeSelfieId: existingSelfieId } });

    const anonymousProfileId = await seedProfile(app, {
      tenantKey: event.tenantKey,
      eventId: event.eventId,
      subject: { kind: "anonymous", attendeeSessionId: session.sessionId },
    });
    const anonymousSelfieId = await seedSelfie(app, {
      tenantKey: event.tenantKey,
      eventId: event.eventId,
      profileId: anonymousProfileId,
      subject: { kind: "anonymous", attendeeSessionId: session.sessionId },
      createdAt: older,
    });
    await app.db
      .collection(COLLECTIONS.attendeeEventProfiles)
      .updateOne({ _id: anonymousProfileId }, { $set: { activeSelfieId: anonymousSelfieId } });

    // Act
    const body = await claimBodyOf(
      await claimSession({ cookie: user.cookie, ip: nextIp(), sessionToken: session.token })
    );

    // Assert — the older anonymous selfie does not displace the newer one.
    expect(body.claimed).toEqual([]);
    expect(body.skipped).toEqual([
      { eventId: event.eventId.toHexString(), reason: "already_claimed_by_this_user" },
    ]);
    const rows = await allProfiles(app);
    const userRow = rows.find((row) => row._id.toHexString() === userProfileId.toHexString());
    expect(userRow?.activeSelfieId?.toHexString()).toBe(existingSelfieId.toHexString());
  });
});
