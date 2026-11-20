import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `next/server`'s `after` is the seam this suite observes for the "answer first,
 * project after" half of contract §10.1 step 6 (ADR-0440's pattern, reused here
 * by ADR-0875 §1). The mock is hoisted above the module graph so the route binds
 * to it on import; the default is inert, which is what lets a spec assert the
 * *scheduling* call and then decide whether to run the deferred work.
 */
const afterMock = vi.hoisted(() => vi.fn<(callback: () => unknown) => void>());

vi.mock("next/server", () => ({ after: afterMock }));

import { POST as receiveNovuReceipt } from "@/app/api/v1/webhooks/novu/route";
import { memoryMessageTransport } from "@/server/adapters/memory-message-transport";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { createLogger, getLogger, memoryTransport, setLogger } from "@/server/logging";
import { runNotificationFanOut, type RecipientRepository } from "@/server/notifications/fan-out";
import { invalidateNotificationTypeCache } from "@/server/notifications/notification-type-cache";
import { SEED_NOTIFICATION_TEMPLATES } from "@/server/notifications/notification-templates.values";
import { SEED_NOTIFICATION_TYPES } from "@/server/notifications/notification-types.values";
import { contactHashOf } from "@/server/notifications/contact-hash";
import { fixedClock } from "@/server/runtime/clock";

import { body } from "../helpers/auth-requests";
import { APP_ORIGIN, startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { fixtureInstant } from "../helpers/fixture-clock";
import {
  makeNovuReceiptBody,
  makeNovuWebhookHeaders,
  NOVU_RECEIPT_OCCURRED_AT,
  NOVU_RECEIPT_WEBHOOK_ID,
  signNovuWebhook,
  TEST_NOVU_WEBHOOK_SECRET,
  TEST_NOVU_WEBHOOK_SECRET_PREVIOUS,
  withExtraSignature,
} from "../factories/novu-webhook";

/**
 * Integration / contract — the Novu delivery-receipt webhook and its projection
 * into `notificationDispatches` and `notificationSuppressions` (OP-137,
 * contract §10.1.3; design §19.5/§19.6; ADR-0875).
 *
 * The user story: *as an operator I want delivery receipts projected into
 * dispatches and suppressions so that we never re-send to a hard-bounced or
 * DND contact and can prove delivery.*
 *
 * ## Contract expected of the implementation
 *
 * - `POST /api/v1/webhooks/novu` (`@/app/api/v1/webhooks/novu/route`, exporting
 *   `POST`) reuses the OP-108 inbox shape: the **raw** body is read
 *   (`request.text()`), the signature is verified before anything is written, the
 *   provider's own id is the `providerWebhookEvents` identity the unique index
 *   dedupes on, the route answers `200 {"status":"received"}` **before** any
 *   projection work, and the projection is registered with `after()`.
 * - The signature is Svix's, which is what Novu uses today: headers
 *   `webhook-id`, `webhook-timestamp` and `webhook-signature: v1,<base64>`, over
 *   `HMAC-SHA256(base64decode(NOVU_WEBHOOK_SECRET minus "whsec_"),
 *   "<webhook-id>.<webhook-timestamp>.<rawBody>")`. A `webhook-signature`
 *   header carrying several space-separated `v1,` entries verifies when **any**
 *   entry matches (key rotation). A missing, malformed, stale (±300 s) or
 *   non-matching signature is `401` and writes nothing.
 * - The receipt payload this lane parses is the normalized envelope
 *   `{ eventId, transactionId, status, channel, to, bounceType?, occurredAt }`
 *   (`status` ∈ `delivered | bounced | complained | unsubscribed |
 *   dnd_rejected`; `bounceType` present iff `bounced`). Shapes are Zod-validated
 *   in `@/server/adapters/novu/schemas`; the vendor mapping table is
 *   confined there (ADR-0875 §3).
 * - The projection is `projectDeliveryReceipt(inboxId, { db?, clock? })` from
 *   `@/server/notifications/receipt-projection` (the same seam the sweep can
 *   re-project), and the dispatch lookup is by `providerRef.messageId` — the
 *   fan-out's `providerRef.provider` is the lane-neutral `"transport"` tag for
 *   both adapters, so a vendor-shaped filter would never match (§10.1.3).
 * - The fan-out (`runNotificationFanOut`) resolves a candidate's suppressions
 *   from `notificationSuppressions` — keyed `{channel, contactHash}` with
 *   `contactHash = "sha256:" + contactHashOf(contact)` — instead of passing the
 *   resolver an empty list, so a stored suppression can actually stop a send.
 *
 * ## Assumptions recorded in the handoff (ADR-0875)
 *
 * - `MESSAGE_TRANSPORT=memory` is the booted selection; the dispatch's
 *   `providerRef.provider` stays the lane-neutral `"transport"` tag the fan-out
 *   already writes, so the receipt names only `providerRef.messageId`.
 * - The dispatch rows are produced by the **real** fan-out, never seeded by
 *   hand: I1's `deliveredAt` and I2's suppression key are only meaningful if the
 *   ledger's `contactHash` came from the same function the projection uses.
 * - The inbox row's `env` label and its `expireAt` retention are not pinned —
 *   §10.1.3 says nothing about either for this provider.
 */

/** The recipient's address; the suppression key under test. */
const RECIPIENT_EMAIL = "receipt.recipient@example.com";

/** The transactional type whose email arm a marketing suppression must not block. */
const OTP_EVENT_KEY = "auth.otp.email.requested";

/** A non-transactional, email-carrying type: the "marketing" half of §10.1.3. */
const MARKETING_EVENT_KEY = "account.verification.incomplete";

/** The path the receipt webhook is served on. */
const RECEIPT_PATH = "/api/v1/webhooks/novu";

/** The environment the suite boots with: the Svix secret only this lane reads. */
const RECEIPT_ENV: Record<string, string> = {
  MESSAGE_TRANSPORT: "memory",
  NOVU_WEBHOOK_SECRET: TEST_NOVU_WEBHOOK_SECRET,
};

/** A fixed fan-out instant (retention-anchored, never a literal date). */
const T0 = fixtureInstant("00:00:00.000Z");

/** The clock the fan-out runs against. */
const fanOutClock = fixedClock(T0);

/** Fields of a stored dispatch row this suite reads (schema §19.5). */
interface StoredDispatch {
  readonly _id: unknown;
  readonly typeKey?: unknown;
  readonly channel?: unknown;
  readonly status?: unknown;
  readonly skipReason?: unknown;
  readonly attempts?: unknown;
  readonly contactHash?: unknown;
  readonly deliveredAt?: unknown;
  readonly providerRef?: { readonly provider?: unknown; readonly messageId?: unknown };
}

/** Fields of a stored suppression row this suite reads (design §19.6). */
interface StoredSuppression {
  readonly channel?: unknown;
  readonly contactHash?: unknown;
  readonly reason?: unknown;
  readonly scope?: unknown;
}

/** Fields of a `providerWebhookEvents` row this suite reads (schema §18.4). */
interface StoredInboxRow {
  readonly provider?: unknown;
  readonly eventType?: unknown;
  readonly providerEventId?: unknown;
  readonly signatureValid?: unknown;
  readonly receivedAt?: unknown;
  readonly processedAt?: unknown;
  readonly processResult?: unknown;
  readonly processError?: unknown;
  readonly rawPayload?: unknown;
}

let app: TestApp;

/** The process logger in place before a log-hygiene spec replaces it. */
let ambientLogger: ReturnType<typeof getLogger>;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op137-receipts", env: RECEIPT_ENV });
  // The unique indexes of §18.4 and §19.6 **are** the dedupe, so the suite
  // builds the declared registry against its private database first: without it
  // a replay inserts twice and the duplicate pins are vacuous.
  await ensureIndexes(app.db);
  await app.db.collection(COLLECTIONS.notificationTypes).insertMany([...SEED_NOTIFICATION_TYPES]);
  await app.db
    .collection(COLLECTIONS.notificationTemplates)
    .insertMany([...SEED_NOTIFICATION_TEMPLATES]);
  ambientLogger = getLogger();
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

afterEach(() => {
  setLogger(ambientLogger);
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
  readonly payload?: Record<string, unknown>;
}): Promise<void> {
  const occurredAt = new Date(T0);
  await app.db.collection(COLLECTIONS.domainEvents).insertOne({
    eventKey: input.eventKey,
    tenantId: newId(),
    actorRef: { kind: "user", id: newId() },
    subjectRef: { kind: "user", id: input.subjectUserId },
    payload: input.payload ?? { eventId: newId() },
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
    claimerId: "worker_op137",
  });
}

/** Every dispatch row for one recipient, oldest first. */
async function dispatchesFor(userId: string): Promise<readonly StoredDispatch[]> {
  return app.db
    .collection<StoredDispatch>(COLLECTIONS.dispatches)
    .find({ userId: new ObjectId(userId) })
    .toArray();
}

/** The one dispatch row of a type for a recipient. */
async function dispatchOf(userId: string, typeKey: string): Promise<StoredDispatch | undefined> {
  const rows = await dispatchesFor(userId);
  return rows.find((row) => String(row.typeKey) === typeKey);
}

/** Every suppression row. */
async function suppressions(): Promise<readonly StoredSuppression[]> {
  return app.db
    .collection<StoredSuppression>(COLLECTIONS.notificationSuppressions)
    .find({})
    .toArray();
}

/** Every inbox row. */
async function inboxRows(): Promise<readonly StoredInboxRow[]> {
  return app.db.collection<StoredInboxRow>(COLLECTIONS.providerWebhookEvents).find({}).toArray();
}

/** The `providerWebhookEvents` identity a replay collides on. */
async function inboxRowFor(eventId: string): Promise<StoredInboxRow | undefined> {
  const rows = await inboxRows();
  return rows.find((row) => row.providerEventId === eventId);
}

/** The suppression key `{channel, contactHash}` of an address (§19.6). */
function suppressionContactHash(contact: string): string {
  const digest: string = contactHashOf(contact);
  return `sha256:${digest}`;
}

/** Seconds since the epoch, which is the `webhook-timestamp` unit Svix uses. */
function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
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
function signedHeaders(
  rawBody: string,
  overrides: { readonly id?: string; readonly timestamp?: string } = {}
): Record<string, string> {
  return makeNovuWebhookHeaders({
    secret: TEST_NOVU_WEBHOOK_SECRET,
    id: overrides.id ?? NOVU_RECEIPT_WEBHOOK_ID,
    timestamp: overrides.timestamp ?? nowSeconds(),
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

/** Fan out the transactional email type and return the recipient's dispatch. */
async function fanOutOtp(userId: string): Promise<StoredDispatch> {
  await insertEvent({ eventKey: OTP_EVENT_KEY, subjectUserId: userId });
  await runFanOut();
  const dispatch = await dispatchOf(userId, OTP_EVENT_KEY);
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

describe("delivery receipts — the projection (I1)", () => {
  it("I1: a signed delivered receipt marks the matched dispatch delivered and proves it", async () => {
    // Arrange — a real ledger row, so the lookup key and the contact hash are the
    // fan-out's own and not a fixture's guess.
    const userId = newId();
    await seedRecipient({ userId, email: RECIPIENT_EMAIL });
    const dispatch = await fanOutOtp(userId);
    const messageId = messageIdOf(dispatch);
    const rawBody = JSON.stringify(
      makeNovuReceiptBody({
        transactionId: messageId,
        status: "delivered",
        // The provider echoes the address it was handed, in its own casing.
        to: RECIPIENT_EMAIL.toUpperCase(),
      })
    );

    // Act — the provider's POST.
    const response = await receiveNovuReceipt(
      receiptRequest({ rawBody, headers: signedHeaders(rawBody) })
    );

    // Assert — §10.1 steps 4–5: acknowledged first, nothing projected yet.
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ status: "received" });
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(await dispatchOf(userId, OTP_EVENT_KEY)).toMatchObject({ status: "sent" });

    // Act — the post-response projection.
    await drainDeferredProjections();

    // Assert — §10.1.3 row 1: `delivered` + `deliveredAt`.
    expect(await dispatchOf(userId, OTP_EVENT_KEY)).toMatchObject({
      status: "delivered",
      deliveredAt: new Date(NOVU_RECEIPT_OCCURRED_AT),
    });
    expect(await inboxRowFor(NOVU_RECEIPT_WEBHOOK_ID)).toMatchObject({
      provider: "novu",
      providerEventId: NOVU_RECEIPT_WEBHOOK_ID,
      signatureValid: true,
      processResult: "applied",
      processError: null,
    });
    expect(await suppressions()).toEqual([]);
  });
});

describe("delivery receipts — suppressions (I2, I3)", () => {
  it("I2: a hard bounce inserts an all-scope suppression keyed by the fan-out's contact hash", async () => {
    // Arrange
    const userId = newId();
    await seedRecipient({ userId, email: RECIPIENT_EMAIL });
    const dispatch = await fanOutOtp(userId);
    const contactHash = dispatch.contactHash;
    const rawBody = JSON.stringify(
      makeNovuReceiptBody({
        transactionId: messageIdOf(dispatch),
        status: "bounced",
        bounceType: "hard",
        to: RECIPIENT_EMAIL,
      })
    );

    // Act
    const response = await receiveNovuReceipt(
      receiptRequest({ rawBody, headers: signedHeaders(rawBody) })
    );
    await drainDeferredProjections();

    // Assert — §10.1.3 row 2: `status: "bounced"` + one `hard_bounce` row.
    expect(response.status).toBe(200);
    expect(await dispatchOf(userId, OTP_EVENT_KEY)).toMatchObject({ status: "bounced" });
    expect(await suppressions()).toEqual([
      expect.objectContaining({
        channel: "email",
        contactHash: `sha256:${String(contactHash)}`,
        reason: "hard_bounce",
        scope: "all",
      }),
    ]);
  });

  it("I2: a later fan-out to the hard-bounced contact is skipped with reason suppressed", async () => {
    // Arrange — the bounce lands first, so the next send must be refused before
    // the transport is ever asked.
    const userId = newId();
    await seedRecipient({ userId, email: RECIPIENT_EMAIL });
    const bounced = await fanOutOtp(userId);
    const rawBody = JSON.stringify(
      makeNovuReceiptBody({
        transactionId: messageIdOf(bounced),
        status: "bounced",
        bounceType: "hard",
        to: RECIPIENT_EMAIL,
      })
    );
    await receiveNovuReceipt(receiptRequest({ rawBody, headers: signedHeaders(rawBody) }));
    await drainDeferredProjections();

    // Act — a fresh marketing send to the same address.
    const transport = memoryMessageTransport();
    await insertEvent({ eventKey: MARKETING_EVENT_KEY, subjectUserId: userId });
    await runFanOut(transport);

    // Assert — §19.5: the skip is recorded with the answer to "why didn't they get it?"
    expect(await dispatchOf(userId, MARKETING_EVENT_KEY)).toMatchObject({
      status: "skipped",
      skipReason: "suppressed",
    });
    expect(transport.outbox).toEqual([]);
  });

  it("I3: a soft bounce fails the dispatch and increments attempts without suppressing", async () => {
    // Arrange
    const userId = newId();
    await seedRecipient({ userId, email: RECIPIENT_EMAIL });
    const dispatch = await fanOutOtp(userId);
    const attemptsBefore = dispatch.attempts;
    const rawBody = JSON.stringify(
      makeNovuReceiptBody({
        transactionId: messageIdOf(dispatch),
        status: "bounced",
        bounceType: "soft",
        to: RECIPIENT_EMAIL,
      })
    );

    // Act
    const response = await receiveNovuReceipt(
      receiptRequest({ rawBody, headers: signedHeaders(rawBody) })
    );
    await drainDeferredProjections();

    // Assert — §10.1.3 row 3: "attempts++, retry per policy. **No suppression.**"
    expect(response.status).toBe(200);
    expect(await dispatchOf(userId, OTP_EVENT_KEY)).toMatchObject({
      status: "failed",
      attempts: Number(attemptsBefore) + 1,
    });
    expect(await suppressions()).toEqual([]);
  });
});

describe("delivery receipts — the unsubscribe scope (I4)", () => {
  it("I4: a marketing-scope unsubscribe suppression blocks a marketing email and never a transactional OTP", async () => {
    // Arrange — the row is written exactly as the one-click unsubscribe route
    // writes it (contract §7.5): `reason: "unsubscribe"`, `scope: "marketing"`.
    const userId = newId();
    await seedRecipient({ userId, email: RECIPIENT_EMAIL });
    await app.db.collection(COLLECTIONS.notificationSuppressions).insertOne({
      channel: "email",
      contactHash: suppressionContactHash(RECIPIENT_EMAIL),
      reason: "unsubscribe",
      scope: "marketing",
      source: { provider: "first_party", providerEventId: null },
      createdAt: new Date(T0),
      expiresAt: null,
    });

    // Act — one marketing send and one transactional send to the same address.
    const marketingTransport = memoryMessageTransport();
    await insertEvent({ eventKey: MARKETING_EVENT_KEY, subjectUserId: userId });
    await runFanOut(marketingTransport);

    const transactionalTransport = memoryMessageTransport();
    await insertEvent({ eventKey: OTP_EVENT_KEY, subjectUserId: userId });
    await runFanOut(transactionalTransport);

    // Assert — §10.1.3: "scope matters: an unsubscribe must never block an OTP".
    expect(await dispatchOf(userId, MARKETING_EVENT_KEY)).toMatchObject({
      status: "skipped",
      skipReason: "suppressed",
    });
    expect(marketingTransport.outbox).toEqual([]);
    expect(await dispatchOf(userId, OTP_EVENT_KEY)).toMatchObject({ status: "sent" });
    expect(transactionalTransport.outbox).toHaveLength(1);
    expect(transactionalTransport.outbox[0]?.to.email).toBe(RECIPIENT_EMAIL);
  });
});

describe("delivery receipts — the inbox (I5, I6, I7, I8)", () => {
  it("I5: a replayed receipt is duplicate_ignored and projects nothing a second time", async () => {
    // Arrange
    const userId = newId();
    await seedRecipient({ userId, email: RECIPIENT_EMAIL });
    const dispatch = await fanOutOtp(userId);
    const rawBody = JSON.stringify(
      makeNovuReceiptBody({
        transactionId: messageIdOf(dispatch),
        status: "delivered",
        to: RECIPIENT_EMAIL,
      })
    );
    const headers = signedHeaders(rawBody);

    // Act — the provider retries the same delivery, byte for byte.
    const first = await receiveNovuReceipt(receiptRequest({ rawBody, headers }));
    const second = await receiveNovuReceipt(receiptRequest({ rawBody, headers }));

    // Assert — §10.1 step 4: the unique index is the dedupe.
    expect(await body(first)).toEqual({ status: "received" });
    expect(second.status).toBe(200);
    expect(await body(second)).toEqual({ status: "duplicate_ignored" });
    expect(await inboxRows()).toHaveLength(1);
    expect(afterMock).toHaveBeenCalledTimes(1);
  });

  it("I5: a second event id for the same message is accepted as its own delivery", async () => {
    // Arrange — dedupe is on the provider's own event id, not on the message.
    const userId = newId();
    await seedRecipient({ userId, email: RECIPIENT_EMAIL });
    const dispatch = await fanOutOtp(userId);
    const messageId = messageIdOf(dispatch);
    const delivered = JSON.stringify(
      makeNovuReceiptBody({ transactionId: messageId, status: "delivered", to: RECIPIENT_EMAIL })
    );
    const bounced = JSON.stringify(
      makeNovuReceiptBody({
        eventId: "evt_op137_0002",
        transactionId: messageId,
        status: "bounced",
        bounceType: "hard",
        to: RECIPIENT_EMAIL,
      })
    );

    // Act
    await receiveNovuReceipt(
      receiptRequest({ rawBody: delivered, headers: signedHeaders(delivered) })
    );
    const second = await receiveNovuReceipt(
      receiptRequest({
        rawBody: bounced,
        headers: signedHeaders(bounced, { id: "msg_op137_receipt_0002" }),
      })
    );

    // Assert
    expect(await body(second)).toEqual({ status: "received" });
    expect(await inboxRows()).toHaveLength(2);
  });

  it("I6: a payload missing a required field is still acknowledged, then recorded as a process error naming the field and the provider", async () => {
    // Arrange — the log sink is swapped in before the projection runs.
    const sink = memoryTransport();
    setLogger(
      createLogger({
        level: "trace",
        transports: [sink],
        service: "openpic-web",
        env: "test",
        version: "test-sha",
        base: { requestId: "req-op137-malformed-receipt" },
      })
    );
    const userId = newId();
    await seedRecipient({ userId, email: RECIPIENT_EMAIL });
    const dispatch = await fanOutOtp(userId);
    const payload = makeNovuReceiptBody({
      transactionId: messageIdOf(dispatch),
      status: "delivered",
      to: RECIPIENT_EMAIL,
    });
    // The provider ships a payload the adapter schema rejects: no lookup key.
    delete payload.transactionId;
    const rawBody = JSON.stringify(payload);

    // Act — the route acknowledges; the projection is what fails.
    const response = await receiveNovuReceipt(
      receiptRequest({ rawBody, headers: signedHeaders(rawBody) })
    );
    await drainDeferredProjections();

    // Assert — the provider is never told, the row says why, and the log does too.
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ status: "received" });
    const recorded = await inboxRowFor(NOVU_RECEIPT_WEBHOOK_ID);
    expect(recorded).toMatchObject({ processResult: "error" });
    expect(typeof recorded?.processError).toBe("string");
    expect(recorded?.processError).toMatch(/transactionId/);
    expect(sink.entries.filter((entry) => entry.level === "error")).toContainEqual(
      expect.objectContaining({ provider: "novu" })
    );
    // Nothing was projected from a payload that could not be read.
    expect(await dispatchOf(userId, OTP_EVENT_KEY)).toMatchObject({ status: "sent" });
    expect(await suppressions()).toEqual([]);
  });

  it("I7: a request with no signature headers is 401 and writes nothing", async () => {
    // Act
    const response = await receiveNovuReceipt(
      receiptRequest({ rawBody: JSON.stringify(makeNovuReceiptBody()) })
    );

    // Assert
    expect(response.status).toBe(401);
    expect(await inboxRows()).toEqual([]);
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("I7: a body modified after signing is 401 and writes nothing", async () => {
    // Arrange — the signature covers the raw bytes, so a re-serialised or edited
    // body must fail even though every header is present and well-formed.
    const signed = JSON.stringify(makeNovuReceiptBody({ transactionId: "msg_op137_tamper" }));
    const tampered = signed.replace("msg_op137_tamper", "msg_op137_other");

    // Act
    const response = await receiveNovuReceipt(
      receiptRequest({ rawBody: tampered, headers: signedHeaders(signed) })
    );

    // Assert
    expect(response.status).toBe(401);
    expect(await inboxRows()).toEqual([]);
  });

  it("I7: a timestamp outside the ±300 s replay window is 401 and writes nothing", async () => {
    // Arrange
    const rawBody = JSON.stringify(makeNovuReceiptBody());
    const stale = String(Math.floor(Date.now() / 1000) - 3600);

    // Act
    const response = await receiveNovuReceipt(
      receiptRequest({ rawBody, headers: signedHeaders(rawBody, { timestamp: stale }) })
    );

    // Assert
    expect(response.status).toBe(401);
    expect(await inboxRows()).toEqual([]);
  });

  it("I7: a signature made with another key is 401 and writes nothing", async () => {
    // Arrange — a structurally valid header, signed by a key this deployment
    // does not hold.
    const rawBody = JSON.stringify(makeNovuReceiptBody({ transactionId: "msg_op137_wrong_key" }));
    const headers = makeNovuWebhookHeaders({
      secret: TEST_NOVU_WEBHOOK_SECRET_PREVIOUS,
      id: NOVU_RECEIPT_WEBHOOK_ID,
      timestamp: nowSeconds(),
      rawBody,
    });

    // Act
    const response = await receiveNovuReceipt(receiptRequest({ rawBody, headers }));

    // Assert
    expect(response.status).toBe(401);
    expect(await inboxRows()).toEqual([]);
  });

  it("I7: a rotated signature header verifies when any v1 entry matches the current key", async () => {
    // Arrange — during a key rotation Svix sends one entry per active key; the
    // delivery is valid if the current key signs any of them.
    const rawBody = JSON.stringify(makeNovuReceiptBody({ transactionId: "msg_op137_rotation" }));
    const timestamp = nowSeconds();
    const headers = withExtraSignature(
      makeNovuWebhookHeaders({
        secret: TEST_NOVU_WEBHOOK_SECRET_PREVIOUS,
        id: NOVU_RECEIPT_WEBHOOK_ID,
        timestamp,
        rawBody,
      }),
      signNovuWebhook({
        secret: TEST_NOVU_WEBHOOK_SECRET,
        id: NOVU_RECEIPT_WEBHOOK_ID,
        timestamp,
        rawBody,
      })
    );

    // Act
    const response = await receiveNovuReceipt(receiptRequest({ rawBody, headers }));

    // Assert
    expect(response.status).toBe(200);
    expect(await inboxRows()).toHaveLength(1);
  });

  it("I8: a receipt no dispatch matched is ignored, never an error", async () => {
    // Arrange
    const rawBody = JSON.stringify(
      makeNovuReceiptBody({ transactionId: "msg_op137_unmatched", status: "delivered" })
    );

    // Act
    const response = await receiveNovuReceipt(
      receiptRequest({ rawBody, headers: signedHeaders(rawBody) })
    );
    await drainDeferredProjections();

    // Assert — §10.1.3: "An unmatched receipt is processResult ignored, never an error."
    expect(response.status).toBe(200);
    expect(await inboxRowFor(NOVU_RECEIPT_WEBHOOK_ID)).toMatchObject({
      processResult: "ignored",
      processError: null,
    });
    expect(await suppressions()).toEqual([]);
  });
});
