/**
 * Integration / contract — the internal worker's batch and heartbeat arms (OP-135).
 *
 * Two of the four M2M endpoints write pipeline facts the worker produces between
 * reports: `POST /internal/domain-events` (I1, the §10.3.2 batch and its §7.7
 * outbox) and `POST /internal/worker/heartbeat` (I4, the §10.3.2 configuration
 * channel). Both are driven as the worker drives them — imported handler, real
 * `Request`, §0.3 `Bearer` + `X-Signature` + `X-Timestamp`.
 *
 * The file is one of the four the OP-135 spec was split into (ADR-0843): the
 * harness it imports holds the preamble, the seeds and the credential builder that
 * used to open `internal-worker-endpoints.test.ts`. The case text, titles,
 * assertions and fixtures are that file's, unchanged.
 */

import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";

import {
  DOMAIN_EVENTS_PATH,
  HEARTBEAT_PATH,
  MATCHES_NEW_EVENT,
  PIPELINE_INDEXED_EVENT,
  UNKNOWN_EVENT_KEY,
  BATCH_KEYS,
  HEARTBEAT_KEYS,
  signedPost,
  documentedHeartbeatBody,
  domainEventsHandler,
  heartbeatHandler,
  app,
  seedPacing,
  world,
  submittedSelfie,
  confirmedWithWorkerResult,
  activationDeliveryKey,
  incrementalDeliveryKey,
  domainEvent,
  type DomainEventRow,
} from "../helpers/internal-worker-harness.js";
import { bodyOf, keysOf } from "../helpers/selfie-flow";

/* ─────────────── I1 + ADR-0808: the worker's domain-event batch ─────────── */

describe("when the worker flushes a batch of domain events", () => {
  it("I1: accepts the rest of the batch and rejects only the unknown event key", async () => {
    const seeded = await world("op135-de-batch");
    const eventId = seeded.event.id.toHexString();
    const response = await domainEventsHandler(
      signedPost(DOMAIN_EVENTS_PATH, {
        events: [
          domainEvent(PIPELINE_INDEXED_EVENT, seeded.tenantKey, seeded.event),
          domainEvent(PIPELINE_INDEXED_EVENT, seeded.tenantKey, seeded.event, {
            dedupeKey: `${PIPELINE_INDEXED_EVENT}:${eventId}`,
          }),
          domainEvent(UNKNOWN_EVENT_KEY, seeded.tenantKey, seeded.event),
        ],
      })
    );

    // §10.3.2: a bad key never fails the batch.
    expect(response.status).toBe(202);
    const body = await bodyOf(response, 202, "POST internal domain-events");
    expect(keysOf(body)).toEqual(BATCH_KEYS);
    expect(body.accepted).toBe(2);
    expect(body.deduped).toBe(0);
    expect(body.rejected).toEqual([
      { index: 2, eventKey: UNKNOWN_EVENT_KEY, reason: "unknown_event_key" },
    ]);

    const stored = (await app.db
      .collection(COLLECTIONS.domainEvents)
      .find({ tenantId: seeded.tenantKey })
      .sort({ _id: 1 })
      .toArray()) as unknown as DomainEventRow[];
    expect(stored).toHaveLength(2);
    expect(stored.map((row) => row.eventKey)).toEqual([
      PIPELINE_INDEXED_EVENT,
      PIPELINE_INDEXED_EVENT,
    ]);
  });

  it("counts a repeat of the same dedupeKey as deduped and keeps one row", async () => {
    const seeded = await world("op135-de-dedupe");
    const activation = activationDeliveryKey(
      seeded.event.id.toHexString(),
      new ObjectId().toHexString(),
      new ObjectId().toHexString()
    );
    const batch = {
      events: [
        domainEvent(MATCHES_NEW_EVENT, seeded.tenantKey, seeded.event, {
          dedupeKey: activation,
        }),
      ],
    };

    const first = await bodyOf(
      await domainEventsHandler(signedPost(DOMAIN_EVENTS_PATH, batch)),
      202,
      "POST internal domain-events (first)"
    );
    expect(first).toEqual({ accepted: 1, deduped: 0, rejected: [] });

    // The retried delivery is still an accepted *request*; the item is deduped.
    const second = await bodyOf(
      await domainEventsHandler(signedPost(DOMAIN_EVENTS_PATH, batch)),
      202,
      "POST internal domain-events (repeat)"
    );
    expect(second).toEqual({ accepted: 0, deduped: 1, rejected: [] });

    // Scoped to the delivery this case is about: the fixture's own sign-in has
    // already emitted `account.welcome` + `auth.signin.new_device` into the same
    // outbox, so an unscoped count can never be 1 (ADR-0830 §8.2).
    expect(
      await app.db.collection(COLLECTIONS.domainEvents).countDocuments({ dedupeKey: activation })
    ).toBe(1);
  });

  it("dedupes the activation identity a confirmation has already published (ADR-0808 §3)", async () => {
    const fixture = await confirmedWithWorkerResult(
      await submittedSelfie("op135-de-confirm-first", "op135-de-confirm-first")
    );
    const rows = (await app.db
      .collection(COLLECTIONS.domainEvents)
      .find({ eventKey: MATCHES_NEW_EVENT })
      .sort({ _id: 1 })
      .toArray()) as unknown as DomainEventRow[];
    expect(rows).toHaveLength(1);
    const confirmed = rows[0];
    if (confirmed === undefined) {
      throw new Error("expected the confirmation to publish one attendee.matches.new row");
    }

    const response = await domainEventsHandler(
      signedPost(DOMAIN_EVENTS_PATH, {
        events: [
          domainEvent(MATCHES_NEW_EVENT, fixture.world.tenantKey, fixture.world.event, {
            payload: { eventId: fixture.world.event.id.toHexString(), count: 3 },
            dedupeKey: activationDeliveryKey(
              fixture.world.event.id.toHexString(),
              fixture.profileId,
              fixture.selfieId
            ),
          }),
        ],
      })
    );

    expect(response.status).toBe(202);
    const body = await bodyOf(response, 202, "POST internal domain-events (after confirm)");
    expect(body).toEqual({ accepted: 0, deduped: 1, rejected: [] });

    // One activation result, one delivery — and the survivor is the confirm's.
    const after = (await app.db
      .collection(COLLECTIONS.domainEvents)
      .find({ eventKey: MATCHES_NEW_EVENT })
      .sort({ _id: 1 })
      .toArray()) as unknown as DomainEventRow[];
    expect(after).toHaveLength(1);
    expect(after[0]?._id.toString()).toBe(confirmed._id.toString());
  });

  it("records a later arrival for an already-announced selfie as a second delivery", async () => {
    const fixture = await confirmedWithWorkerResult(
      await submittedSelfie("op135-de-arrival", "op135-de-arrival")
    );
    const eventId = fixture.world.event.id.toHexString();
    const activation = activationDeliveryKey(eventId, fixture.profileId, fixture.selfieId);

    const response = await domainEventsHandler(
      signedPost(DOMAIN_EVENTS_PATH, {
        events: [
          domainEvent(MATCHES_NEW_EVENT, fixture.world.tenantKey, fixture.world.event, {
            payload: { eventId, count: 2 },
            // The incremental run's own identity, never `selfieId` alone.
            dedupeKey: incrementalDeliveryKey(activation, "run-2"),
          }),
        ],
      })
    );

    expect(response.status).toBe(202);
    expect(await bodyOf(response, 202, "POST internal domain-events (arrival)")).toEqual({
      accepted: 1,
      deduped: 0,
      rejected: [],
    });

    const rows = (await app.db
      .collection(COLLECTIONS.domainEvents)
      .find({ eventKey: MATCHES_NEW_EVENT })
      .sort({ _id: 1 })
      .toArray()) as unknown as DomainEventRow[];
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row._id.toString())).size).toBe(2);
    // The two deliveries are distinguished by their key, not by their subject.
    expect(rows.map((row) => row.dedupeKey)).toEqual([activation, `${activation}:run-2`]);
  });
});

/* ─────────────── I4: the heartbeat's configuration channel ──────────────── */

describe("when the worker sends a heartbeat", () => {
  it("I4: answers pauseRequested true and the configured pacing", async () => {
    await seedPacing({
      activeSpaceKey: "arcface_r100_512_v2",
      leaseMinutes: 7,
      maxAttempts: 3,
      pauseRequested: true,
    });

    const response = await heartbeatHandler(signedPost(HEARTBEAT_PATH, documentedHeartbeatBody()));

    expect(response.status).toBe(200);
    const body = await bodyOf(response, 200, "POST internal worker/heartbeat");
    expect(keysOf(body)).toEqual(HEARTBEAT_KEYS);
    expect(body).toEqual({
      acknowledged: true,
      activeSpaceKey: "arcface_r100_512_v2",
      leaseMinutes: 7,
      maxAttempts: 3,
      pauseRequested: true,
    });
  });

  it("answers pauseRequested false, with the documented defaults, when nothing is set", async () => {
    await seedPacing();

    const response = await heartbeatHandler(signedPost(HEARTBEAT_PATH, documentedHeartbeatBody()));

    expect(response.status).toBe(200);
    const body = await bodyOf(response, 200, "POST internal worker/heartbeat");
    expect(body).toEqual({
      acknowledged: true,
      activeSpaceKey: "arcface_r100_512",
      leaseMinutes: 10,
      maxAttempts: 5,
      pauseRequested: false,
    });
  });
});
