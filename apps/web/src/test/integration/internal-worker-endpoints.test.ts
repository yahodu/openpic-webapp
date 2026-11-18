/**
 * Integration / contract — the four internal M2M endpoints the Python worker
 * and the thumbnail processor call (OP-135; contract §0.3, §7.6, §10.3.2,
 * §10.3.3; schema §16.1, §18.2; ADR-0028, ADR-0808, ADR-0829).
 *
 * The worker is a **separate process**: it must never embed a notification
 * client, so every cross-boundary fact it produces is written through one of
 * these four routes. That makes the routes the whole write surface of the
 * pipeline, and this file the contract for it. Each route is driven exactly as
 * the worker drives it — imported handler, real `Request`, `Bearer` +
 * `X-Signature` + `X-Timestamp` headers built from `getConfig()` — so the pins
 * are on the observable HTTP answer and on the rows the answer leaves behind,
 * never on a helper.
 *
 * ## What is decided here (and why)
 *
 * - **`workerId` is a top-level field of the report body.** §10.3.2's sample
 *   shows `{items: [...]}` only, but §10.3.1's lease is held by *one worker*
 *   (`processing.workerId`), and the GREEN card's §3 says the report applies
 *   outcomes "with a lease check (workerId + processing status)". A per-item
 *   owner would let one request be two workers' work; the heartbeat already
 *   carries `workerId` at the top level, so the report mirrors it.
 * - **The worker claims before it reports.** These cases set
 *   `processing.workerId`/`leaseExpiresAt` themselves, exactly as §10.3.1's
 *   atomic claim does, because a report is only meaningful for an item a worker
 *   holds. A report for an item someone else holds is `leaseLost`, never a
 *   write (I2).
 * - **`objectKeyRef` is an opaque handle, not a key.** §10.3.2 sends a handle
 *   and the stored `derivatives.<variant>.objectKey` is a key, so the two are
 *   different strings by construction; the pin is that neither the request nor
 *   the answer carries the resolved key (I3).
 * - **A withdrawn profile's late result is discarded.** Consent withdrawal
 *   deletes the selfie rows and their matches (§6.2, ADR-0798), so a report
 *   that lands afterwards must not re-create the data it deleted. The I8 case
 *   builds the race window deliberately — the profile is already `withdrawn`
 *   while the claimed selfie row still exists — because that is the moment the
 *   guard has to hold.
 * - **The selfie arm is what makes a late result visible (§6.4).** A profile
 *   confirmed before its worker ran stays `processing`; only the report can
 *   write `status: ready`, `matchCount` and `lastMatchRunAt`. The watermark is
 *   the run's own `matchRunStartedAt`, never the report instant (§10.3.3).
 *
 * The four routes are `POST` only: the worker writes, it never reads back.
 

 *
 * ## Where the cases live
 *
 * This file is the boundary's contract, and the home of the arms that pin the
 * credential ladder and the selfie report — the two the routes' own records
 * constrain to this path. The rest of the surface lives beside it in three
 * behaviour specs that import the same harness
 * (`../helpers/internal-worker-harness.ts`), so no file has to hold the whole
 * write surface (ADR-0843; the split and its citation table are recorded there):
 *
 * - `internal-worker-batch-heartbeat.test.ts` — I1, the domain-event batch, and
 *   I4, the heartbeat's configuration channel.
 * - `internal-worker-derivative.test.ts` — I3/I7, the derivative report, and F2,
 *   the stored key belongs to the asset that reports it.
 * - `internal-worker-report-limits.test.ts` — F3, the report batch cap; F4, the
 *   lease race; and F6, the event-instant window.
 *
 * The F2/F3/F4/F6 section docblock stayed whole in the derivative file, where
 * it opens F2; the report-limits specs are the continuation it describes.
 *
 */

import { createHash } from "node:crypto";

import { Collection, ObjectId, type Document } from "mongodb";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import {
  createLogger,
  getLogger,
  memoryTransport,
  setLogger,
  type LogEntry,
} from "@/server/logging";

import { APP_ORIGIN } from "../helpers/authed-app";
import {
  DOMAIN_EVENTS_PATH,
  REPORT_PATH,
  PIPELINE_INDEXED_EVENT,
  UNKNOWN_EVENT_KEY,
  LEASEHOLDER,
  OTHER_WORKER,
  BATCH_KEYS,
  REPORT_KEYS,
  ATTEMPTS_ALLOWED,
  RUN_STARTED_AT,
  EVENT_INSTANT_WINDOW_MS,
  OUT_OF_WINDOW_REASON,
  signedPost,
  domainEventsHandler,
  workerReportHandler,
  ENDPOINTS,
  app,
  world,
  seedAsset,
  seedClaimedImage,
  claimSelfie,
  profileRow,
  selfieRow,
  pollParticipation,
  submittedSelfie,
  domainEvent,
  driverFindOne,
  driverUpdateOne,
  filterTargetId,
  type ProfileRow,
  type ImageRow,
  type DomainEventRow,
} from "../helpers/internal-worker-harness.js";
import { bodyOf, confirmSelfie, errorBody, keysOf } from "../helpers/selfie-flow";

/* ────────────────────── I5: the shared refusal ladder ───────────────────── */

/**
 * §0.3's machine credential for every internal route.
 *
 * Four shapes are refused, and each one is a distinct hole: no credential, a
 * wrong bearer, a body signed with another secret, and the Vercel `CRON_SECRET`
 * bearer. The last one is the exception ADR-0028 §1 deliberately scopes to
 * `GET /api/v1/internal/cron/**` — "it cannot be replayed against
 * `/internal/domain-events` or `/internal/worker/*`" — so every one of these
 * four routes must refuse it.
 */
describe("when an internal endpoint is called without a valid machine credential", () => {
  it.each(ENDPOINTS)(
    "I5: $name refuses a request with no credential as internal_auth_failed",
    async (endpoint) => {
      const response = await endpoint.handler(
        new Request(new URL(endpoint.path, APP_ORIGIN), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(endpoint.body),
        })
      );

      expect(response.status).toBe(401);
      expect((await errorBody(response)).code).toBe("internal_auth_failed");
    }
  );

  it.each(ENDPOINTS)(
    "I5: $name refuses a wrong bearer as internal_auth_failed",
    async (endpoint) => {
      const response = await endpoint.handler(
        signedPost(endpoint.path, endpoint.body, {
          bearer: "not-the-internal-api-secret-000000000000",
        })
      );

      expect(response.status).toBe(401);
      expect((await errorBody(response)).code).toBe("internal_auth_failed");
    }
  );

  it.each(ENDPOINTS)(
    "I5: $name refuses a body signed with another secret as invalid_signature",
    async (endpoint) => {
      const response = await endpoint.handler(
        signedPost(endpoint.path, endpoint.body, {
          secret: "wrong-signing-secret-0000000000000000",
        })
      );

      expect(response.status).toBe(401);
      expect((await errorBody(response)).code).toBe("invalid_signature");
    }
  );

  it.each(ENDPOINTS)(
    "I5: $name refuses the CRON_SECRET bearer, so the cron exception cannot be replayed",
    async (endpoint) => {
      const cronSecret = getConfig().cron.secret;
      const response = await endpoint.handler(
        signedPost(endpoint.path, endpoint.body, {
          bearer: cronSecret,
          secret: cronSecret,
        })
      );

      expect(response.status).toBe(401);
      expect((await errorBody(response)).code).toBe("internal_auth_failed");
    }
  );
});

/* ───────────── I2, I6, I8: applying the worker's report ─────────────────── */

describe("when the worker reports an event-image outcome", () => {
  it("marks the image done when the reporter holds the lease", async () => {
    const seeded = await world("op135-report-done");
    const asset = await seedAsset(seeded.tenantKey, "op135-report-done");
    const imageId = await seedClaimedImage(
      seeded.tenantKey,
      seeded.event,
      asset.assetId,
      LEASEHOLDER
    );

    const response = await workerReportHandler(
      signedPost(REPORT_PATH, {
        workerId: LEASEHOLDER,
        items: [
          {
            kind: "event_image",
            id: imageId.toHexString(),
            outcome: "done",
            faceCount: 3,
            durationMs: 3_400,
            modelKeys: {
              detection: "scrfd_10g_bnkps",
              recognition: "insightface-antelopev2-2026-03",
            },
          },
        ],
      })
    );

    expect(response.status).toBe(200);
    const body = await bodyOf(response, 200, "POST internal worker/report");
    expect(keysOf(body)).toEqual(REPORT_KEYS);
    expect(body).toEqual({ applied: 1, leaseLost: 0, rejected: [] });

    const stored = (await app.db
      .collection(COLLECTIONS.eventImages)
      .findOne({ _id: imageId })) as unknown as ImageRow | null;
    expect(stored?.processing).toMatchObject({
      status: "done",
      durationMs: 3_400,
      lastError: null,
    });
    expect(stored?.processing?.finishedAt).toBeInstanceOf(Date);
  });

  it("I2: reports leaseLost and writes nothing when another worker holds the lease", async () => {
    const seeded = await world("op135-report-lease");
    const asset = await seedAsset(seeded.tenantKey, "op135-report-lease");
    const imageId = await seedClaimedImage(
      seeded.tenantKey,
      seeded.event,
      asset.assetId,
      OTHER_WORKER
    );
    const before = await app.db.collection(COLLECTIONS.eventImages).findOne({ _id: imageId });

    const response = await workerReportHandler(
      signedPost(REPORT_PATH, {
        workerId: LEASEHOLDER,
        items: [
          {
            kind: "event_image",
            id: imageId.toHexString(),
            outcome: "done",
            faceCount: 3,
            durationMs: 3_400,
          },
        ],
      })
    );

    expect(response.status).toBe(200);
    expect(await bodyOf(response, 200, "POST internal worker/report")).toEqual({
      applied: 0,
      leaseLost: 1,
      rejected: [],
    });

    // A lease-lost report never overwrites: the row is byte-identical.
    expect(await app.db.collection(COLLECTIONS.eventImages).findOne({ _id: imageId })).toEqual(
      before
    );
  });
});

describe("when the worker reports a selfie outcome", () => {
  it("makes a late result visible on the poll: ready, matchCount and lastMatchRunAt", async () => {
    const fixture = await submittedSelfie("op135-report-visible", "op135-report-visible");
    // Confirmed *before* the worker ran, so the confirmation could not publish a
    // result: the profile is left `processing` (§6.3/§6.4).
    await bodyOf(
      await confirmSelfie(fixture.world.event.slug, fixture.selfieId, {
        cookie: fixture.world.cookie,
        ip: fixture.world.ip,
      }),
      200,
      `POST confirm on ${fixture.world.event.slug}`
    );
    const beforeReport = await pollParticipation(fixture.world.event.slug, fixture.world);
    expect(beforeReport.status).toBe("processing");
    expect(beforeReport.matchCount).toBe(0);

    await claimSelfie(fixture.selfieId, LEASEHOLDER);
    const response = await workerReportHandler(
      signedPost(REPORT_PATH, {
        workerId: LEASEHOLDER,
        items: [
          {
            kind: "selfie",
            id: fixture.selfieId,
            outcome: "done",
            quality: { faceCount: 1, accepted: true },
            liveness: { passed: true, score: 0.91 },
            matchesCreated: 3,
            matchRunStartedAt: RUN_STARTED_AT.toISOString(),
          },
        ],
      })
    );

    expect(response.status).toBe(200);
    expect(await bodyOf(response, 200, "POST internal worker/report")).toEqual({
      applied: 1,
      leaseLost: 0,
      rejected: [],
    });

    const afterReport = await pollParticipation(fixture.world.event.slug, fixture.world);
    expect(afterReport.status).toBe("ready");
    expect(afterReport.matchCount).toBe(3);
    // The watermark is the run's own start instant, never the report instant.
    expect(afterReport.lastMatchRunAt).toBe(RUN_STARTED_AT.toISOString());
  });

  it("I6: a liveness-failed report leaves no embedding, fails the profile and spends the attempt", async () => {
    const fixture = await submittedSelfie("op135-report-liveness", "op135-report-liveness");
    await bodyOf(
      await confirmSelfie(fixture.world.event.slug, fixture.selfieId, {
        cookie: fixture.world.cookie,
        ip: fixture.world.ip,
      }),
      200,
      `POST confirm on ${fixture.world.event.slug}`
    );
    await claimSelfie(fixture.selfieId, LEASEHOLDER);

    const response = await workerReportHandler(
      signedPost(REPORT_PATH, {
        workerId: LEASEHOLDER,
        items: [
          {
            kind: "selfie",
            id: fixture.selfieId,
            outcome: "failed",
            error: { code: "liveness_failed", message: "screen replay detected", retryable: false },
            liveness: { passed: false, score: 0.11 },
          },
        ],
      })
    );

    expect(response.status).toBe(200);
    expect(await bodyOf(response, 200, "POST internal worker/report")).toEqual({
      applied: 1,
      leaseLost: 0,
      rejected: [],
    });

    // No biometric artefact is written for a selfie the platform rejected.
    const stored = await selfieRow(fixture.selfieId);
    expect(stored?.embedding).toBeUndefined();
    expect(stored?.processing).toMatchObject({
      status: "failed",
      lastError: { code: "liveness_failed" },
    });

    const profile = await profileRow();
    expect(profile.status).toBe("failed");

    // §6.4 renders the failure from the pipeline's code, and the failed attempt
    // is spent — an attempt is a stored selfie row (§6.3/§14.1, ADR-0792).
    const participation = await pollParticipation(fixture.world.event.slug, fixture.world);
    expect(participation.status).toBe("failed");
    expect(participation.statusDetail).toMatchObject({ code: "liveness_failed" });
    const selfie = participation.selfie as { attemptsUsed?: unknown; attemptsRemaining?: unknown };
    expect(selfie.attemptsUsed).toBe(1);
    expect(selfie.attemptsRemaining).toBe(ATTEMPTS_ALLOWED - 1);
  });

  it("I8: discards a report for a withdrawn profile: nothing written, nothing emitted", async () => {
    const fixture = await submittedSelfie("op135-report-withdrawn", "op135-report-withdrawn");
    await bodyOf(
      await confirmSelfie(fixture.world.event.slug, fixture.selfieId, {
        cookie: fixture.world.cookie,
        ip: fixture.world.ip,
      }),
      200,
      `POST confirm on ${fixture.world.event.slug}`
    );
    await claimSelfie(fixture.selfieId, LEASEHOLDER);

    // The race window: the withdrawal has committed its `withdrawn` status while
    // the claimed selfie row the worker is finishing still exists.
    const profileBefore = await profileRow();
    await app.db
      .collection(COLLECTIONS.attendeeEventProfiles)
      .updateOne({ _id: profileBefore._id }, { $set: { status: "withdrawn" } });
    const withdrawnProfile = await profileRow();
    const selfieBefore = await selfieRow(fixture.selfieId);
    const eventsBefore = await app.db.collection(COLLECTIONS.domainEvents).countDocuments({});

    const response = await workerReportHandler(
      signedPost(REPORT_PATH, {
        workerId: LEASEHOLDER,
        items: [
          {
            kind: "selfie",
            id: fixture.selfieId,
            outcome: "done",
            quality: { faceCount: 1, accepted: true },
            liveness: { passed: true, score: 0.94 },
            matchesCreated: 3,
            matchRunStartedAt: RUN_STARTED_AT.toISOString(),
          },
        ],
      })
    );

    expect(response.status).toBe(200);
    const body = await bodyOf(response, 200, "POST internal worker/report");
    expect(body).toEqual({
      applied: 0,
      leaseLost: 0,
      rejected: [{ index: 0, id: fixture.selfieId, reason: "profile_withdrawn" }],
    });

    // The projection, the row and the outbox are all untouched.
    expect(await profileRow()).toEqual(withdrawnProfile);
    expect(await selfieRow(fixture.selfieId)).toEqual(selfieBefore);
    expect(await app.db.collection(COLLECTIONS.faceMatches).countDocuments({})).toBe(0);
    expect(await app.db.collection(COLLECTIONS.domainEvents).countDocuments({})).toBe(eventsBefore);

    // ...and the attendee's own surface still reports the withdrawal.
    const participation = await pollParticipation(fixture.world.event.slug, fixture.world);
    expect(participation.status).toBe("withdrawn");
    expect(participation.matchCount).toBe(0);
  });

  it("discards a superseded selfie's result: the active profile keeps its own count and watermark", async () => {
    const fixture = await submittedSelfie("op135-report-superseded", "op135-report-superseded");
    // The worker still holds the lease on the row it is finishing, so the lease
    // check is not what this case is about: the report is *this* worker's.
    await claimSelfie(fixture.selfieId, LEASEHOLDER);

    // The race ADR-0829 §1 and ADR-0830 §9 name, pinned by ADR-0832: the attendee
    // has since handed in a **newer** selfie, so the profile's live result belongs
    // to that row, never to the superseded one the worker is finishing. Seeded
    // rather than raced — the window is a state (one superseded row plus one
    // active one), not a timing gap — and `activeSelfieId` names a row the worker
    // does not report, which is all the discarded arm may be decided on.
    const newerRunStartedAt = new Date("2026-09-25T12:00:00.000Z");
    const supersededRunStartedAt = new Date("2026-09-25T09:10:00.000Z");
    const liveProfile = await profileRow();
    await app.db.collection(COLLECTIONS.attendeeEventProfiles).updateOne(
      { _id: liveProfile._id },
      {
        $set: {
          activeSelfieId: new ObjectId(),
          status: "ready",
          matchCount: 7,
          lastMatchRunAt: newerRunStartedAt,
        },
      }
    );
    const profileBefore = await profileRow();

    const response = await workerReportHandler(
      signedPost(REPORT_PATH, {
        workerId: LEASEHOLDER,
        items: [
          {
            kind: "selfie",
            id: fixture.selfieId,
            outcome: "done",
            matchesCreated: 0,
            matchRunStartedAt: supersededRunStartedAt.toISOString(),
          },
        ],
      })
    );

    // The item is this worker's, so it is applied: discarding the **profile**
    // write is neither `leaseLost` (the lease is held) nor `rejected` (the row
    // exists). Keeping `applied` at 1 is what makes re-delivering the report a
    // no-op with the same answer.
    expect(response.status).toBe(200);
    expect(await bodyOf(response, 200, "POST internal worker/report")).toEqual({
      applied: 1,
      leaseLost: 0,
      rejected: [],
    });

    // The live result belongs to the newer selfie: nothing about this report may
    // move it. An unguarded write stores this item's own `matchesCreated` (0) and
    // rewinds the watermark to the superseded run's start, and §10.3.3's
    // watermark is the incremental search's lower bound (`createdAt >
    // lastMatchRunAt`), so a rewind re-scores every already-matched face and the
    // §6.4 poll shows a count that just fell.
    const profileAfter = await profileRow();
    expect({
      status: profileAfter.status,
      matchCount: profileAfter.matchCount,
      lastMatchRunAt: profileAfter.lastMatchRunAt,
    }).toEqual({
      status: "ready",
      matchCount: 7,
      lastMatchRunAt: newerRunStartedAt,
    });
    expect(profileAfter).toEqual(profileBefore);

    // The item's **own** row is not the profile: its verdict is still recorded.
    expect((await selfieRow(fixture.selfieId))?.processing).toMatchObject({
      status: "done",
      lastError: null,
    });
  });

  /*
   * P1–P4 pin the discard's own line and the arms beside it (ADR-0836): the
   * null pointer, a `failed` verdict and a `skipped` one.
   */

  /** The superseded profile's live watermark: the newer selfie's run instant. */
  const SUPERSEDED_NEWER_RUN = new Date("2026-09-25T12:00:00.000Z");

  /** The process logger a case found installed, put back after every case. */
  let loggerBeforeCase: ReturnType<typeof getLogger> | undefined;

  /**
   * Install a memory-backed process logger so a case can read what the route
   * emitted.
   *
   * `@/server/logging` has no `resetLogger`, so a case that left this logger in
   * place would silence every later case in the file; the `afterEach` below
   * restores the one the case found.
   *
   * @returns The sink the route's entries land in.
   */
  function installLogSink(): ReturnType<typeof memoryTransport> {
    loggerBeforeCase = getLogger();
    const sink = memoryTransport();
    setLogger(createLogger({ level: "info", transports: [sink] }));
    return sink;
  }

  /**
   * The discard lines a case's sink captured.
   *
   * @param sink - The transport {@link installLogSink} returned.
   * @returns Every `worker.report_discarded` entry, in emission order.
   */
  function discardEntries(sink: ReturnType<typeof memoryTransport>): LogEntry[] {
    return sink.entries.filter((entry) => entry.event === "worker.report_discarded");
  }

  afterEach(() => {
    if (loggerBeforeCase !== undefined) {
      setLogger(loggerBeforeCase);
      loggerBeforeCase = undefined;
    }
  });

  /**
   * Seed ADR-0832's superseded state: the item is this worker's, and the
   * profile's live result belongs to a **different** selfie.
   *
   * @returns The profile as it stands before the report.
   */
  async function seedSupersededProfile(): Promise<ProfileRow> {
    const profile = await profileRow();
    await app.db.collection(COLLECTIONS.attendeeEventProfiles).updateOne(
      { _id: profile._id },
      {
        $set: {
          activeSelfieId: new ObjectId(),
          status: "ready",
          matchCount: 7,
          lastMatchRunAt: SUPERSEDED_NEWER_RUN,
        },
      }
    );
    return await profileRow();
  }

  it("P1: logs one warn when a superseded report withholds the profile write", async () => {
    const fixture = await submittedSelfie("op135-discard-log", "op135-discard-log");
    await claimSelfie(fixture.selfieId, LEASEHOLDER);
    await seedSupersededProfile();
    // Installed after the seed, so the sink holds this request's lines only.
    const sink = installLogSink();

    const response = await workerReportHandler(
      signedPost(REPORT_PATH, {
        workerId: LEASEHOLDER,
        items: [
          {
            kind: "selfie",
            id: fixture.selfieId,
            outcome: "done",
            matchesCreated: 0,
            matchRunStartedAt: SUPERSEDED_NEWER_RUN.toISOString(),
          },
        ],
      })
    );

    expect(response.status).toBe(200);
    expect(await bodyOf(response, 200, "POST internal worker/report")).toEqual({
      applied: 1,
      leaseLost: 0,
      rejected: [],
    });

    // A withheld write is not silent (ADR-0833 §2): one warn naming the item
    // that was discarded, this worker and the stable reason — no profile id and
    // no biometric field.
    const discarded = discardEntries(sink);
    expect(discarded).toHaveLength(1);
    expect(discarded[0]).toMatchObject({
      event: "worker.report_discarded",
      level: "warn",
      kind: "selfie",
      id: fixture.selfieId,
      workerId: LEASEHOLDER,
      reason: "superseded_selfie",
    });
  });

  it("P1: logs nothing when the profile's active selfie is the reported row", async () => {
    const fixture = await submittedSelfie("op135-discard-allowed", "op135-discard-allowed");
    // The confirmation points the profile at **this** row, so the report carries
    // the live result and the guard has nothing to withhold.
    await bodyOf(
      await confirmSelfie(fixture.world.event.slug, fixture.selfieId, {
        cookie: fixture.world.cookie,
        ip: fixture.world.ip,
      }),
      200,
      `POST confirm on ${fixture.world.event.slug}`
    );
    await claimSelfie(fixture.selfieId, LEASEHOLDER);
    const sink = installLogSink();

    const response = await workerReportHandler(
      signedPost(REPORT_PATH, {
        workerId: LEASEHOLDER,
        items: [
          {
            kind: "selfie",
            id: fixture.selfieId,
            outcome: "done",
            quality: { faceCount: 1, accepted: true },
            matchesCreated: 3,
            matchRunStartedAt: RUN_STARTED_AT.toISOString(),
          },
        ],
      })
    );

    expect(response.status).toBe(200);
    // No line, because nothing was discarded...
    expect(discardEntries(sink)).toEqual([]);

    // ...and the write it must not withhold happened, which is the half that
    // fails if the log fires unconditionally.
    const profileAfter = await profileRow();
    expect({
      status: profileAfter.status,
      matchCount: profileAfter.matchCount,
      lastMatchRunAt: profileAfter.lastMatchRunAt,
    }).toEqual({ status: "ready", matchCount: 3, lastMatchRunAt: RUN_STARTED_AT });
  });

  it("P2: writes the profile when it has no active selfie pointer", async () => {
    const fixture = await submittedSelfie("op135-null-pointer", "op135-null-pointer");
    await claimSelfie(fixture.selfieId, LEASEHOLDER);
    // A submit leaves the pointer null; it is set here explicitly so a change to
    // the submit's own default cannot retarget this pin.
    const profileBefore = await profileRow();
    await app.db
      .collection(COLLECTIONS.attendeeEventProfiles)
      .updateOne({ _id: profileBefore._id }, { $set: { activeSelfieId: null } });
    const sink = installLogSink();

    const response = await workerReportHandler(
      signedPost(REPORT_PATH, {
        workerId: LEASEHOLDER,
        items: [
          {
            kind: "selfie",
            id: fixture.selfieId,
            outcome: "done",
            quality: { faceCount: 1, accepted: true },
            matchesCreated: 4,
            matchRunStartedAt: RUN_STARTED_AT.toISOString(),
          },
        ],
      })
    );

    expect(response.status).toBe(200);
    expect(await bodyOf(response, 200, "POST internal worker/report")).toEqual({
      applied: 1,
      leaseLost: 0,
      rejected: [],
    });

    // A null pointer is not superseded: there is no live result to protect, so
    // the §6.4 projection is written (ADR-0832 §4, ADR-0833 §1). Inverting the
    // guard's `!= null` reddens exactly this case.
    const profileAfter = await profileRow();
    expect({
      status: profileAfter.status,
      matchCount: profileAfter.matchCount,
      lastMatchRunAt: profileAfter.lastMatchRunAt,
    }).toEqual({ status: "ready", matchCount: 4, lastMatchRunAt: RUN_STARTED_AT });
    expect(discardEntries(sink)).toEqual([]);
  });

  it("P3: discards a failed verdict on a superseded row as well", async () => {
    const fixture = await submittedSelfie("op135-superseded-failed", "op135-superseded-failed");
    await claimSelfie(fixture.selfieId, LEASEHOLDER);
    const profileBefore = await seedSupersededProfile();
    const sink = installLogSink();

    const response = await workerReportHandler(
      signedPost(REPORT_PATH, {
        workerId: LEASEHOLDER,
        items: [
          {
            kind: "selfie",
            id: fixture.selfieId,
            outcome: "failed",
            error: { code: "face_detection_failed", message: "no face found", retryable: false },
          },
        ],
      })
    );

    expect(response.status).toBe(200);
    expect(await bodyOf(response, 200, "POST internal worker/report")).toEqual({
      applied: 1,
      leaseLost: 0,
      rejected: [],
    });

    // A failure is discarded as well (`decision.status !== "skipped"`): a
    // superseded row must not mark the **active** profile `failed`.
    expect(await profileRow()).toEqual(profileBefore);
    const profileAfter = await profileRow();
    expect({
      status: profileAfter.status,
      matchCount: profileAfter.matchCount,
      lastMatchRunAt: profileAfter.lastMatchRunAt,
    }).toEqual({ status: "ready", matchCount: 7, lastMatchRunAt: SUPERSEDED_NEWER_RUN });

    // The item's **own** row still records the verdict...
    expect((await selfieRow(fixture.selfieId))?.processing).toMatchObject({
      status: "failed",
      lastError: { code: "face_detection_failed" },
    });

    // ...and the withheld profile write is announced once.
    const discarded = discardEntries(sink);
    expect(discarded).toHaveLength(1);
    expect(discarded[0]).toMatchObject({
      event: "worker.report_discarded",
      level: "warn",
      kind: "selfie",
      id: fixture.selfieId,
      workerId: LEASEHOLDER,
      reason: "superseded_selfie",
    });
  });

  it("P4: a skipped verdict on a superseded row writes nothing and logs nothing", async () => {
    const fixture = await submittedSelfie("op135-superseded-skipped", "op135-superseded-skipped");
    await claimSelfie(fixture.selfieId, LEASEHOLDER);
    const profileBefore = await seedSupersededProfile();
    const sink = installLogSink();

    const response = await workerReportHandler(
      signedPost(REPORT_PATH, {
        workerId: LEASEHOLDER,
        items: [{ kind: "selfie", id: fixture.selfieId, outcome: "skipped" }],
      })
    );

    expect(response.status).toBe(200);
    expect(await bodyOf(response, 200, "POST internal worker/report")).toEqual({
      applied: 1,
      leaseLost: 0,
      rejected: [],
    });

    // `skipped` never wrote the profile in the first place, so the guard has
    // nothing to withhold and nothing to announce (ADR-0833 §2).
    expect(await profileRow()).toEqual(profileBefore);
    expect(discardEntries(sink)).toEqual([]);

    // ...while the item's own row still carries the verdict.
    expect((await selfieRow(fixture.selfieId))?.processing).toMatchObject({
      status: "skipped",
      lastError: null,
    });
  });

  /**
   * P5 — the discard line's **field set**, not only the six fields P1 matches.
   *
   * ADR-0833 §2 decides that the withheld-write announcement carries the three
   * non-PII identifiers (`kind`, `id`, `workerId`) plus the stable `reason` and
   * nothing else: no profile id and no biometric field may ride it, because the
   * line is shipped to the operator's log vendor. P1's `toMatchObject` cannot
   * enforce that half of the decision — it permits extra keys — so a change that
   * added `profileId`, an `embedding` handle or a contact to that `warn` would
   * leave every other case in this file green. This case pins the entry's own
   * key set instead (the logger's three envelope fields and the four call-site
   * fields), sorted so the assertion names the set rather than the emission
   * order, and repeats the absence per PII name so a failure names the field.
   * ADR-0840 records this pin and the two mutations that prove it bites.
   */
  it("P5: logs the discard with exactly its eight non-PII fields and no profile id", async () => {
    // The P1 seed: this worker holds the lease, the profile's live result
    // belongs to a different selfie, so the profile write is withheld.
    const fixture = await submittedSelfie("op135-discard-fields", "op135-discard-fields");
    await claimSelfie(fixture.selfieId, LEASEHOLDER);
    await seedSupersededProfile();
    const sink = installLogSink();

    const response = await workerReportHandler(
      signedPost(REPORT_PATH, {
        workerId: LEASEHOLDER,
        items: [
          {
            kind: "selfie",
            id: fixture.selfieId,
            outcome: "done",
            matchesCreated: 0,
            matchRunStartedAt: SUPERSEDED_NEWER_RUN.toISOString(),
          },
        ],
      })
    );

    expect(response.status).toBe(200);
    expect(await bodyOf(response, 200, "POST internal worker/report")).toEqual({
      applied: 1,
      leaseLost: 0,
      rejected: [],
    });

    const discarded = discardEntries(sink);
    expect(discarded).toHaveLength(1);
    const entry = discarded[0];
    if (entry === undefined) {
      throw new Error(
        "the withheld profile write was not announced, so its field set cannot be measured"
      );
    }

    // `ts`/`level`/`msg` come from the logger's envelope; the four others are
    // the call site's. Anything else on this entry is a field the decision did
    // not sanction, which is what makes this an exact set rather than a subset.
    expect(Object.keys(entry).sort()).toEqual([
      "event",
      "id",
      "kind",
      "level",
      "msg",
      "reason",
      "ts",
      "workerId",
    ]);

    // Named one by one, so the failure says which field leaked rather than only
    // that the set grew (ADR-0833 §2's negative list).
    expect(entry).not.toHaveProperty("profileId");
    expect(entry).not.toHaveProperty("subject");
    expect(entry).not.toHaveProperty("embedding");
    expect(entry).not.toHaveProperty("email");
    expect(entry).not.toHaveProperty("phone");
  });
});

describe("when the profile write of a selfie report fails", () => {
  it("F4: leaves the selfie row unapplied, so the pair is never half-written", async () => {
    const fixture = await submittedSelfie("op135-f4-atomic", "op135-f4-atomic");
    await bodyOf(
      await confirmSelfie(fixture.world.event.slug, fixture.selfieId, {
        cookie: fixture.world.cookie,
        ip: fixture.world.ip,
      }),
      200,
      `POST confirm on ${fixture.world.event.slug}`
    );
    await claimSelfie(fixture.selfieId, LEASEHOLDER);
    const selfieBefore = await selfieRow(fixture.selfieId);
    const profileBefore = await profileRow();

    const failure = Object.assign(new Error("write refused by the pin"), { code: 2 });
    const updateSpy = vi.spyOn(Collection.prototype, "updateOne").mockImplementation(function (
      this: Collection,
      ...args: Parameters<typeof driverUpdateOne>
    ) {
      if (this.collectionName === COLLECTIONS.attendeeEventProfiles) {
        return Promise.reject(failure);
      }
      return driverUpdateOne.call(this, ...args);
    } as never);

    let response: Response;
    try {
      response = await workerReportHandler(
        signedPost(REPORT_PATH, {
          workerId: LEASEHOLDER,
          items: [
            {
              kind: "selfie",
              id: fixture.selfieId,
              outcome: "done",
              quality: { faceCount: 1, accepted: true },
              matchesCreated: 3,
              matchRunStartedAt: RUN_STARTED_AT.toISOString(),
            },
          ],
        })
      );
    } finally {
      updateSpy.mockRestore();
    }

    // A failed write is never answered as success.
    expect(response.status).toBe(500);
    expect((await errorBody(response)).code).toBe("internal_error");

    // ...and it leaves no half of the pair behind: the selfie row is untouched,
    // so a retry still finds the item in `processing` rather than a `done` row
    // beside a profile that never learned the run finished.
    expect(await selfieRow(fixture.selfieId)).toEqual(selfieBefore);
    expect((await selfieRow(fixture.selfieId))?.processing).toMatchObject({ status: "processing" });
    expect(await profileRow()).toEqual(profileBefore);
  });
});

/* ───── F-A: the pointer decides at write time, not at read (ADR-0837) ────── */

/**
 * The profile facts this pin turns on (§15.3, §6.4).
 *
 * `activeSelfieId` is the one that matters: the route reads it to decide
 * `supersededSelfie`, so a confirmation that moves it between that read and the
 * profile write must still stop the write.
 */
interface PointerProfile {
  readonly activeSelfieId?: ObjectId | null;
  readonly matchCount?: number;
  readonly lastMatchRunAt?: Date | null;
}

describe("when the active selfie moves while a selfie report is being applied", () => {
  /** The instant the superseded report's own run started. */
  const STALE_RUN_STARTED_AT = new Date("2026-09-25T09:30:00.000Z");

  /** The instant the newer confirmation's run started — the live watermark. */
  const NEWER_RUN_STARTED_AT = new Date("2026-09-25T12:00:00.000Z");

  /** The match count the newer confirmation published. */
  const NEWER_MATCH_COUNT = 7;

  /** The match count the superseded report carries. */
  const STALE_MATCH_COUNT = 2;

  it("F-A: keeps the newer selfie's count and watermark and still applies the item", async () => {
    const fixture = await submittedSelfie("op135-pointer-race", "op135-pointer-race");
    // The confirmation points the profile at the very row the worker is about to
    // report, so the route's own read answers `supersededSelfie === false`. The
    // pointer moves only afterwards, inside the window this case pins.
    await bodyOf(
      await confirmSelfie(fixture.world.event.slug, fixture.selfieId, {
        cookie: fixture.world.cookie,
        ip: fixture.world.ip,
      }),
      200,
      `POST confirm on ${fixture.world.event.slug}`
    );
    await claimSelfie(fixture.selfieId, LEASEHOLDER);

    const profile = await profileRow();
    // The second, newer selfie a later submission leaves behind: a real row of
    // this profile's on this event, already finished. The flip below points the
    // profile at it, so the state the stale report must not touch is one a
    // confirmation could have produced. Nothing in the report path reads it.
    const newerSelfieId = new ObjectId();
    await app.db.collection(COLLECTIONS.selfies).insertOne({
      _id: newerSelfieId,
      tenantId: fixture.world.tenantKey,
      eventId: fixture.world.event.id,
      profileId: profile._id,
      subject: profile.subject,
      contentHash: createHash("sha256").update("op135-pointer-race-newer").digest("hex"),
      liveness: { required: true, challengeKind: "gesture", passed: true, score: 0.94 },
      processing: {
        status: "done",
        priority: "high",
        attempts: 1,
        maxAttempts: 5,
        leaseExpiresAt: null,
        workerId: OTHER_WORKER,
        queuedAt: NEWER_RUN_STARTED_AT,
        startedAt: NEWER_RUN_STARTED_AT,
        finishedAt: NEWER_RUN_STARTED_AT,
        durationMs: 900,
        lastError: null,
        queueRef: null,
      },
      isActive: true,
      createdAt: NEWER_RUN_STARTED_AT,
    });

    /** What the newer confirmation leaves on the profile. */
    const flip = {
      activeSelfieId: newerSelfieId,
      status: "ready",
      matchCount: NEWER_MATCH_COUNT,
      lastMatchRunAt: NEWER_RUN_STARTED_AT,
      updatedAt: NEWER_RUN_STARTED_AT,
    };

    // The window: this request's own profile read is held open, a confirmation
    // flips the pointer to the newer selfie in the meantime, and only then does
    // the held read resolve with the profile as it was **before** that flip. A
    // write that repeats the read's verdict instead of carrying the pointer as a
    // predicate of the write now overwrites a result it no longer owns.
    const held: { opened: boolean; flipped: Document | null } = { opened: false, flipped: null };
    const findOneSpy = vi.spyOn(Collection.prototype, "findOne").mockImplementation(function (
      this: Collection,
      ...args: Parameters<typeof driverFindOne>
    ) {
      if (held.opened || this.collectionName !== COLLECTIONS.attendeeEventProfiles) {
        return driverFindOne.call(this, ...args);
      }
      if (filterTargetId(args[0]) !== profile._id.toHexString()) {
        return driverFindOne.call(this, ...args);
      }
      held.opened = true;
      return (async () => {
        const snapshot = await driverFindOne.call(this, ...args);
        await app.db
          .collection(COLLECTIONS.attendeeEventProfiles)
          .updateOne({ _id: profile._id }, { $set: flip });
        // The window is open, so this read falls through to the driver.
        held.flipped = await app.db
          .collection(COLLECTIONS.attendeeEventProfiles)
          .findOne({ _id: profile._id });
        return snapshot;
      })();
    } as never);

    let response: Response;
    try {
      response = await workerReportHandler(
        signedPost(REPORT_PATH, {
          workerId: LEASEHOLDER,
          items: [
            {
              kind: "selfie",
              id: fixture.selfieId,
              outcome: "done",
              quality: { faceCount: 1, accepted: true },
              matchesCreated: STALE_MATCH_COUNT,
              matchRunStartedAt: STALE_RUN_STARTED_AT.toISOString(),
            },
          ],
        })
      );
    } finally {
      findOneSpy.mockRestore();
    }

    // Without the held read there is no window, so say that instead of passing:
    // a green here would mean this case measures nothing.
    if (!held.opened) {
      throw new Error("the route never read the profile, so the pinned window never opened");
    }
    const beforeFlip = held.flipped;
    if (beforeFlip === null) {
      throw new Error("the pointer flip left no profile to compare against");
    }

    expect(response.status).toBe(200);
    // ADR-0832 §2: a discarded **profile** write is still an applied item — the
    // row's own verdict landed and this worker held the lease.
    expect(
      await bodyOf(response, 200, "POST internal worker/report after the pointer flip")
    ).toEqual({ applied: 1, leaseLost: 0, rejected: [] });

    // The live result belongs to the newer selfie: this report may not move the
    // count or rewind the watermark (§10.3.3 makes the watermark the incremental
    // search's lower bound, so a rewind re-scores every already-matched face).
    const profileAfter = (await app.db
      .collection(COLLECTIONS.attendeeEventProfiles)
      .findOne({ _id: profile._id })) as unknown as PointerProfile | null;
    expect({
      activeSelfieId: profileAfter?.activeSelfieId,
      matchCount: profileAfter?.matchCount,
      lastMatchRunAt: profileAfter?.lastMatchRunAt,
    }).toEqual({
      activeSelfieId: newerSelfieId,
      matchCount: NEWER_MATCH_COUNT,
      lastMatchRunAt: NEWER_RUN_STARTED_AT,
    });
    expect(profileAfter).toEqual(beforeFlip);

    // ...while the item's own row still records the verdict.
    expect((await selfieRow(fixture.selfieId))?.processing).toMatchObject({
      status: "done",
      lastError: null,
    });
  });

  /**
   * The same window with the **other** verdict (ADR-0839).
   *
   * The report's profile projection sits behind `decision.status !== "skipped"`,
   * so the `failed` arm takes the identical write with a different `$set`
   * (`status: "failed"` plus `updatedAt`). A superseded `failed` report is
   * therefore the same ADR-0832 §2 / ADR-0833 §2 defect as F-A — raced, not
   * sequential (ADR-0836's P3 pins only the sequential form) — and it is
   * measured worse: it does not merely move the count and the watermark, it
   * tells the newer selfie's profile that its own result failed, which is what
   * §6.4 renders to the attendee.
   */
  it("F-B: a superseded failed verdict leaves the newer selfie's profile ready", async () => {
    const fixture = await submittedSelfie("op135-pointer-race-failed", "op135-pointer-race-failed");
    // As in F-A: the confirmation points the profile at the row the worker is
    // about to report, so the write this case races is one that *would* match on
    // `_id` alone. Only the pointer separates the two selfies.
    await bodyOf(
      await confirmSelfie(fixture.world.event.slug, fixture.selfieId, {
        cookie: fixture.world.cookie,
        ip: fixture.world.ip,
      }),
      200,
      `POST confirm on ${fixture.world.event.slug}`
    );
    await claimSelfie(fixture.selfieId, LEASEHOLDER);

    const profile = await profileRow();
    // The newer selfie the confirmation flip below points the profile at — a
    // real, finished row of this profile's on this event. Nothing in the report
    // path reads it; the failed verdict never carries matches.
    const newerSelfieId = new ObjectId();
    await app.db.collection(COLLECTIONS.selfies).insertOne({
      _id: newerSelfieId,
      tenantId: fixture.world.tenantKey,
      eventId: fixture.world.event.id,
      profileId: profile._id,
      subject: profile.subject,
      contentHash: createHash("sha256").update("op135-pointer-race-failed").digest("hex"),
      liveness: { required: true, challengeKind: "gesture", passed: true, score: 0.94 },
      processing: {
        status: "done",
        priority: "high",
        attempts: 1,
        maxAttempts: 5,
        leaseExpiresAt: null,
        workerId: OTHER_WORKER,
        queuedAt: NEWER_RUN_STARTED_AT,
        startedAt: NEWER_RUN_STARTED_AT,
        finishedAt: NEWER_RUN_STARTED_AT,
        durationMs: 900,
        lastError: null,
        queueRef: null,
      },
      isActive: true,
      createdAt: NEWER_RUN_STARTED_AT,
    });

    /** What the newer confirmation leaves on the profile. */
    const flip = {
      activeSelfieId: newerSelfieId,
      status: "ready",
      matchCount: NEWER_MATCH_COUNT,
      lastMatchRunAt: NEWER_RUN_STARTED_AT,
      updatedAt: NEWER_RUN_STARTED_AT,
    };

    // The window: this request's own profile read is held open, a confirmation
    // flips the pointer to the newer selfie in the meantime, and only then does
    // the held read resolve with the profile as it was **before** that flip.
    const held: { opened: boolean; flipped: Document | null } = { opened: false, flipped: null };
    const findOneSpy = vi.spyOn(Collection.prototype, "findOne").mockImplementation(function (
      this: Collection,
      ...args: Parameters<typeof driverFindOne>
    ) {
      if (held.opened || this.collectionName !== COLLECTIONS.attendeeEventProfiles) {
        return driverFindOne.call(this, ...args);
      }
      if (filterTargetId(args[0]) !== profile._id.toHexString()) {
        return driverFindOne.call(this, ...args);
      }
      held.opened = true;
      return (async () => {
        const snapshot = await driverFindOne.call(this, ...args);
        await app.db
          .collection(COLLECTIONS.attendeeEventProfiles)
          .updateOne({ _id: profile._id }, { $set: flip });
        // The window is open, so this read falls through to the driver.
        held.flipped = await app.db
          .collection(COLLECTIONS.attendeeEventProfiles)
          .findOne({ _id: profile._id });
        return snapshot;
      })();
    } as never);

    let response: Response;
    try {
      response = await workerReportHandler(
        signedPost(REPORT_PATH, {
          workerId: LEASEHOLDER,
          items: [
            {
              kind: "selfie",
              id: fixture.selfieId,
              outcome: "failed",
              error: { code: "face_detection_failed", message: "no face found", retryable: false },
            },
          ],
        })
      );
    } finally {
      findOneSpy.mockRestore();
    }

    // Without the held read there is no window, so say that instead of passing:
    // a green here would mean this case measures nothing.
    if (!held.opened) {
      throw new Error("the route never read the profile, so the pinned window never opened");
    }
    const beforeFlip = held.flipped;
    if (beforeFlip === null) {
      throw new Error("the pointer flip left no profile to compare against");
    }

    expect(response.status).toBe(200);
    // ADR-0832 §2: a discarded **profile** write is still an applied item — the
    // row's own verdict landed and this worker held the lease.
    expect(
      await bodyOf(response, 200, "POST internal worker/report after the pointer flip")
    ).toEqual({ applied: 1, leaseLost: 0, rejected: [] });

    // The live result still belongs to the newer selfie: a superseded failure
    // may not tell this profile that its own result failed, and may not stamp
    // this report's instant on it either.
    const profileAfter = (await app.db
      .collection(COLLECTIONS.attendeeEventProfiles)
      .findOne({ _id: profile._id })) as unknown as
      | (PointerProfile & {
          readonly status?: string;
        })
      | null;
    expect({
      activeSelfieId: profileAfter?.activeSelfieId,
      status: profileAfter?.status,
      matchCount: profileAfter?.matchCount,
      lastMatchRunAt: profileAfter?.lastMatchRunAt,
    }).toEqual({
      activeSelfieId: newerSelfieId,
      status: "ready",
      matchCount: NEWER_MATCH_COUNT,
      lastMatchRunAt: NEWER_RUN_STARTED_AT,
    });
    expect(profileAfter).toEqual(beforeFlip);

    // ...while the item's own row still records the verdict it was given.
    expect((await selfieRow(fixture.selfieId))?.processing).toMatchObject({
      status: "failed",
      lastError: { code: "face_detection_failed" },
    });
  });
});

/* ── F-B: the refusal precedence for a doubly-invalid item (ADR-0842) ─────── */

/**
 * Finding **F-B** of ADR-0835 §"Review sign-off (round 1, artifact lens)",
 * pinned by ADR-0842. One item is refused for **two** independent reasons at
 * once — its `occurredAt` is more than 24 h ahead of the platform clock *and*
 * its `eventKey` is outside the §7.6 catalogue — so this case fixes **which**
 * refusal the caller sees, the string a worker's retry logic branches on.
 * Nothing about the data can move: both paths refuse the item and neither
 * writes a row, which the stored-row assertion below also holds to.
 *
 * **The contract is the shipped order, and the case name states it: the
 * envelope's instant gate first.** ADR-0842 §1 records why that order is a
 * decision and not an accident: ADR-0835 §4 places the forward-window guard in
 * the route (it cannot live in `emitDomainEvent`, whose clock seam *is* the
 * worker's instant and whose own specs drive fixed clocks), while the catalogue
 * gate is owned inside `emitDomainEvent` for every in-process publisher of a
 * domain event. The route therefore asks its envelope question before the
 * emitter's semantic ones; resolving the key first would need a second copy of
 * the catalogue rule in the route. A lone unknown key still answers
 * `unknown_event_key` (I1 above) — only the compound item is decided here.
 */
describe("when one event item is both ahead of the outbox window and out of the event catalogue", () => {
  it("F-B: applies the sibling and answers occurred_at_out_of_window for the compound item", async () => {
    const seeded = await world("op135-fb-precedence");
    // The sibling is a valid item: a registered key, an instant inside the
    // window (an hour in the past — the window is one-sided forward).
    const insideAt = new Date(Date.now() - 60 * 60 * 1000);
    // The compound item: 25 h ahead, and a key in no catalogue.
    const aheadAt = new Date(Date.now() + EVENT_INSTANT_WINDOW_MS + 60 * 60 * 1000);

    const response = await domainEventsHandler(
      signedPost(DOMAIN_EVENTS_PATH, {
        events: [
          {
            ...domainEvent(PIPELINE_INDEXED_EVENT, seeded.tenantKey, seeded.event),
            occurredAt: insideAt.toISOString(),
          },
          {
            ...domainEvent(UNKNOWN_EVENT_KEY, seeded.tenantKey, seeded.event),
            occurredAt: aheadAt.toISOString(),
          },
        ],
      })
    );

    // The compound item is refused in its own `rejected[]` slot — index 1, the
    // position it holds in the batch — and the batch still answers 202.
    expect(response.status).toBe(202);
    const body = await bodyOf(response, 202, "POST internal domain-events (doubly-invalid item)");
    expect(keysOf(body)).toEqual(BATCH_KEYS);
    expect(body.accepted).toBe(1);
    expect(body.deduped).toBe(0);
    expect(body.rejected).toEqual([
      { index: 1, eventKey: UNKNOWN_EVENT_KEY, reason: OUT_OF_WINDOW_REASON },
    ]);

    // Exactly the accepted item's row is stored: the refused item wrote none, so
    // the only row under this tenant carries the sibling's key.
    const stored = (await app.db
      .collection(COLLECTIONS.domainEvents)
      .find({ tenantId: seeded.tenantKey })
      .sort({ _id: 1 })
      .toArray()) as unknown as DomainEventRow[];
    expect(stored.map((row) => row.eventKey)).toEqual([PIPELINE_INDEXED_EVENT]);
  });
});
