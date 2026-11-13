import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as uploadsParamsRouteModule from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads/params/route";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";

import { startTestApp, type SignedInUser, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import {
  bodyOf,
  confirmSelfie,
  errorBody,
  finishSelfieWorker,
  grantConsent,
  handlers,
  issueChallenge,
  keysOf,
  makeSelfieBytes,
  nextIp,
  requestFor,
  requireHandler,
  seedTenant,
  submitBody,
  submitSelfie,
  uploadSelfie,
  type SeededEvent,
} from "../helpers/selfie-flow";

/**
 * Integration / contract — a closed upload window does **not** gate the
 * attendee selfie flow (OP-132 F4-R2; contract §5.2, §5.3, §6.1, §6.3;
 * [ADR-0811](../../../../../../docs/adr/ADR-0811-op132-attendee-selfie-upload-window.md)).
 *
 * **Why this exists.** `events.uploadWindowEndsAt` is the **organizer's**
 * content-admission deadline (§5.2/§5.3): it refuses the organizer's
 * next gallery upload with `409 upload_window_closed`. A selfie is a matching
 * probe, never gallery content, and the attendee-facing window is
 * `retentionExpiresAt` alone (§6.1 `gallery.open` / `gallery.expiresAt`,
 * `resolvePublicEventOutcome`). Nothing refuses the attendee biometric endpoints
 * at the upload window, and nothing may start: a future "fix" that added the
 * gate to the submit route would otherwise pass every existing suite.
 *
 * These are **pins, not defects**. Every case passes on the trunk; they exist so
 * that a regression in either direction is loud. W1 is load-bearing: it proves
 * the seeded event's window really is closed, so W2–W4 cannot pass vacuously.
 *
 * ## Contract pinned here
 *
 * An event whose `uploadWindowEndsAt` is one hour in the past answers, for the
 * **same** event:
 *
 * - organizer `POST /api/v1/tenants/{tenantId}/events/{eventId}/uploads/params`
 *   → `409 upload_window_closed` with `{ uploadWindowEndsAt, canExtend }` and no
 *   `upload_sessions` row (W1, the control).
 * - attendee `POST /api/v1/p/events/{slug}/liveness/challenges` → `201` with a
 *   `nonce` (W2) — never `409`, never `403`.
 * - attendee `POST /api/v1/p/events/{slug}/selfies` → `202` with the seven §6.3
 *   keys, `status: "processing"`, one `selfies` row and one attempt charged
 *   (W3).
 * - attendee `POST /api/v1/p/events/{slug}/selfies:reuse` → `202` with the same
 *   seven keys, one new `selfies` row for the addressed event and no
 *   embedding/vector anywhere in the body (W4).
 *
 * ## Assumptions (recorded in ADR-0811)
 *
 * - **The window is closed for the whole fixture, not only for W1.** Each case
 *   seeds its own tenant and closes every seeded event's window, so no case can
 *   lean on a sibling's arrange step.
 * - **`canExtend` belongs to the organizer's refusal.** The owner is the caller
 *   in W1, so the details carry `canExtend: true`; an attendee has no such
 *   affordance and never sees this code (§6.3 has no attendee-side row for it).
 * - **The retention boundary is out of scope.** `retentionExpiresAt` is not
 *   gated today either, and that question belongs to its own decision card;
 *   these cases keep the retention deadline in the future so only the upload
 *   window varies.
 */

let app: TestApp;

/* ───────────────────────────── contract constants ────────────────────────── */

/** The seven keys §6.3's submit and reuse `202`s carry, sorted. */
const SELFIE_202_KEYS = [
  "attemptsRemaining",
  "attemptsUsed",
  "pollIntervalMs",
  "pollUrl",
  "profileId",
  "selfieId",
  "status",
];

/** Any key or value that would leak the biometric vector or a raw score. */
const VECTOR_LEAK = /embedding|vector|similarity/i;

/** How far in the past the seeded upload window closed (one hour). */
const CLOSED_MS_AGO = 3_600_000;

/** The declared single-PUT claim W1 sends (a valid §5.3 body, well under the cap). */
const CLAIM_BYTES = 8_192;

/** The organizer single-PUT presign, resolved once with a naming failure if absent. */
const uploadParams = requireHandler(
  uploadsParamsRouteModule,
  "POST",
  "/api/v1/tenants/:tenantId/events/:eventId/uploads/params"
);

/* ───────────────────────────────── harness ───────────────────────────────── */

beforeAll(async () => {
  app = await startTestApp({ prefix: "op132-window" });
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
    COLLECTIONS.uploadSessions,
    "consents",
    "selfies",
  ]) {
    await app.db.collection(name).deleteMany({});
  }
});

/* ──────────────────────────────── fixtures ───────────────────────────────── */

/** A seeded tenant whose every event has a closed upload window. */
interface ClosedWindowTenant {
  readonly tenantKey: string;
  readonly owner: SignedInUser;
  readonly events: readonly SeededEvent[];
  /** The instant stored as `uploadWindowEndsAt` — one hour before the seed. */
  readonly closedAt: Date;
}

/**
 * Seed a tenant, then move every seeded event's upload window into the past.
 *
 * @param prefix - The suite-local identity/slug prefix.
 * @param eventCount - How many events to publish (reuse needs a target and a source).
 * @returns The tenant, its owner, its events and the stored close instant.
 */
async function closedWindowTenant(prefix: string, eventCount = 1): Promise<ClosedWindowTenant> {
  const seeded = await seedTenant(app, prefix, eventCount);
  const closedAt = new Date(Date.now() - CLOSED_MS_AGO);
  const now = new Date();
  await app.db
    .collection(COLLECTIONS.events)
    .updateMany(
      { _id: { $in: seeded.events.map((event) => event.id) } },
      { $set: { uploadWindowEndsAt: closedAt } }
    );
  // The create-event route records the creator as the event's organizer (the
  // role `canExtend` is decided from); `seedTenant` only grants the tenant
  // membership, so the row is written here for the fixture to be faithful.
  for (const event of seeded.events) {
    await app.db.collection(COLLECTIONS.eventOrganizers).insertOne({
      tenantId: seeded.tenantKey,
      eventId: event.id,
      userId: seeded.owner.userId.toHexString(),
      role: "organizer",
      status: "active",
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });
  }
  return { ...seeded, closedAt };
}

/** The seeded event a case addresses, failing loudly when the seed is short. */
function onlyEvent(seeded: ClosedWindowTenant): SeededEvent {
  const [event] = seeded.events;
  if (event === undefined) {
    throw new Error("expected one seeded event");
  }
  return event;
}

/* ──────────────────────────────── readers ────────────────────────────────── */

/** How many `selfies` rows the target event holds. */
async function selfieCountFor(eventId: ObjectId): Promise<number> {
  return app.db.collection("selfies").countDocuments({ eventId });
}

/** The stored `attendee_event_profiles` row, by id. */
async function profileById(profileId: string): Promise<Record<string, unknown>> {
  const row = await app.db
    .collection(COLLECTIONS.attendeeEventProfiles)
    .findOne({ _id: new ObjectId(profileId) });
  if (row === null) {
    throw new Error(`expected a stored attendee profile ${profileId}`);
  }
  return row;
}

/** The stored `selfies` row, by id. */
async function storedSelfie(selfieId: string): Promise<Record<string, unknown>> {
  const row = await app.db.collection("selfies").findOne({ _id: new ObjectId(selfieId) });
  if (row === null) {
    throw new Error(`expected a stored selfie ${selfieId}`);
  }
  return row;
}

/** Submit, finish the worker and confirm one selfie for the seeded owner. */
async function readySelfie(
  slug: string,
  options: { readonly cookie: string; readonly ip: string; readonly tag: string }
): Promise<{ selfieId: string; profileId: string }> {
  const challenge = await issueChallenge(slug, options);
  const bytes = makeSelfieBytes(options.tag);
  const upload = await uploadSelfie(slug, {
    cookie: options.cookie,
    ip: options.ip,
    bytes: bytes.bytes,
    hash: bytes.hash,
  });
  const submitted = await submitSelfie(slug, {
    cookie: options.cookie,
    ip: options.ip,
    body: submitBody(upload, challenge),
  });
  const body = await bodyOf(submitted, 202, `POST selfies on ${slug}`);
  const selfieId = body.selfieId;
  const profileId = body.profileId;
  if (typeof selfieId !== "string" || typeof profileId !== "string") {
    throw new Error(
      `expected the 202 body to carry selfieId and profileId: ${JSON.stringify(body)}`
    );
  }

  const profile = await profileById(profileId);
  const stored = await storedSelfie(selfieId);
  await finishSelfieWorker(app, {
    selfieId,
    profileId,
    eventId: String(stored.eventId),
    tenantKey: String(stored.tenantId),
    subject: profile.subject as Record<string, unknown>,
    matches: 2,
  });
  const confirmed = await confirmSelfie(slug, selfieId, { cookie: options.cookie, ip: options.ip });
  if (confirmed.status !== 200) {
    throw new Error(`expected 200 from the confirm route, received ${String(confirmed.status)}`);
  }
  return { selfieId, profileId };
}

/* ─────────── W1: the control — the seeded window really is closed ────────── */

describe("when the upload window closed an hour ago", () => {
  it("W1: the organizer's next upload is refused 409 upload_window_closed (§5.2/§5.3)", async () => {
    // Arrange — the same event whose attendee routes W2–W4 drive.
    const seeded = await closedWindowTenant("op132-w1");
    const event = onlyEvent(seeded);
    const ip = nextIp();
    const claim = makeSelfieBytes("w1-claim");

    // Act
    const response = await uploadParams(
      requestFor(
        `/api/v1/tenants/${seeded.tenantKey}/events/${event.id.toHexString()}/uploads/params`,
        "POST",
        {
          cookie: seeded.owner.cookie,
          ip,
          body: {
            batchId: event.id.toHexString(),
            hash: claim.hash,
            size: CLAIM_BYTES,
            fileName: "DSC_0421.JPG",
            mimeType: "image/jpeg",
          },
        }
      )
    );

    // Assert
    expect(response.status).toBe(409);
    const error = await errorBody(response);
    expect(error.code).toBe("upload_window_closed");
    expect(error.details).toEqual({
      uploadWindowEndsAt: seeded.closedAt.toISOString(),
      canExtend: true,
    });
    expect(await app.db.collection(COLLECTIONS.uploadSessions).countDocuments({})).toBe(0);
  });

  /* ───────────── W2: the window does not refuse a liveness challenge ───────── */

  it("W2: a closed upload window does not refuse a liveness challenge (§6.3, ADR-0811)", async () => {
    // Arrange
    const seeded = await closedWindowTenant("op132-w2");
    const event = onlyEvent(seeded);
    const ip = nextIp();
    await grantConsent(event.slug, { cookie: seeded.owner.cookie, ip });

    // Act
    const response = await handlers.challenge(
      requestFor(`/api/v1/p/events/${event.slug}/liveness/challenges`, "POST", {
        cookie: seeded.owner.cookie,
        ip,
        body: {},
        withoutIdempotencyKey: true,
      })
    );

    // Assert — 201, not 409 and not 403: the challenge is issued at a closed window.
    expect(response.status).toBe(201);
    const body = await bodyOf(response, 201, `POST liveness challenge on ${event.slug}`);
    expect(typeof body.nonce).toBe("string");
    expect(String(body.nonce)).not.toBe("");
    expect(typeof body.challengeId).toBe("string");
  });

  /* ──────────────── W3: the window does not refuse a submit ────────────────── */

  it("W3: a closed upload window does not refuse a selfie submit (§6.3, ADR-0811)", async () => {
    // Arrange
    const seeded = await closedWindowTenant("op132-w3");
    const event = onlyEvent(seeded);
    const ip = nextIp();
    await grantConsent(event.slug, { cookie: seeded.owner.cookie, ip });
    const challenge = await issueChallenge(event.slug, { cookie: seeded.owner.cookie, ip });
    const bytes = makeSelfieBytes("w3");
    const upload = await uploadSelfie(event.slug, {
      cookie: seeded.owner.cookie,
      ip,
      bytes: bytes.bytes,
      hash: bytes.hash,
    });

    // Act
    const response = await submitSelfie(event.slug, {
      cookie: seeded.owner.cookie,
      ip,
      body: submitBody(upload, challenge),
    });

    // Assert
    expect(response.status).toBe(202);
    const body = await bodyOf(response, 202, `POST selfies on ${event.slug}`);
    expect(keysOf(body)).toEqual(SELFIE_202_KEYS);
    expect(body.status).toBe("processing");
    expect(body.attemptsUsed).toBe(1);
    expect(body.attemptsRemaining).toBe(2);
    expect(await selfieCountFor(event.id)).toBe(1);
  });

  /* ───────────────── W4: the window does not refuse a reuse ────────────────── */

  it("W4: a closed upload window does not refuse a selfie reuse (§6.3, ADR-0811)", async () => {
    // Arrange — one ready selfie on the source event, a second event as the target.
    const seeded = await closedWindowTenant("op132-w4", 2);
    const [source, target] = seeded.events;
    if (source === undefined || target === undefined) {
      throw new Error("expected two seeded events");
    }
    const ip = nextIp();
    await grantConsent(source.slug, { cookie: seeded.owner.cookie, ip });
    const mine = await readySelfie(source.slug, { cookie: seeded.owner.cookie, ip, tag: "w4" });
    await grantConsent(target.slug, { cookie: seeded.owner.cookie, ip });

    // Act
    const response = await handlers.reuseSelfie(
      requestFor(`/api/v1/p/events/${target.slug}/selfies:reuse`, "POST", {
        cookie: seeded.owner.cookie,
        ip,
        body: { selfieId: mine.selfieId },
      })
    );

    // Assert
    expect(response.status).toBe(202);
    const body = await bodyOf(response, 202, `POST selfies:reuse on ${target.slug}`);
    expect(keysOf(body)).toEqual(SELFIE_202_KEYS);
    expect(body.status).toBe("processing");
    expect(body.selfieId).not.toBe(mine.selfieId);
    expect(await selfieCountFor(target.id)).toBe(1);
    expect(JSON.stringify(body)).not.toMatch(VECTOR_LEAK);
  });
});
