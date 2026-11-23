/**
 * Integration / contract — the `attendee.selfie.rejected` producer (OP-140
 * precondition, card `t_9df3b691`; design §4.8; contract §7.3 `selfie` × `retry`
 * and §10.3.3; schema §16.4/§18.2/§19.1; ADR-0962).
 *
 * A selfie's outcome settles **asynchronously**: the worker answers
 * `POST /api/v1/internal/worker/report`, `reduceReportItem` decides the row's
 * `processing.status`, and until then nothing is announced. That route is the
 * only place the outcome becomes visible, so it is where the attendee must be
 * told their photo was refused.
 *
 * Design §4.8 names two attendees rows — `accepted` and `rejected` — and the
 * trunk emits **neither**. This card builds the **rejected** sibling only; the
 * accepted one stays catalogue-only (ADR-0962 §4 records why: a success is
 * already visible on the §6.4 poll, and the absence of `accepted` is a
 * delivery gap of its own, not this row's precondition).
 *
 * The pins, one per behaviour:
 *
 * - a report that **settles** a selfie `failed` emits exactly one
 *   `attendee.selfie.rejected` row, addressed to the selfie itself
 *   (`subjectRef { kind: "selfie", id: <selfie hex> }`) so the feed row can
 *   carry `actionTarget.kind: "selfie"` and still satisfy the action endpoint's
 *   24-hex target guard;
 * - the payload carries the facts a template needs — `eventId` (the fan-out
 *   reads it to resolve recipients), `profileId` and `reason`, which is the
 *   row's own `selfies.quality.rejectionReason` (§16.4) and **not** the worker's
 *   `processing.lastError.code`;
 * - the `dedupeKey` names the selfie, which is design §4.8's "1/attempt"
 *   identity: one selfie row is one attempt (schema §15.3), so a per-selfie key
 *   is a per-attempt key and a replay of the same verdict cannot double-notify;
 * - `done`, `skipped`, a retry that returns the item to `queued` and a report
 *   that lost its lease all emit **nothing** — a notification that says "we
 *   could not use your photo" must never be sent for a photo that was used.
 */

import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";

import {
  app,
  claimSelfie,
  LEASEHOLDER,
  REPORT_PATH,
  RUN_STARTED_AT,
  signedPost,
  submittedSelfie,
  selfieRow,
  workerReportHandler,
  world,
  type SelfieFixture,
} from "../helpers/internal-worker-harness";
import { bodyOf, submitHappyPath } from "../helpers/selfie-flow";

/** The catalogue key this card's producer owes design §4.8. */
const REJECTED = "attendee.selfie.rejected";

/** The catalogue key the sibling decision leaves catalogue-only (ADR-0962 §4). */
const ACCEPTED = "attendee.selfie.accepted";

/** The stored outbox row, as these cases read it (§7.7). */
interface EmittedEventRow {
  readonly _id: ObjectId;
  readonly eventKey: string;
  readonly tenantId: string;
  readonly actorRef: { readonly kind: string; readonly id: string };
  readonly subjectRef: { readonly kind: string; readonly id: string };
  readonly payload: Record<string, unknown>;
  readonly dedupeKey?: string;
}

/**
 * The stored `domain_events` rows of one catalogue key, oldest first.
 *
 * @param eventKey - The catalogue key to read.
 * @returns The matching rows.
 */
async function emitted(eventKey: string): Promise<readonly EmittedEventRow[]> {
  const rows = await app.db
    .collection(COLLECTIONS.domainEvents)
    .find({ eventKey })
    .sort({ _id: 1 })
    .toArray();
  return rows as unknown as readonly EmittedEventRow[];
}

/**
 * Submit one selfie, leave the rejection reason the quality pass would store and
 * claim the row, so the report that follows is meaningful (§10.3.1).
 *
 * @param prefix - The suite-local identity/slug prefix.
 * @param tag - The per-case byte tag and rejection reason marker.
 * @param rejectionReason - `selfies.quality.rejectionReason` to store, or `null`.
 * @returns The fixture, with a claimed selfie row.
 */
async function claimedSelfie(
  prefix: string,
  tag: string,
  rejectionReason: string | null
): Promise<SelfieFixture> {
  const fixture = await submittedSelfie(prefix, tag);
  if (rejectionReason !== null) {
    await app.db
      .collection(COLLECTIONS.selfies)
      .updateOne(
        { _id: new ObjectId(fixture.selfieId) },
        { $set: { "quality.rejectionReason": rejectionReason } }
      );
  }
  await claimSelfie(fixture.selfieId, LEASEHOLDER);
  return fixture;
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

/** The `failed` verdict a face-less photograph earns (§10.3.3). */
const NO_FACE = {
  outcome: "failed",
  quality: { faceCount: 0, accepted: false },
  error: { code: "no_face_detected", message: "no face in frame", retryable: false },
  matchesCreated: 0,
};

describe("when a selfie report settles the selfie as rejected", () => {
  it("emits exactly one attendee.selfie.rejected row", async () => {
    const fixture = await claimedSelfie(
      "op140-selfie-emit",
      "op140-selfie-emit",
      "no_face_detected"
    );

    // Act
    const answer = await reportSelfie({ id: fixture.selfieId, ...NO_FACE });

    // Assert
    expect(answer).toEqual({ applied: 1, leaseLost: 0, rejected: [] });
    expect((await selfieRow(fixture.selfieId))?.processing?.status).toBe("failed");
    expect(await emitted(REJECTED)).toHaveLength(1);
  });

  it("addresses the row to the selfie, in the selfie's own tenant", async () => {
    const fixture = await claimedSelfie(
      "op140-selfie-subject",
      "op140-selfie-subject",
      "low_quality"
    );

    // Act
    await reportSelfie({ id: fixture.selfieId, ...NO_FACE });
    const [row] = await emitted(REJECTED);

    // Assert: the subject is the selfie's id, so the feed row can carry
    // `actionTarget.kind: "selfie"` with a 24-hex id the action endpoint accepts.
    expect(row?.subjectRef).toEqual({ kind: "selfie", id: fixture.selfieId });
    expect(row?.tenantId).toBe(fixture.world.tenantKey);
    // A worker-settled outcome has no user actor: the excluded-recipient rule
    // must never drop the attendee who owns the selfie.
    expect(row?.actorRef.kind).toBe("system");
  });

  it("carries the event, the profile and the row's own rejection reason", async () => {
    const fixture = await claimedSelfie(
      "op140-selfie-payload",
      "op140-selfie-payload",
      "multiple_faces"
    );

    // Act
    await reportSelfie({ id: fixture.selfieId, ...NO_FACE });
    const [row] = await emitted(REJECTED);

    // Assert: `reason` is `selfies.quality.rejectionReason` (§16.4), so a
    // template names the stable code rather than the worker's error text.
    expect(row?.payload).toMatchObject({
      eventId: fixture.world.event.id.toHexString(),
      profileId: fixture.profileId,
      reason: "multiple_faces",
    });
  });

  it("stamps a dedupeKey that names the selfie (design §4.8's 1/attempt identity)", async () => {
    const fixture = await claimedSelfie(
      "op140-selfie-dedupe",
      "op140-selfie-dedupe",
      "no_face_detected"
    );

    // Act
    await reportSelfie({ id: fixture.selfieId, ...NO_FACE });
    const [row] = await emitted(REJECTED);

    // Assert
    expect(row?.dedupeKey).toBeDefined();
    expect(row?.dedupeKey).toContain(fixture.selfieId);
  });

  it("emits no second row when the same verdict is reported again", async () => {
    const fixture = await claimedSelfie(
      "op140-selfie-replay",
      "op140-selfie-replay",
      "no_face_detected"
    );
    await reportSelfie({ id: fixture.selfieId, ...NO_FACE });

    // Act: a worker that retries the POST after the row settled.
    const replay = await reportSelfie({ id: fixture.selfieId, ...NO_FACE });

    // Assert
    expect(replay).toEqual({ applied: 0, leaseLost: 1, rejected: [] });
    expect(await emitted(REJECTED)).toHaveLength(1);
  });

  it("emits one row per rejected attempt, not one per event or per profile", async () => {
    const seeded = await world("op140-selfie-attempts");
    const first = await submitHappyPath(seeded.event.slug, {
      cookie: seeded.cookie,
      ip: seeded.ip,
      tag: "op140-attempt-1",
    });
    const second = await submitHappyPath(seeded.event.slug, {
      cookie: seeded.cookie,
      ip: seeded.ip,
      tag: "op140-attempt-2",
    });
    await claimSelfie(first.selfieId, LEASEHOLDER);
    await claimSelfie(second.selfieId, LEASEHOLDER);

    // Act
    await reportSelfie({ id: first.selfieId, ...NO_FACE });
    await reportSelfie({ id: second.selfieId, ...NO_FACE });
    const rows = await emitted(REJECTED);

    // Assert: two attempts, two rows, two distinct identities.
    expect(rows.map((row) => row.subjectRef.id)).toEqual([first.selfieId, second.selfieId]);
    expect(rows[0]?.dedupeKey).not.toBe(rows[1]?.dedupeKey);
  });
});

describe("when a selfie report settles the selfie as anything else", () => {
  it("emits nothing for a done outcome — neither rejected nor accepted", async () => {
    const fixture = await claimedSelfie("op140-selfie-done", "op140-selfie-done", null);

    // Act
    await reportSelfie({
      id: fixture.selfieId,
      outcome: "done",
      quality: { faceCount: 1, accepted: true },
      liveness: { passed: true, score: 0.93 },
      matchesCreated: 2,
      matchRunStartedAt: RUN_STARTED_AT.toISOString(),
    });

    // Assert: the row settled, and a used photo notifies nobody.
    expect((await selfieRow(fixture.selfieId))?.processing?.status).toBe("done");
    expect(await emitted(REJECTED)).toHaveLength(0);
    expect(await emitted(ACCEPTED)).toHaveLength(0);
  });

  it("emits nothing for a skipped outcome", async () => {
    const fixture = await claimedSelfie("op140-selfie-skipped", "op140-selfie-skipped", null);

    // Act
    await reportSelfie({ id: fixture.selfieId, outcome: "skipped" });

    // Assert
    expect((await selfieRow(fixture.selfieId))?.processing?.status).toBe("skipped");
    expect(await emitted(REJECTED)).toHaveLength(0);
  });

  it("emits nothing while a retryable failure returns the item to the queue", async () => {
    const fixture = await claimedSelfie("op140-selfie-retry", "op140-selfie-retry", null);

    // Act: attempts 1 of 5, so the item goes back to `queued`, not to `failed`.
    await reportSelfie({
      id: fixture.selfieId,
      outcome: "failed",
      error: { code: "inference_timeout", message: "gpu timed out", retryable: true },
    });

    // Assert
    expect((await selfieRow(fixture.selfieId))?.processing?.status).toBe("queued");
    expect(await emitted(REJECTED)).toHaveLength(0);
  });
});
