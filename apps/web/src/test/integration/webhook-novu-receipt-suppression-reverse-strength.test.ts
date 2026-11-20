import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `next/server`'s `after` is again the seam this suite drains for the "answer
 * first, project after" half of contract §10.1 (ADR-0882). The mock is hoisted
 * so the route binds to it on import.
 */
const afterMock = vi.hoisted(() => vi.fn<(callback: () => unknown) => void>());

vi.mock("next/server", () => ({ after: afterMock }));

import { POST as receiveNovuReceipt } from "@/app/api/v1/webhooks/novu/route";
import { memoryMessageTransport } from "@/server/adapters/memory-message-transport";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { contactHashOf } from "@/server/notifications/contact-hash";
import { runNotificationFanOut, type RecipientRepository } from "@/server/notifications/fan-out";
import { invalidateNotificationTypeCache } from "@/server/notifications/notification-type-cache";
import { SEED_NOTIFICATION_TEMPLATES } from "@/server/notifications/notification-templates.values";
import { SEED_NOTIFICATION_TYPES } from "@/server/notifications/notification-types.values";
import { fixedClock } from "@/server/runtime/clock";

import { APP_ORIGIN, startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { fixtureInstant } from "../helpers/fixture-clock";
import {
  makeNovuReceiptBody,
  makeNovuWebhookHeaders,
  NOVU_RECEIPT_WEBHOOK_ID,
  TEST_NOVU_WEBHOOK_SECRET,
  type NovuReceiptStatus,
} from "../factories/novu-webhook";

/**
 * Integration / contract — the **reverse direction** of the same-key
 * suppression ladder (OP-137, contract §10.1.3 and §19.6; ADR-0894, ADR-0896).
 * `P7`, added by the round-1 review of ADR-0894's delivery, is the weaker
 * write's `expiresAt` arm.
 *
 * The pins' own file (`webhook-novu-receipt-suppression-strength.test.ts`)
 * pins the upgrade direction and the unsubscribe route's non-downgrade. The
 * arm it deliberately left unpinned — because the shipped head is harmless
 * there — is the one this suite owns: a **weaker receipt** arriving on the
 * **projection** path. The moment the receipt path stops being "leave the row
 * alone" and becomes a write, an unconditional `$set` of `reason`/`scope`
 * silently reduces an all-scope hard bounce to a marketing opt-out, and
 * transactional mail resumes for a hard-bounced contact. That is the user
 * story this suite protects: *"we never re-send to hard-bounced or DND
 * contacts"*.
 *
 *  - **P5** a signed `status: "unsubscribed"` receipt (the projection drafts
 *    `{reason: "unsubscribe", scope: "marketing"}`) arriving after a
 *    `hard_bounce`/`all` row must leave that row `{reason: "hard_bounce",
 *    scope: "all", expiresAt: null}` — and the next transactional OTP must
 *    still be suppressed;
 *  - **P6** a signed `status: "dnd_rejected"` receipt (the projection drafts
 *    `{reason: "dnd_registry", scope: "all"}`) arriving after a
 *    `marketing`-scope row must **upgrade** it to `{reason: "dnd_registry",
 *    scope: "all"}` — both `complaint` and `dnd_rejection` are all-scope kinds,
 *    so the ladder is reason-aware and not only a scope comparison of the two
 *    writers.
 *  - **P7** the same weaker `unsubscribed` receipt arriving after a
 *    **future-dated** `hard_bounce`/`all` row must leave `expiresAt` at exactly
 *    the seeded instant: a weaker write may not clear a temporary
 *    suppression's expiry and so make it permanent. The still-live row must
 *    keep suppressing the next transactional fan-out, which proves the seeded
 *    row was in force rather than already lapsed.
 *
 * ## Contract expected of the implementation
 *
 * - The receipt path's suppression write is a **ladder over the shared
 *   `{channel, contactHash}` key** (§19.6): `all` outranks `marketing`, and a
 *   weaker incoming write neither narrows the stored scope nor rewrites its
 *   reason, its `source`, its `expiresAt` re-arm or its `createdAt`.
 * - A stronger incoming write still applies: `marketing` → `all` on a
 *   `dnd_rejected` receipt must store `reason: "dnd_registry"`.
 * - The observable consequence is the point, not the document shape: while an
 *   `all`-scope row for the contact exists, the fan-out's `isSuppressed` branch
 *   records `status: "skipped"` / `skipReason: "suppressed"` and the transport
 *   sends nothing.
 *
 * ## Assumptions recorded in the handoff
 *
 * - `T0` (`fixtureInstant("00:00:00.000Z")`) is the suite's fixture instant and
 *   is also the `createdAt` each seeded row carries, so "the row was not
 *   re-dated" is an exact assertion rather than a bound.
 * - The seeded all-scope row is written as a prior projection would have
 *   written it (`source: {provider: "novu", providerEventId: <webhook id>}`),
 *   and the seeded marketing row as the one-click route writes it
 *   (`source: {provider: "first_party", providerEventId: null}`).
 * - The dispatch rows come from the **real** fan-out, so the receipt's
 *   `transactionId` is the ledger's own `providerRef.messageId` and the
 *   suppression key is the ledger's own `contactHash`.
 */

/** The recipient's address; the suppression key under test. */
const RECIPIENT_EMAIL = "reverse.recipient@example.com";

/** The transactional type an all-scope row must stop; a marketing row must not. */
const OTP_EVENT_KEY = "auth.otp.email.requested";

/** The receipt webhook's path. */
const RECEIPT_PATH = "/api/v1/webhooks/novu";

/** The environment the suite boots with. */
const RECEIPT_ENV: Record<string, string> = {
  MESSAGE_TRANSPORT: "memory",
  NOVU_WEBHOOK_SECRET: TEST_NOVU_WEBHOOK_SECRET,
};

/** The suite's fixture instant (retention-anchored, never a literal date). */
const T0 = fixtureInstant("00:00:00.000Z");

/** The clock the fan-out runs against. */
const fanOutClock = fixedClock(T0);

/** Fields of a stored dispatch row this suite reads (schema §19.5). */
interface StoredDispatch {
  readonly _id: unknown;
  readonly typeKey?: unknown;
  readonly status?: unknown;
  readonly skipReason?: unknown;
  readonly contactHash?: unknown;
  readonly providerRef?: { readonly provider?: unknown; readonly messageId?: unknown };
}

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op137-reverse-strength", env: RECEIPT_ENV });
  // The unique indexes of §18.4 and §19.6 **are** the dedupe, so the suite
  // builds the declared registry against its private database first.
  await ensureIndexes(app.db);
  await app.db.collection(COLLECTIONS.notificationTypes).insertMany([...SEED_NOTIFICATION_TYPES]);
  await app.db
    .collection(COLLECTIONS.notificationTemplates)
    .insertMany([...SEED_NOTIFICATION_TEMPLATES]);
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

beforeEach(async () => {
  afterMock.mockClear();
  invalidateNotificationTypeCache();
  await app.db.collection("user").deleteMany({});
  await Promise.all([
    app.db.collection(COLLECTIONS.userProfiles).deleteMany({}),
    app.db.collection(COLLECTIONS.notificationPreferences).deleteMany({}),
    app.db.collection(COLLECTIONS.dispatches).deleteMany({}),
    app.db.collection(COLLECTIONS.notificationSuppressions).deleteMany({}),
    app.db.collection(COLLECTIONS.providerWebhookEvents).deleteMany({}),
    app.db.collection(COLLECTIONS.domainEvents).deleteMany({}),
  ]);
});

/** A fresh hex id. */
function newId(): string {
  return new ObjectId().toHexString();
}

/** A deterministic recipient source: the subject is always a recipient. */
function recipientSource(): RecipientRepository {
  return {
    listEventRoleMembers: () => Promise.resolve([]),
    listIdentifiedAttendeeUserIds: () => Promise.resolve([]),
    getBillingContactUserId: () => Promise.resolve(null),
    listPlatformAdminUserIds: () => Promise.resolve([]),
  };
}

/** Insert the `user` + `userProfiles` + `notificationPreferences` trio. */
async function seedRecipient(input: {
  readonly userId: string;
  readonly email: string;
}): Promise<void> {
  const objectId = new ObjectId(input.userId);
  await app.db.collection("user").insertOne({
    _id: objectId,
    email: input.email,
    emailVerified: true,
    phoneNumber: null,
    phoneNumberVerified: false,
  });
  await app.db.collection(COLLECTIONS.userProfiles).insertOne({
    userId: objectId,
    platformRole: "client",
    locale: "en-IN",
    contactCapabilities: { whatsappCapable: null, whatsappCheckedAt: null },
  });
  await app.db.collection(COLLECTIONS.notificationPreferences).insertOne({
    userId: objectId,
    global: { in_app: "on", email: "on", mobile: "on" },
    byType: {},
    byEvent: {},
    quietHours: {
      enabled: false,
      start: "22:00",
      end: "07:00",
      timeZone: "Asia/Kolkata",
    },
    locale: "en-IN",
  });
}

/** Insert one pending outbox row for the subject recipient. */
async function insertEvent(input: {
  readonly eventKey: string;
  readonly subjectUserId: string;
}): Promise<void> {
  const occurredAt = new Date(T0);
  await app.db.collection(COLLECTIONS.domainEvents).insertOne({
    eventKey: input.eventKey,
    tenantId: newId(),
    actorRef: { kind: "user", id: newId() },
    subjectRef: { kind: "user", id: input.subjectUserId },
    payload: { eventId: newId() },
    occurredAt,
    expireAt: new Date(occurredAt.getTime() + 180 * 24 * 60 * 60 * 1000),
    dispatch: { notifications: "pending", analytics: "not_applicable", queue: "not_applicable" },
  });
}

/** Run the real fan-out consumer once over the suite's database. */
async function runFanOut(transport = memoryMessageTransport()): Promise<void> {
  await runNotificationFanOut({
    db: app.db,
    clock: fanOutClock,
    transport,
    recipients: recipientSource(),
    batch: 10,
    claimerId: "worker_op137_reverse_strength",
  });
}

/** Every dispatch row of one type for a recipient. */
async function dispatchesOfType(
  userId: string,
  typeKey: string
): Promise<readonly StoredDispatch[]> {
  const rows = await app.db
    .collection<StoredDispatch>(COLLECTIONS.dispatches)
    .find({ userId: new ObjectId(userId) })
    .toArray();
  return rows.filter((row) => String(row.typeKey) === typeKey);
}

/** The ids of the dispatch rows of one type that actually reached the transport. */
async function sentDispatchIds(userId: string, typeKey: string): Promise<readonly string[]> {
  const rows = await dispatchesOfType(userId, typeKey);
  return rows.filter((row) => row.status === "sent").map((row) => String(row._id));
}

/** Fan out the transactional email type and return its first dispatch row. */
async function fanOutOtp(userId: string): Promise<StoredDispatch> {
  await insertEvent({ eventKey: OTP_EVENT_KEY, subjectUserId: userId });
  await runFanOut();
  const rows = await dispatchesOfType(userId, OTP_EVENT_KEY);
  const dispatch = rows[0];
  if (dispatch === undefined) {
    throw new Error(`the fan-out wrote no dispatch for ${OTP_EVENT_KEY}`);
  }
  return dispatch;
}

/** The `providerRef.messageId` a delivery's receipt must name. */
function messageIdOf(dispatch: StoredDispatch): string {
  const messageId = dispatch.providerRef?.messageId;
  if (typeof messageId !== "string" || messageId === "") {
    throw new Error("the dispatch carries no providerRef.messageId");
  }
  return messageId;
}

/** The suppression key `{channel, contactHash}` of an address (§19.6). */
function suppressionContactHash(contact: string): string {
  return `sha256:${contactHashOf(contact)}`;
}

/** The one suppression document the suite seeded or the projection wrote. */
async function onlySuppression(): Promise<Record<string, unknown>> {
  const rows = await app.db
    .collection<Record<string, unknown>>(COLLECTIONS.notificationSuppressions)
    .find({})
    .toArray();
  if (rows.length !== 1) {
    throw new Error(`expected exactly one suppression row, found ${String(rows.length)}`);
  }
  const row = rows[0];
  if (row === undefined) {
    throw new Error("expected one suppression row, found none");
  }
  return row;
}

/** Seed the suppression row an earlier write left for this key (§19.6). */
async function seedSuppression(input: {
  readonly contactHash: string;
  readonly reason: string;
  readonly scope: string;
  readonly expiresAt: Date | null;
  readonly source: { readonly provider: string; readonly providerEventId: string | null };
}): Promise<void> {
  await app.db.collection(COLLECTIONS.notificationSuppressions).insertOne({
    channel: "email",
    contactHash: input.contactHash,
    reason: input.reason,
    scope: input.scope,
    source: input.source,
    createdAt: new Date(T0),
    expiresAt: input.expiresAt,
  });
}

/** A `POST` to the receipt webhook: a raw body, its signed headers, no session. */
function receiptRequest(input: {
  readonly rawBody: string;
  readonly headers?: Record<string, string>;
}): Request {
  return new Request(new URL(RECEIPT_PATH, APP_ORIGIN).toString(), {
    method: "POST",
    headers: { "content-type": "application/json", ...input.headers },
    body: input.rawBody,
  });
}

/** The headers a correctly-signed delivery of `rawBody` carries. */
function signedHeaders(rawBody: string): Record<string, string> {
  return makeNovuWebhookHeaders({
    secret: TEST_NOVU_WEBHOOK_SECRET,
    id: NOVU_RECEIPT_WEBHOOK_ID,
    timestamp: String(Math.floor(Date.now() / 1000)),
    rawBody,
  });
}

/** Run the work the route deferred through `after()`, in scheduling order. */
async function drainDeferredProjections(): Promise<void> {
  const callbacks = afterMock.mock.calls.map((call) => call[0]);
  afterMock.mockClear();
  for (const callback of callbacks) {
    await callback();
  }
}

/** A signed receipt request for one dispatch, plus its drained projection. */
async function deliverReceipt(input: {
  readonly dispatch: StoredDispatch;
  readonly status: NovuReceiptStatus;
  readonly bounceType?: "hard" | "soft";
}): Promise<Response> {
  const rawBody = JSON.stringify(
    makeNovuReceiptBody({
      transactionId: messageIdOf(input.dispatch),
      status: input.status,
      to: RECIPIENT_EMAIL,
      ...(input.bounceType === undefined ? {} : { bounceType: input.bounceType }),
    })
  );
  const response = await receiveNovuReceipt(
    receiptRequest({ rawBody, headers: signedHeaders(rawBody) })
  );
  await drainDeferredProjections();
  return response;
}

/** The single §18.4 inbox row the suite's one delivery wrote. */
async function onlyInboxRow(): Promise<Record<string, unknown>> {
  const rows = await app.db
    .collection<Record<string, unknown>>(COLLECTIONS.providerWebhookEvents)
    .find({})
    .toArray();
  if (rows.length !== 1) {
    throw new Error(`expected exactly one inbox row, found ${String(rows.length)}`);
  }
  const row = rows[0];
  if (row === undefined) {
    throw new Error("expected one inbox row, found none");
  }
  return row;
}

describe("suppression reverse direction — an unsubscribed receipt never downgrades (P5)", () => {
  it("P5: a signed unsubscribed receipt after a hard-bounce row leaves reason hard_bounce, scope all, and the next transactional send stays suppressed", async () => {
    // Arrange — a real transactional dispatch to attach the receipt to, and
    // exactly the all-scope row a hard-bounce receipt has already written for
    // the same `{channel, contactHash}` key.
    const userId = newId();
    await seedRecipient({ userId, email: RECIPIENT_EMAIL });
    const dispatch = await fanOutOtp(userId);
    const key = suppressionContactHash(RECIPIENT_EMAIL);
    await seedSuppression({
      contactHash: key,
      reason: "hard_bounce",
      scope: "all",
      expiresAt: null,
      source: { provider: "novu", providerEventId: NOVU_RECEIPT_WEBHOOK_ID },
    });

    // Act — the provider reports the contact unsubscribed from marketing, which
    // the projection drafts as `{reason: "unsubscribe", scope: "marketing"}`.
    const response = await deliverReceipt({ dispatch, status: "unsubscribed" });

    // Assert — the receipt was accepted and projected (never rejected)…
    expect(response.status).toBe(200);
    expect((await onlyInboxRow()).processResult).not.toBe("error");

    // …and the stronger row is untouched: the weaker marketing write may not
    // narrow the scope, rewrite the reason, re-date it or drop its provenance.
    const row = await onlySuppression();
    expect(row).toEqual({
      _id: expect.any(ObjectId),
      channel: "email",
      contactHash: key,
      reason: "hard_bounce",
      scope: "all",
      source: { provider: "novu", providerEventId: NOVU_RECEIPT_WEBHOOK_ID },
      createdAt: new Date(T0),
      expiresAt: null,
    });

    // The observable consequence: the hard-bounced contact receives no further
    // transactional email. The second fan-out must send nothing — no new
    // `sent` dispatch, an empty outbox, one recorded suppression skip.
    const transport = memoryMessageTransport();
    const sentBefore = await sentDispatchIds(userId, OTP_EVENT_KEY);
    await insertEvent({ eventKey: OTP_EVENT_KEY, subjectUserId: userId });
    await runFanOut(transport);
    expect(await sentDispatchIds(userId, OTP_EVENT_KEY)).toEqual(sentBefore);
    expect(transport.outbox).toEqual([]);
    expect(await dispatchesOfType(userId, OTP_EVENT_KEY)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "skipped", skipReason: "suppressed" }),
      ])
    );
  });
});

describe("suppression reverse direction — a dnd_rejected receipt upgrades a marketing row (P6)", () => {
  it("P6: a signed dnd_rejected receipt after a marketing row stores reason dnd_registry, scope all, and the next transactional send is suppressed", async () => {
    // Arrange — the ledger row, and the weaker marketing-scope row the
    // one-click unsubscribe route leaves behind for the same key.
    const userId = newId();
    await seedRecipient({ userId, email: RECIPIENT_EMAIL });
    const dispatch = await fanOutOtp(userId);
    const key = suppressionContactHash(RECIPIENT_EMAIL);
    await seedSuppression({
      contactHash: key,
      reason: "unsubscribe",
      scope: "marketing",
      expiresAt: null,
      source: { provider: "first_party", providerEventId: null },
    });

    // Act — the provider reports the destination is on a do-not-disturb
    // registry, an all-scope kind exactly like a complaint.
    const response = await deliverReceipt({ dispatch, status: "dnd_rejected" });

    // Assert — the receipt applied and the all-scope kind is what the row now
    // holds: the ladder is reason-aware, not only a scope comparison.
    expect(response.status).toBe(200);
    expect((await onlyInboxRow()).processResult).toBe("applied");
    const row = await onlySuppression();
    expect(row).toEqual({
      _id: expect.any(ObjectId),
      channel: "email",
      contactHash: key,
      reason: "dnd_registry",
      scope: "all",
      source: { provider: "novu", providerEventId: NOVU_RECEIPT_WEBHOOK_ID },
      createdAt: new Date(T0),
      expiresAt: null,
    });

    // The observable consequence: a transactional OTP that a marketing opt-out
    // must never block is now suppressed, because the row is all-scope.
    const transport = memoryMessageTransport();
    const sentBefore = await sentDispatchIds(userId, OTP_EVENT_KEY);
    await insertEvent({ eventKey: OTP_EVENT_KEY, subjectUserId: userId });
    await runFanOut(transport);
    expect(await sentDispatchIds(userId, OTP_EVENT_KEY)).toEqual(sentBefore);
    expect(transport.outbox).toEqual([]);
    expect(await dispatchesOfType(userId, OTP_EVENT_KEY)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "skipped", skipReason: "suppressed" }),
      ])
    );
  });
});

describe("suppression reverse direction — a weaker write never re-arms expiresAt (P7)", () => {
  it("P7: a signed unsubscribed receipt after a future-dated hard-bounce row leaves expiresAt at the seeded instant and the row still suppresses", async () => {
    // Arrange — the ledger row, and exactly the temporary all-scope row an
    // earlier hard-bounce receipt wrote for the same key: it lapses in an hour.
    const userId = newId();
    await seedRecipient({ userId, email: RECIPIENT_EMAIL });
    const dispatch = await fanOutOtp(userId);
    const key = suppressionContactHash(RECIPIENT_EMAIL);
    const future = new Date(new Date(T0).getTime() + 60 * 60 * 1000);
    await seedSuppression({
      contactHash: key,
      reason: "hard_bounce",
      scope: "all",
      expiresAt: future,
      source: { provider: "novu", providerEventId: NOVU_RECEIPT_WEBHOOK_ID },
    });

    // Act — the provider reports the contact unsubscribed from marketing, the
    // weaker write the projection drafts as `{reason: "unsubscribe",
    // scope: "marketing"}`.
    const response = await deliverReceipt({ dispatch, status: "unsubscribed" });

    // Assert — the receipt was accepted…
    expect(response.status).toBe(200);

    // …and the stronger row is untouched, expiry included: the weaker write
    // may not clear `expiresAt` and so make a temporary suppression permanent.
    const row = await onlySuppression();
    expect(row).toEqual({
      _id: expect.any(ObjectId),
      channel: "email",
      contactHash: key,
      reason: "hard_bounce",
      scope: "all",
      source: { provider: "novu", providerEventId: NOVU_RECEIPT_WEBHOOK_ID },
      createdAt: new Date(T0),
      expiresAt: future,
    });

    // The observable consequence, and the proof the seeded row was live rather
    // than already lapsed: an unexpired all-scope row still stops the next
    // transactional send — no new `sent` dispatch, an empty outbox, one
    // recorded suppression skip.
    const transport = memoryMessageTransport();
    const sentBefore = await sentDispatchIds(userId, OTP_EVENT_KEY);
    await insertEvent({ eventKey: OTP_EVENT_KEY, subjectUserId: userId });
    await runFanOut(transport);
    expect(await sentDispatchIds(userId, OTP_EVENT_KEY)).toEqual(sentBefore);
    expect(transport.outbox).toEqual([]);
    expect(await dispatchesOfType(userId, OTP_EVENT_KEY)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "skipped", skipReason: "suppressed" }),
      ])
    );
  });
});
