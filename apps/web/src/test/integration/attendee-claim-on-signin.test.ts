import { type ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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

import {
  allProfiles,
  claimBodyOf,
  claimSession,
  createBoundAttendeeSession,
  myEvents,
  myEventsBodyOf,
  readSessionRow,
  seedProfile,
  selfieIds,
} from "../helpers/attendee-claim-flow";
import { makeIdentity, startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { grantConsent, nextIp, seedTenant, submitHappyPath } from "../helpers/selfie-flow";

/**
 * Integration / contract — the claim that happens **at sign-in** (OP-134 I5, I6;
 * contract §6.7, §1.1 "session created" hook; schema §13.5; ADR-0811, ADR-0040 §5).
 *
 * **Why this exists.** The explicit `POST /me/attendee-sessions:claim` is the
 * contract's endpoint, but it is not the path a real attendee takes: she uploads
 * a selfie, sees her photos, then signs in from the same browser — which is still
 * holding the `op_att` cookie. If the claim only ran on the explicit endpoint,
 * that attendee would sign in and find an **empty** "my events" list, with her
 * photos apparently gone. That is the exact experience the PRD's _"she doesn't
 * have to re-visit and re-upload"_ exists to prevent.
 *
 * §1.1's session-created hook is therefore the real claim trigger, and it
 * already carries the seam: `handleSessionCreated` reads the raw `op_att` cookie
 * from the auth request and calls the injected `ClaimAttendeeSession`
 * (`@/server/auth/identity-hooks`, ADR-0040 §5). Until now that seam was wired to
 * a no-op; OP-134 wires the real service.
 *
 * ## Contract expected of the implementation
 *
 * - A sign-in whose request carries `op_att` claims that session for the user who
 *   just signed in, before the sign-in response is served. The profile becomes
 *   `subject: {kind: "user", userId}`, the selfie is untouched, and no matcher run
 *   is enqueued.
 * - A sign-in whose request carries an `op_att` cookie that is **already claimed
 *   by somebody else** still succeeds (`200`, a real session cookie) and claims
 *   nothing. It records **one `warn`-level log entry with `event:
 *   "attendee.claim_conflict"`**, because a second account presenting a token
 *   that belongs to a data subject's face photos is a security signal, not a
 *   routine skip — and the cookie's owner must never be readable through the
 *   second account.
 * - The raw bearer token never reaches a log record (§0.15).
 *
 * ## Assumptions (recorded in ADR-0811)
 *
 * - The conflict is not an error: §1.1's hook contract is that a hook failure
 *   never fails a sign-in (ADR-0038), and the attendee's browser simply drops the
 *   stale cookie at its next claim/expiry. The warn record is the only observable.
 * - `attendee.claim_conflict` is this spec's own name for that record — the
 *   contract names no log event, so the literal is fixed here (with
 *   `attendee.claimed` for the success path, which the green card does name).
 */

let app: TestApp;

/** The success record the green card requires (§1). */
const CLAIMED_EVENT = "attendee.claimed";

/** The conflict record this spec requires (see §Assumptions). */
const CLAIM_CONFLICT_EVENT = "attendee.claim_conflict";

beforeAll(async () => {
  app = await startTestApp({ prefix: "op134-signin" });
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

/** Install a capturing logger, returning the transport to inspect. */
function installMemoryLogger(): { readonly sink: MemoryTransport; readonly previous: Logger } {
  const previous = getLogger();
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
  return { sink, previous };
}

/** A seeded tenant and its one event, asserting the fixture built what a case needs. */
async function seededEvent(prefix: string): Promise<{
  readonly tenantKey: string;
  readonly eventId: ObjectId;
  readonly slug: string;
}> {
  const { tenantKey, events } = await seedTenant(app, prefix);
  const event = events[0];
  if (event === undefined) {
    throw new Error("expected one seeded event");
  }
  return { tenantKey, eventId: event.id, slug: event.slug };
}

describe("when an attendee signs in holding the anonymous cookie", () => {
  it("I5: claims the session at sign-in, so /me/events lists the event without an explicit claim", async () => {
    // Arrange — a real anonymous attendance: consent, a submitted selfie, one
    // profile, one selfie and one queued embed job.
    const event = await seededEvent("op134-i5");
    const session = await createBoundAttendeeSession(app, event.slug);
    await grantConsent(event.slug, { cookie: session.cookie, ip: nextIp() });
    const submitted = await submitHappyPath(event.slug, {
      cookie: session.cookie,
      ip: nextIp(),
      tag: "op134-i5",
    });
    const selfiesBefore = await selfieIds(app);

    // Act — sign in from the same browser, which still holds `op_att`.
    const user = await app.signIn(makeIdentity("op134-i5-user"), {
      headers: { cookie: session.cookie },
    });

    // Assert — the profile moved to the account, and nothing else moved.
    const rows = await allProfiles(app);
    expect(rows).toHaveLength(1);
    const [profile] = rows;
    if (profile === undefined) {
      throw new Error("expected the anonymous selfie to leave one profile");
    }
    expect(profile._id.toHexString()).toBe(submitted.profileId);
    expect(profile.subject).toEqual({ kind: "user", userId: user.userId });
    expect(profile.claimedAt).toBeInstanceOf(Date);
    expect(await selfieIds(app)).toEqual(selfiesBefore);

    // Assert — the account's own list now carries the event, with no explicit
    // claim having been called.
    const response = await myEvents({ cookie: user.cookie, ip: nextIp() });
    const body = await myEventsBodyOf(response);
    expect(body.data.map((item) => item.eventId)).toEqual([event.eventId.toHexString()]);
    const [item] = body.data;
    if (item === undefined) {
      throw new Error("expected the claimed event in the account's list");
    }
    expect(item.galleryUrl).toBe(`/e/${event.slug}/gallery`);
    expect(item.status).toBe("processing");

    // Assert — the session records its owner, so a second account cannot claim it.
    expect((await readSessionRow(app, session.token)).claimedByUserId).toEqual(user.userId);
  });

  it("I5: a sign-in with no op_att cookie claims nothing", async () => {
    // Arrange — an unclaimed anonymous session exists, but this browser never
    // presents it.
    const event = await seededEvent("op134-i5-nocookie");
    const session = await createBoundAttendeeSession(app, event.slug);
    await seedProfile(app, {
      tenantKey: event.tenantKey,
      eventId: event.eventId,
      subject: { kind: "anonymous", attendeeSessionId: session.sessionId },
    });
    const { sink, previous } = installMemoryLogger();

    // Act
    const user = await app.signIn(makeIdentity("op134-i5-nocookie-user"));
    setLogger(previous);

    // Assert — nothing was claimed, and no claim was attempted.
    const rows = await allProfiles(app);
    expect(rows).toHaveLength(1);
    const [profile] = rows;
    expect(profile?.subject).toEqual({
      kind: "anonymous",
      attendeeSessionId: session.sessionId,
    });
    expect((await readSessionRow(app, session.token)).claimedByUserId ?? null).toBeNull();
    expect(sink.entries.filter((entry) => entry.event === CLAIMED_EVENT)).toEqual([]);
    const listing = await myEventsBodyOf(await myEvents({ cookie: user.cookie, ip: nextIp() }));
    expect(listing.data).toEqual([]);
  });
});

describe("when the cookie is already claimed by a different account", () => {
  it("I6: the sign-in still succeeds, nothing is claimed and a warn is logged", async () => {
    // Arrange — an anonymous profile, claimed by the first account.
    const event = await seededEvent("op134-i6");
    const session = await createBoundAttendeeSession(app, event.slug);
    const profileId = await seedProfile(app, {
      tenantKey: event.tenantKey,
      eventId: event.eventId,
      subject: { kind: "anonymous", attendeeSessionId: session.sessionId },
    });
    const first = await app.signIn(makeIdentity("op134-i6-first"));
    await claimBodyOf(
      await claimSession({ cookie: first.cookie, ip: nextIp(), sessionToken: session.token })
    );
    const { sink, previous } = installMemoryLogger();

    // Act — the second account signs in from a browser still holding the token.
    const second = await app.signIn(makeIdentity("op134-i6-second"), {
      headers: { cookie: session.cookie },
    });
    setLogger(previous);

    // Assert — the sign-in succeeded: the harness throws on a non-200, and the
    // fresh account can read its own (empty) list.
    expect(second.userId.equals(first.userId)).toBe(false);
    const listing = await myEventsBodyOf(await myEvents({ cookie: second.cookie, ip: nextIp() }));
    expect(listing.data).toEqual([]);

    // Assert — nothing was claimed: the profile is still the first account's, and
    // the second account owns no profile at all.
    const rows = await allProfiles(app);
    expect(rows).toHaveLength(1);
    const [profile] = rows;
    expect(profile?._id.toHexString()).toBe(profileId.toHexString());
    expect(profile?.subject).toEqual({ kind: "user", userId: first.userId });
    expect((await readSessionRow(app, session.token)).claimedByUserId).toEqual(first.userId);

    // Assert — the conflict is recorded as a warning, not swallowed, and never
    // with the bearer token in it.
    const warned = sink.entries.filter((entry) => entry.event === CLAIM_CONFLICT_EVENT);
    expect(warned).toHaveLength(1);
    expect(warned[0]?.level).toBe("warn");
    expect(warned[0]?.userId).toBe(second.userId.toHexString());
    expect(JSON.stringify(sink.entries)).not.toContain(session.token);
  });
});
