/**
 * Integration / contract — **who** receives `attendee.selfie.rejected`
 * (OP-140 finding **F1** of ADR-0962 §3; the routing decision of card
 * `t_f6f20d62`, recorded as ADR-0947 D1–D5).
 *
 * The producer is already pinned (`selfie-rejected-notification.test.ts`): a
 * `failed` report emits one `attendee.selfie.rejected` row carrying
 * `subjectRef { kind: "selfie", id }` and `payload { eventId, profileId, reason }`,
 * where `profileId` is the `attendeeEventProfiles._id` the submit route answered
 * in its `202`. What that row did **not** pin is the recipient, and the trunk
 * routed the type to `attendee_identified` — the event's whole attendee
 * audience. ADR-0962 §3 measured both halves: an event with the owner and one
 * unrelated identified attendee delivered to `["<owner>", "<other>"]`, and the
 * ordinary anonymous uploader reached `[]`.
 *
 * These cases drive the real worker report, the real Mongo recipient port and
 * one real fan-out run, and read only stored state, so the answer is the
 * product's, not the test's:
 *
 * - **E1** an identified owner's rejection writes exactly one in-app row — the
 *   owner's — with `actionTarget.kind: "selfie"` and the row's stored reason; an
 *   unrelated identified attendee of the same event gets no `notifications` row
 *   and no `notificationDispatches` row, and the outbox row is `done`.
 * - **E2** an anonymous owner's rejection is still emitted (the producer is
 *   unaffected) but delivers to nobody and still completes the event: the
 *   anonymous subject is polled (§6.4, `GET /api/v1/p/events/{slug}/me`), which
 *   design §2 documents as deliberate, and no retry loop is created.
 * - **E3** a rejection whose payload carries no `profileId` reaches nobody and
 *   does not broadcast — a missing profile id is not an error, it is "nobody".
 */

import { ObjectId } from "mongodb";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { runNotificationFanOut } from "@/server/notifications/fan-out";
import { invalidateNotificationTypeCache } from "@/server/notifications/notification-type-cache";
import {
  seedNotificationTemplates,
  seedNotificationTypes,
} from "@/server/notifications/seed-notification-types";
import { mongoRecipientRepository } from "@/server/repos/notification-recipients";
import { getNotificationTransport } from "@/server/services/notification-transport";

import { makeIdentity, type SignedInUser } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import {
  app,
  claimSelfie,
  LEASEHOLDER,
  REPORT_PATH,
  signedPost,
  submittedSelfie,
  world,
  workerReportHandler,
  type World,
} from "../helpers/internal-worker-harness";
import { bodyOf, grantConsent, nextIp, submitHappyPath } from "../helpers/selfie-flow";

/** The catalogue key this card routes. */
const REJECTED = "attendee.selfie.rejected";

/** The `failed` verdict a face-less photograph earns (§10.3.3). */
const NO_FACE = {
  outcome: "failed",
  quality: { faceCount: 0, accepted: false },
  error: { code: "no_face_detected", message: "no face in frame", retryable: false },
  matchesCreated: 0,
};

/** The reason the quality pass stores on the selfie (§16.4), as the emit reads it. */
const REASON = "no_face_detected";

/** One stored in-app feed row, as these cases read it (§19.4). */
interface FeedRow {
  readonly _id: ObjectId;
  readonly userId: ObjectId;
  readonly typeKey: string;
  readonly data: Record<string, unknown>;
  readonly actionTarget: {
    readonly kind: string;
    readonly id: string;
    readonly state: string;
  } | null;
}

/** One stored outbox row, as these cases read it (§18.3). */
interface OutboxRow {
  readonly _id: ObjectId;
  readonly eventKey: string;
  readonly payload: Record<string, unknown>;
  readonly dispatch?: { readonly notifications?: string };
}

/* ─────────────────────────────── the catalogue ───────────────────────────── */

beforeAll(async () => {
  // The catalogue and its copy are production seed data: seeding them is what
  // makes the in-app row a row the shipped fan-out writes (and not a fixture).
  await seedNotificationTypes({ db: app.db });
  await seedNotificationTemplates({ db: app.db });
  invalidateNotificationTypeCache();
}, MONGO_READY_HOOK_TIMEOUT_MS);

beforeEach(async () => {
  // The shared harness sweeps the attendee/event collections per case; the two
  // notification collections are this spec's output surface, so they are
  // cleared here and no row can leak into the next case.
  for (const name of [COLLECTIONS.notifications, COLLECTIONS.dispatches]) {
    await app.db.collection(name).deleteMany({});
  }
  invalidateNotificationTypeCache();
});

/* ──────────────────────────────── the fixtures ───────────────────────────── */

/**
 * A signed-in attendee of the event: consent, then one submitted selfie.
 *
 * The submit runs with the **user** session and no `op_att` cookie, so
 * `subjectForRequest` answers `{ kind: "user", userId }` and the profile the
 * routes upsert is identified from its first write. That is the only shape
 * `attendee_subject` can resolve, and it is the shape the §6.7 claim produces.
 *
 * @param seeded - The event to participate in.
 * @param prefix - The suite-local identity prefix.
 * @param tag - The per-case selfie byte tag.
 * @returns The signed-in attendee and the ids their submit answered.
 */
async function identifiedSubmitter(
  seeded: World,
  prefix: string,
  tag: string
): Promise<{ readonly user: SignedInUser; readonly selfieId: string; readonly profileId: string }> {
  const user = await app.signIn(makeIdentity(prefix));
  const ip = nextIp();
  await grantConsent(seeded.event.slug, { cookie: user.cookie, ip });
  const submitted = await submitHappyPath(seeded.event.slug, { cookie: user.cookie, ip, tag });
  return { user, selfieId: submitted.selfieId, profileId: submitted.profileId };
}

/**
 * Report one selfie verdict, exactly as the worker does (§10.3.2).
 *
 * @param item - The `selfie` item's fields, without `kind`.
 * @returns The parsed `200` body.
 */
async function reportSelfie(item: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await workerReportHandler(
    signedPost(REPORT_PATH, { workerId: LEASEHOLDER, items: [{ kind: "selfie", ...item }] })
  );
  return bodyOf(response, 200, "POST internal worker/report");
}

/**
 * Leave the rejection reason the quality pass would store, then claim the row.
 *
 * @param fixture - The submitted selfie (only its id is read).
 * @returns The same fixture.
 */
async function claimRejection<Fixture extends { readonly selfieId: string }>(
  fixture: Fixture
): Promise<Fixture> {
  await app.db
    .collection(COLLECTIONS.selfies)
    .updateOne(
      { _id: new ObjectId(fixture.selfieId) },
      { $set: { "quality.rejectionReason": REASON } }
    );
  await claimSelfie(fixture.selfieId, LEASEHOLDER);
  return fixture;
}

/**
 * Drive one fan-out run over the real port, as the cron route wires it.
 *
 * @returns The run summary.
 */
async function fanOutOnce(): Promise<{
  readonly claimed: number;
  readonly processed: number;
  readonly failed: number;
}> {
  return await runNotificationFanOut({
    db: app.db,
    transport: getNotificationTransport(),
    recipients: mongoRecipientRepository(app.db),
    claimerId: "spec.op140-attendee-subject",
  });
}

/**
 * Consume the traffic the **fixture's own** arrange created.
 *
 * Two kinds of setup noise would otherwise be measured as if they were this
 * card's answer:
 *
 * - `app.signIn` emits `account.welcome`; those outbox rows are still pending
 *   when the case's single fan-out run happens (nothing drains the outbox during
 *   the arrange — the opportunistic trigger is a no-op outside a Next request
 *   scope), so they would be delivered as extra feed/dispatch rows.
 * - the sign-in flow sends its verification email through the dispatch ledger,
 *   so `notificationDispatches` already holds rows before the rejection exists.
 *
 * Both are removed here, before the act, so the one fan-out run measures the
 * rejection and nothing else.
 */
async function consumeSetupTraffic(): Promise<void> {
  await app.db.collection(COLLECTIONS.domainEvents).deleteMany({ eventKey: { $ne: REJECTED } });
  await app.db.collection(COLLECTIONS.dispatches).deleteMany({});
}

/* ─────────────────────────────── the readings ────────────────────────────── */

/** The stored in-app feed rows, oldest first. */
async function feedRows(): Promise<readonly FeedRow[]> {
  const rows = await app.db
    .collection(COLLECTIONS.notifications)
    .find({})
    .sort({ _id: 1 })
    .toArray();
  return rows as unknown as readonly FeedRow[];
}

/** The stored outbox rows of this catalogue key, oldest first. */
async function rejectedRows(): Promise<readonly OutboxRow[]> {
  const rows = await app.db
    .collection(COLLECTIONS.domainEvents)
    .find({ eventKey: REJECTED })
    .sort({ _id: 1 })
    .toArray();
  return rows as unknown as readonly OutboxRow[];
}

/** How many feed rows one user holds. */
async function feedRowsFor(userId: ObjectId): Promise<number> {
  return await app.db.collection(COLLECTIONS.notifications).countDocuments({ userId });
}

/** How many dispatch-ledger rows one user holds, on any channel. */
async function dispatchesFor(userId: ObjectId): Promise<number> {
  return await app.db.collection(COLLECTIONS.dispatches).countDocuments({ userId });
}

/** How many dispatch-ledger rows exist at all. */
async function dispatchRowCount(): Promise<number> {
  return await app.db.collection(COLLECTIONS.dispatches).countDocuments({});
}

/**
 * The stored `subject` of one attendee profile.
 *
 * A fixture guard, not a routing assertion: a case that claims to plant an
 * identified attendee must prove the attendee really is identified, or the
 * "no broadcast" arm would pass vacuously.
 *
 * @param profileId - The `attendeeEventProfiles._id` to read.
 * @returns The stored subject, or `null` when no row exists.
 */
async function storedSubject(profileId: string): Promise<Record<string, unknown> | null> {
  const row = (await app.db
    .collection(COLLECTIONS.attendeeEventProfiles)
    .findOne({ _id: new ObjectId(profileId) })) as { readonly subject?: unknown } | null;
  const subject = row?.subject;
  return typeof subject === "object" && subject !== null
    ? (subject as Record<string, unknown>)
    : null;
}

/* ─────────────────────────────────── E1 ──────────────────────────────────── */

describe("when an identified attendee's selfie is rejected", () => {
  it("E1: writes exactly one in-app row — the selfie owner's — and never the other attendee's", async () => {
    const seeded = await world("op140-subject-e1");
    const owner = await identifiedSubmitter(seeded, "op140-e1-owner", "op140-e1-owner");
    const bystander = await identifiedSubmitter(seeded, "op140-e1-bystander", "op140-e1-bystander");

    // Fixture guard: both are identified attendees of this event, so the
    // shipped broadcast WOULD have reached the bystander (ADR-0962 §3).
    expect(await storedSubject(owner.profileId)).toMatchObject({
      kind: "user",
      userId: owner.user.userId,
    });
    expect(await storedSubject(bystander.profileId)).toMatchObject({
      kind: "user",
      userId: bystander.user.userId,
    });

    await claimRejection(owner);
    await consumeSetupTraffic();

    // Act — the worker settles the owner's photo as rejected, then one fan-out
    // run delivers whatever the catalogue routes it to.
    await reportSelfie({ id: owner.selfieId, ...NO_FACE });
    const summary = await fanOutOnce();

    // Assert — one row, the owner's, addressed to the selfie it is about.
    const rows = await feedRows();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.typeKey).toBe(REJECTED);
    expect(String(row?.userId)).toBe(owner.user.userId.toHexString());
    expect(row?.data).toMatchObject({ profileId: owner.profileId, reason: REASON });

    // The row ships **no affordance** today: the catalogue declares
    // `attendee.selfie.rejected` with `actionable: false` (the `build()` default;
    // the §4.8 spec carries no `actionable` key), and `buildActions` returns a
    // `null` target for a non-actionable type, so the feed row carries no
    // `actionTarget` even though the emit's subject is the selfie. Giving it the
    // `selfie` × `retry` affordance is the delegate arm ADR-0942 §2 deferred
    // (ADR-0947 §Consequences, finding F-1), not a recipient-routing decision:
    // this pin names the current contract, and it reds by design when that arm
    // lands.
    expect(row?.actionTarget).toBeNull();

    // Assert — the unrelated identified attendee hears nothing, on any channel.
    expect(await feedRowsFor(bystander.user.userId)).toBe(0);
    expect(await dispatchesFor(bystander.user.userId)).toBe(0);

    // Assert — the event completed, so no retry loop redelivers it.
    expect(summary.failed).toBe(0);
    expect((await rejectedRows())[0]?.dispatch?.notifications).toBe("done");
  });
});

/* ─────────────────────────────────── E2 ──────────────────────────────────── */

describe("when an anonymous attendee's selfie is rejected", () => {
  it("E2: emits the row, delivers to nobody, and still completes the event", async () => {
    // The ordinary fixture profile: an `op_att` session, no account behind it.
    const fixture = await submittedSelfie("op140-subject-e2", "op140-subject-e2");
    await claimRejection(fixture);
    await consumeSetupTraffic();

    // Act
    await reportSelfie({ id: fixture.selfieId, ...NO_FACE });

    // Assert — the producer is unaffected: the row is emitted, with the profile.
    const emitted = await rejectedRows();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.payload).toMatchObject({
      profileId: fixture.profileId,
      reason: REASON,
    });

    const summary = await fanOutOnce();

    // Assert — nobody is written to: the anonymous subject's outcome is the
    // §6.4 poll's (design §2), not a dispatch.
    expect(await feedRows()).toEqual([]);
    expect(await dispatchRowCount()).toBe(0);

    // Assert — and the event is consumed rather than retried for ever.
    expect(summary.failed).toBe(0);
    expect((await rejectedRows())[0]?.dispatch?.notifications).toBe("done");
  });
});

/* ─────────────────────────────────── E3 ──────────────────────────────────── */

describe("when a rejection carries no profileId", () => {
  it("E3: reaches nobody and does not broadcast to the event's identified attendees", async () => {
    const seeded = await world("op140-subject-e3");
    const bystander = await identifiedSubmitter(seeded, "op140-e3-bystander", "op140-e3-bystander");
    expect(await storedSubject(bystander.profileId)).toMatchObject({ kind: "user" });
    await consumeSetupTraffic();

    // A hand-built outbox row: the emit shape minus `profileId`. Nothing in the
    // row names a subject, so nothing may be guessed from the audience.
    await emitDomainEvent(
      {
        eventKey: REJECTED,
        tenantId: seeded.tenantKey,
        actorRef: { kind: "system", id: "worker" },
        subjectRef: { kind: "selfie", id: new ObjectId().toHexString() },
        payload: { eventId: seeded.event.id.toHexString(), reason: REASON },
        dedupeKey: "attendee.selfie.rejected:no-profile",
      },
      { db: app.db }
    );

    // Act
    const summary = await fanOutOnce();

    // Assert — no feed row, no dispatch row, no broadcast.
    expect(await feedRows()).toEqual([]);
    expect(await dispatchRowCount()).toBe(0);
    expect(await feedRowsFor(bystander.user.userId)).toBe(0);
    expect(summary.failed).toBe(0);
    expect((await rejectedRows())[0]?.dispatch?.notifications).toBe("done");
  });
});
