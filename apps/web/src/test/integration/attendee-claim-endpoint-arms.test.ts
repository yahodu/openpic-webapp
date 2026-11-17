import { Collection, type ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";

import {
  allProfiles,
  claimBodyOf,
  claimHandlers,
  createBoundAttendeeSession,
  readSessionRow,
  type BoundAttendeeSession,
  type ClaimBody,
  type ClaimProfileRow,
} from "../helpers/attendee-claim-flow";
import { makeIdentity, startTestApp, type SignedInUser, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import {
  errorBody,
  grantConsent,
  nextIp,
  requestFor,
  seedTenant,
  submitHappyPath,
} from "../helpers/selfie-flow";

/**
 * Integration / contract — the two arms of `POST /me/attendee-sessions:claim`
 * that the shipped OP-134 GREEN leaves unsatisfied (contract §6.7; schema
 * §13.5, §15.3; ADR-0814, ADR-0815; review of card `t_135c11ae`, findings F1 and
 * F2).
 *
 * **I8 — two accounts claiming one session at the same time.** The claim's only
 * guard is a *read* of `attendeeSessions.claimedByUserId` (`claim.ts:148`) that
 * happens before any write, and the re-point's `updateOne` (`claim.ts:182`)
 * never looks at `matchedCount`. Two signed-in accounts that pass that read
 * together both answer `200` naming the same event, both emit
 * `attendee.event.linked`, and `claimedByUserId` ends up naming whichever write
 * landed last rather than the profile's owner. So the loser is told it moved an
 * event it did not move — and a second account is told it owns a session whose
 * photos belong to the first person.
 *
 * The pin is the invariant, not the interleaving: exactly one answer carries
 * `claimed.length === 1`; the other either refuses with `409
 * session_claimed_by_other_user` or answers `200` with nothing claimed and
 * nothing skipped; one profile row survives, owned by the account the winning
 * answer named; one `attendee.event.linked` row exists; the session records that
 * same account. The case is repeated three times (each on an empty database) and
 * every run must hold it, and both claims are parked on a shared barrier **after
 * each has passed the conflict check and before either can write**, so the
 * "both saw the session unclaimed" window is reached on every run instead of
 * only when the event loop happens to interleave it.
 *
 * **I9 — the body may be omitted.** §6.7 states the request body as
 * `{"sessionToken": "opat_…"}` **"(or omitted, reading the `op_att` cookie)"**.
 * A bodyless POST sends no `content-type`, and the pipeline's `parseJsonBody`
 * (`respond.ts:84`) answers `415 unsupported_media_type` before the handler
 * ever reads the cookie — so the documented arm of the contract does not work.
 * The shipped RED helper `claimSession()` always sends `{}`, which is why the
 * gap survived the GREEN.
 *
 * ## Contract expected of the implementation
 *
 * ```ts
 * // apps/web/src/app/api/v1/me/attendee-sessions:claim/route.ts
 * export const POST: (request: Request) => Promise<Response>;
 * ```
 *
 * - A request with **no body** (hence no `content-type`) is a valid claim: the
 *   `op_att` cookie names the session, and the answer is the ordinary `200`
 *   `{ claimed, skipped }`.
 * - Concurrent claims on one session must move the profile **once**: at most
 *   one caller may report an event it re-pointed, and the session's
 *   `claimedByUserId` must agree with the profile's `subject.userId`.
 *
 * ## Assumptions (recorded in ADR-0818)
 *
 * - The loser of the race may answer either `409 session_claimed_by_other_user`
 *   or `200 { claimed: [], skipped: [] }`: §6.7 only forbids a `200` that names
 *   an event it did not move, and a re-read-and-reuse implementation can
 *   legitimately observe the winner's write and answer the empty no-op.
 * - A request that **does** carry `content-type: application/json` with an empty
 *   body is out of scope here (the contract names the omitted body, not an empty
 *   one); whether it is a `400 malformed_json` or a valid claim is the GREEN's
 *   call.
 */

let app: TestApp;

/** How many accounts race for one session in every `I8` run. */
const CONCURRENT_CLAIMS = 2;

/**
 * How long a parked claim may be held before it proceeds anyway.
 *
 * The barrier exists to reach the "both passed the conflict check with the
 * session unclaimed" window deterministically. The bound keeps a fix that
 * refuses the second account before it reaches the park (or serialises the two
 * claims entirely) from hanging the case: the parked claim proceeds, and the
 * invariant still has to hold.
 */
const PARK_BOUND_MS = 1_000;

/** A stored `domain_events` row, reduced to what these cases read (§18.3). */
interface DomainEventRow {
  readonly eventKey: string;
  readonly subjectRef: { readonly kind: string; readonly id: string };
}

/** One account's answer, reduced to what the invariant reads. */
interface ClaimAnswer {
  readonly user: SignedInUser;
  readonly status: number;
  readonly claimed: readonly { readonly eventId: string }[];
  readonly skipped: readonly { readonly eventId: string; readonly reason: string }[];
  readonly errorCode: string | null;
}

beforeAll(async () => {
  app = await startTestApp({ prefix: "op134-claim-arms" });
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

/**
 * A real anonymous attendance: the consent route creates the profile, the
 * selfie route stores the selfie, so the row a claim must move is the shipped
 * route's own.
 *
 * @param event - The seeded event to attend.
 * @param run - The case's run label, used in the upload tag and the addresses.
 * @returns The session and the submitted selfie's profile id.
 */
async function attendAnonymously(
  event: { readonly slug: string },
  run: string
): Promise<{ session: BoundAttendeeSession; profileId: string }> {
  const session = await createBoundAttendeeSession(app, event.slug);
  await grantConsent(event.slug, { cookie: session.cookie, ip: nextIp() });
  const submitted = await submitHappyPath(event.slug, {
    cookie: session.cookie,
    ip: nextIp(),
    tag: run,
  });
  return { session, profileId: submitted.profileId };
}

/**
 * Claim one session as one account, keeping the status and the parsed answer.
 *
 * The body names the session **and** the `op_att` cookie is presented, exactly
 * as a browser that signed in from the attendee page would: I8 must fail on the
 * double claim, never on the bodyless arm that I9 pins.
 *
 * @param user - The signed-in account.
 * @param session - The anonymous session both accounts claim.
 * @returns The status, the claimed/skipped lists and, for a refusal, its code.
 */
async function claimAs(user: SignedInUser, session: BoundAttendeeSession): Promise<ClaimAnswer> {
  const response = await claimHandlers.claim(
    requestFor("/api/v1/me/attendee-sessions:claim", "POST", {
      cookie: `${user.cookie}; ${session.cookie}`,
      ip: nextIp(),
      body: { sessionToken: session.token },
    })
  );
  if (response.status !== 200) {
    const refusal = await errorBody(response);
    return { user, status: response.status, claimed: [], skipped: [], errorCode: refusal.code };
  }
  const body = (await response.json()) as ClaimBody;
  return {
    user,
    status: response.status,
    claimed: body.claimed,
    skipped: body.skipped,
    errorCode: null,
  };
}

/** One answer, reduced to a string a failure message can name. */
function describeAnswer(answer: ClaimAnswer): string {
  const tail =
    answer.errorCode ??
    `claimed=${String(answer.claimed.length)} skipped=${String(answer.skipped.length)}`;
  return `${String(answer.user.userId)}: ${String(answer.status)} ${tail}`;
}

/** Every answer of one run, for a failure message. */
function describeAnswers(answers: readonly ClaimAnswer[]): string {
  return answers.map(describeAnswer).join(" | ");
}

/** The single stored profile of a fixture, failing loudly when it is not single. */
function singleProfile(rows: readonly ClaimProfileRow[]): ClaimProfileRow {
  const [profile] = rows;
  if (profile === undefined) {
    throw new Error("expected exactly one attendee profile");
  }
  return profile;
}

/** The `attendee.event.linked` rows the claim wrote — one per claimed event. */
async function linkedEvents(): Promise<DomainEventRow[]> {
  return (await app.db
    .collection(COLLECTIONS.domainEvents)
    .find({ eventKey: "attendee.event.linked" })
    .toArray()) as unknown as DomainEventRow[];
}

/** The driver's own `Collection#findOne`, captured before the barrier replaces it. */
const driverFindOne = ((): typeof Collection.prototype.findOne => {
  const descriptor = Object.getOwnPropertyDescriptor(Collection.prototype, "findOne");
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    throw new Error("the driver's Collection#findOne is missing from the prototype");
  }
  return descriptor.value as typeof Collection.prototype.findOne;
})();

/** The driver's own argument tuple, so the barrier forwards without re-declaring it. */
type DriverFindOneArgs = Parameters<typeof driverFindOne>;

/**
 * Park every claim **after** its conflict check and before it writes, until all
 * of them have.
 *
 * `Promise.all` alone leaves the interleaving to the event loop: a run where the
 * first claim finishes before the second even reads its session answers `409`
 * and passes by luck, which is not a pin. The claim body is
 *
 *   session read → conflict check (`claim.ts:148`) → profile rows → \
 *   existing-profile check → re-point `updateOne` (`claim.ts:182`) → emit
 *
 * so holding every claim at its **existing-profile check** (one
 * `attendee_event_profiles.findOne` per anonymous profile, the first database
 * call after the guard) releases them all only once each has passed the guard
 * against an unclaimed session — the exact window a read-then-write check
 * cannot close. The hold is bounded so a fix that refuses the second account
 * before this point still finishes.
 *
 * @param participants - How many claims must reach the park before any proceeds.
 * @returns The disposer, which restores the driver's `findOne`.
 */
function parkAfterConflictCheck(participants: number): () => void {
  let parked = 0;
  let releaseParked = (): void => undefined;
  const allParked = new Promise<void>((resolve) => {
    releaseParked = () => {
      resolve();
    };
  });
  const parkBound = new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, PARK_BOUND_MS);
  });

  const spy = vi.spyOn(Collection.prototype, "findOne").mockImplementation(function (
    this: Collection,
    ...args: DriverFindOneArgs
  ) {
    const reading = driverFindOne.call(this, ...args);
    if (this.collectionName !== COLLECTIONS.attendeeEventProfiles) {
      return reading;
    }
    return Promise.resolve(reading).then(async (row) => {
      parked += 1;
      if (parked >= participants) {
        releaseParked();
      }
      await Promise.race([allParked, parkBound]);
      return row;
    });
  } as never);

  return () => {
    spy.mockRestore();
  };
}

describe("when two accounts claim one anonymous session at the same time", () => {
  it.each([1, 2, 3])(
    "I8 (run %i of 3): only one account claims the event, and the session records its owner",
    async (run) => {
      // Arrange — a real anonymous attendance, then two accounts that sign in
      // **without** the op_att cookie, so nothing is claimed on the way in and
      // the two concurrent calls are the only things that can move the row.
      const label = String(run);
      const event = await seededEvent(`op134-i8-${label}`);
      const { session, profileId } = await attendAnonymously(event, `op134-i8-${label}`);
      const before = await allProfiles(app);
      expect(
        before,
        `run ${label}: the anonymous flow must leave exactly one profile`
      ).toHaveLength(1);
      expect(singleProfile(before).subject).toEqual({
        kind: "anonymous",
        attendeeSessionId: session.sessionId,
      });

      const first = await app.signIn(makeIdentity(`op134-i8-${label}-a`));
      const second = await app.signIn(makeIdentity(`op134-i8-${label}-b`));
      expect(
        (await readSessionRow(app, session.token)).claimedByUserId ?? null,
        `run ${label}: signing in must not claim the session by itself`
      ).toBeNull();

      // Act — both claims pass the conflict check before either can write.
      const releaseReads = parkAfterConflictCheck(CONCURRENT_CLAIMS);
      let answers: ClaimAnswer[];
      try {
        answers = await Promise.all([claimAs(first, session), claimAs(second, session)]);
      } finally {
        releaseReads();
      }
      const described = describeAnswers(answers);

      // Assert — at most one caller may name an event it re-pointed.
      const winners = answers.filter(
        (answer) => answer.status === 200 && answer.claimed.length === 1
      );
      expect(
        winners,
        `run ${label}: more than one account reported a claimed event (${described})`
      ).toHaveLength(1);
      const [winner] = winners;
      if (winner === undefined) {
        throw new Error(`run ${label}: no account claimed the event (${described})`);
      }
      expect(
        winner.claimed.map((claimed) => claimed.eventId),
        `run ${label}: the winning answer named an event it did not move`
      ).toEqual([event.eventId.toHexString()]);

      // Assert — the other answer is a refusal or an empty no-op, never a claim.
      const losers = answers.filter((answer) => answer !== winner);
      expect(losers, `run ${label}: expected exactly two answers (${described})`).toHaveLength(1);
      const [loser] = losers;
      if (loser === undefined) {
        throw new Error(`run ${label}: expected a losing answer (${described})`);
      }
      const loserShape =
        loser.status === 200
          ? `200 claimed=${String(loser.claimed.length)} skipped=${String(loser.skipped.length)}`
          : `${String(loser.status)} ${loser.errorCode ?? ""}`.trim();
      expect(
        ["409 session_claimed_by_other_user", "200 claimed=0 skipped=0"],
        `run ${label}: the losing claim answered "${loserShape}" (${described})`
      ).toContain(loserShape);

      // Assert — one profile row survives, it is the anonymous row (not a
      // recreated one), and it belongs to the account the winning answer named.
      const rows = await allProfiles(app);
      expect(rows, `run ${label}: the claim must not add or drop a profile row`).toHaveLength(1);
      const profile = singleProfile(rows);
      expect(
        profile._id.toHexString(),
        `run ${label}: the claim must re-point the anonymous row, not replace it`
      ).toBe(profileId);
      expect(
        profile.subject,
        `run ${label}: the surviving profile is not owned by the winning account`
      ).toEqual({ kind: "user", userId: winner.user.userId });

      // Assert — §6.7's confirmation event exists exactly once, about that owner.
      const linked = await linkedEvents();
      expect(
        linked,
        `run ${label}: expected exactly one attendee.event.linked row, received ${String(linked.length)}`
      ).toHaveLength(1);
      expect(linked[0]?.subjectRef.id).toBe(winner.user.userId.toHexString());

      // Assert — the session records the owner of the surviving profile.
      expect(
        (await readSessionRow(app, session.token)).claimedByUserId,
        `run ${label}: attendeeSessions.claimedByUserId must name the profile's owner`
      ).toEqual(winner.user.userId);
    }
  );
});

describe("when the claim request omits its body", () => {
  it("I9: a bodyless claim reads the op_att cookie and claims the session", async () => {
    // Arrange — an anonymous attendance, and an account that signed in without
    // the op_att cookie, so the bodyless call is the only thing that claims.
    const event = await seededEvent("op134-i9");
    const { session, profileId } = await attendAnonymously(event, "op134-i9");
    const user = await app.signIn(makeIdentity("op134-i9-user"));
    expect(
      (await readSessionRow(app, session.token)).claimedByUserId ?? null,
      "signing in without the op_att cookie must not claim the session"
    ).toBeNull();

    // Act — no `body` key, so the request carries no `content-type` at all:
    // §6.7's "(or omitted, reading the op_att cookie)".
    const response = await claimHandlers.claim(
      requestFor("/api/v1/me/attendee-sessions:claim", "POST", {
        cookie: `${user.cookie}; ${session.cookie}`,
        ip: nextIp(),
      })
    );

    // Assert — the omission is a valid claim, not a media-type refusal.
    expect(
      response.status,
      `expected 200 from a bodyless claim, received ${String(response.status)}`
    ).toBe(200);
    const body = await claimBodyOf(response);
    expect(body.skipped).toEqual([]);
    expect(body.claimed).toHaveLength(1);
    expect(body.claimed[0]?.eventId).toBe(event.eventId.toHexString());
    expect(body.claimed[0]?.profileId).toBe(profileId);

    // Assert — the row really moved to the caller, and the session says so.
    const rows = await allProfiles(app);
    expect(rows).toHaveLength(1);
    expect(singleProfile(rows).subject).toEqual({ kind: "user", userId: user.userId });
    expect(
      (await readSessionRow(app, session.token)).claimedByUserId,
      "the bodyless claim must stamp attendeeSessions.claimedByUserId"
    ).toEqual(user.userId);
  });
});
