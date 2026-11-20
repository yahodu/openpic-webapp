import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `next/server`'s `after` is the seam the receipt route defers its projection
 * through (§10.1 step 6). The mock is hoisted so the route binds to it on
 * import, and the default is inert: a case decides when the deferred work runs.
 */
const afterMock = vi.hoisted(() => vi.fn<(callback: () => unknown) => void>());

vi.mock("next/server", () => ({ after: afterMock }));

import { POST as applyUnsubscribe } from "@/app/api/v1/notifications/unsubscribe/[token]/route";
import { POST as receiveNovuReceipt } from "@/app/api/v1/webhooks/novu/route";
import { memoryMessageTransport } from "@/server/adapters/memory-message-transport";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { contactHashOf } from "@/server/notifications/contact-hash";
import { runNotificationFanOut, type RecipientRepository } from "@/server/notifications/fan-out";
import { invalidateNotificationTypeCache } from "@/server/notifications/notification-type-cache";
import { SEED_NOTIFICATION_TEMPLATES } from "@/server/notifications/notification-templates.values";
import { SEED_NOTIFICATION_TYPES } from "@/server/notifications/notification-types.values";
import { signUnsubscribeToken } from "@/server/notifications/unsubscribe";
import { fixedClock } from "@/server/runtime/clock";

import { body } from "../helpers/auth-requests";
import { APP_ORIGIN, startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { fixtureInstant } from "../helpers/fixture-clock";
import {
  makeNovuReceiptBody,
  makeNovuWebhookHeaders,
  TEST_NOVU_WEBHOOK_SECRET,
} from "../factories/novu-webhook";

/**
 * Integration / contract — **one** canonical contact digest, end to end
 * (OP-137 follow-up; contract §10.1.3; design §19.5/§19.6; ADR-0875 §1,
 * ADR-0882, ADR-0888).
 *
 * Design §19.6 keys a suppression on `{channel, contactHash}`, and three writers
 * derive that key: the fan-out writes the ledger's `contactHash`, the receipt
 * projection keys the suppression from it, and the one-click unsubscribe route
 * writes the row a later fan-out looks up. Every one of them must use the single
 * shared digest `contactHashOf` = `sha256(trim + lowercase)`, because a delivery
 * provider echoes the address it was handed in its own casing and spacing — and
 * a stored address may itself carry padding.
 *
 * The canonical-address cases live in `notification-fan-out.test.ts` and
 * `webhook-novu-receipts.test.ts` and are left untouched. This suite uses a
 * **non-canonical** stored address throughout (`"  Probe.Recipient@Example.COM "`,
 * which normalises to `probe.recipient@example.com`), which is the only shape in
 * which a second, independently written digest is observable:
 *
 *   I9  the fan-out's `notificationDispatches.contactHash` is the shared digest;
 *   I10 a hard bounce keys the suppression `"sha256:"` + the shared digest;
 *   I11 the next marketing fan-out to that address is `skipped`/`suppressed`;
 *   I12 the unsubscribe route's row is keyed by the shared digest;
 *   I13 an unsubscribe then a fan-out round trip skips the marketing email.
 *
 * ## Contract expected of the implementation
 *
 * - `runNotificationFanOut({ db, clock, transport, recipients, batch, claimerId })`
 *   writes `notificationDispatches.contactHash = contactHashOf(<the stored
 *   address>)` — the same value the suppression lookup in `loadSuppressions`
 *   builds as `"sha256:" + contactHashOf(<the same address>)`.
 * - `projectDeliveryReceipt` (via `POST /api/v1/webhooks/novu` and the deferred
 *   `after()` callback) keys `notificationSuppressions.contactHash` as
 *   `"sha256:" + dispatch.contactHash`, i.e. the shared digest, never the
 *   receipt's own bytes.
 * - `POST /api/v1/notifications/unsubscribe/{token}` with `scope: "marketing"`
 *   keys its row `"sha256:" + contactHashOf(<the stored email>)`.
 *
 * The expected GREEN is one change and no test edit: the fan-out's private
 * `contactHashOf` (the raw `sha256(destination)`) delegates to the shared
 * `contactHashOf` it already imports. The unsubscribe route's own copy is
 * behaviourally canonical today and may be consolidated in the same pass —
 * `I12`/`I13` neither demand nor forbid it.
 *
 * ## Assumptions recorded in the handoff
 *
 * - A stored address is **not** normalised on write: the fan-out and the
 *   unsubscribe route both read `user.email` as stored, which is why the digest
 *   — not the stored bytes — has to carry the canonical form.
 * - `contactHashOf` is imported from the shared module and is the only digest
 *   this suite computes; no case re-implements `sha256` locally, so a change to
 *   the canonical form moves the expectation and the writer together.
 * - The suppression lookup's channel match and its marketing/transactional
 *   scope split are pinned elsewhere (I4 of `webhook-novu-receipts.test.ts`);
 *   this suite pins the **key**, not the scope.
 */

/** A stored address that is neither trimmed nor lower-cased. */
const STORED_EMAIL = "  Probe.Recipient@Example.COM ";

/** The canonical form {@link STORED_EMAIL} normalises to. */
const CANONICAL_EMAIL = "probe.recipient@example.com";

/** The transactional type the fan-out first sends an email for. */
const OTP_EVENT_KEY = "auth.otp.email.requested";

/** A non-transactional, email-carrying type: what a marketing suppression blocks. */
const MARKETING_EVENT_KEY = "account.verification.incomplete";

/** The `webhook-id` of the receipt this suite delivers (the inbox identity). */
const RECEIPT_ID = "msg_op137_digest_0001";

/** The path the receipt webhook is served on. */
const RECEIPT_PATH = "/api/v1/webhooks/novu";

/** The path prefix the unsubscribe token is appended to. */
const UNSUBSCRIBE_PREFIX = "/api/v1/notifications/unsubscribe";

/** A fixed fan-out instant (retention-anchored, never a literal date). */
const T0 = fixtureInstant("00:00:00.000Z");

/** The clock the fan-out runs against. */
const fanOutClock = fixedClock(T0);

/** The environment this suite boots with: the Svix secret the receipt route reads. */
const RECEIPT_ENV: Record<string, string> = {
  MESSAGE_TRANSPORT: "memory",
  NOVU_WEBHOOK_SECRET: TEST_NOVU_WEBHOOK_SECRET,
};

/** Fields of a stored dispatch row this suite reads (schema §19.5). */
interface StoredDispatch {
  readonly typeKey?: unknown;
  readonly channel?: unknown;
  readonly status?: unknown;
  readonly skipReason?: unknown;
  readonly contactHash?: unknown;
  readonly providerRef?: { readonly messageId?: unknown };
}

/** Fields of a stored suppression row this suite reads (design §19.6). */
interface StoredSuppression {
  readonly channel?: unknown;
  readonly contactHash?: unknown;
  readonly reason?: unknown;
  readonly scope?: unknown;
}

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op137-digest", env: RECEIPT_ENV });
  // The §19.6 unique index on `{channel, contactHash}` is what makes the
  // suppression idempotent, so the declared registry is built before any case.
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
    claimerId: "worker_op137_digest",
  });
}

/** The one dispatch row of a type for a recipient. */
async function dispatchOf(userId: string, typeKey: string): Promise<StoredDispatch | undefined> {
  const rows = await app.db
    .collection<StoredDispatch>(COLLECTIONS.dispatches)
    .find({ userId: new ObjectId(userId) })
    .toArray();
  return rows.find((row) => String(row.typeKey) === typeKey);
}

/** Every suppression row. */
async function suppressions(): Promise<readonly StoredSuppression[]> {
  return app.db
    .collection<StoredSuppression>(COLLECTIONS.notificationSuppressions)
    .find({})
    .toArray();
}

/** The `providerRef.messageId` a delivery's receipt must name. */
function messageIdOf(dispatch: StoredDispatch | undefined): string {
  const messageId = dispatch?.providerRef?.messageId;
  if (typeof messageId !== "string" || messageId === "") {
    throw new Error("the dispatch carries no providerRef.messageId");
  }
  return messageId;
}

/** A `POST` to the receipt webhook: a raw body and its signed headers. */
function receiptRequest(input: {
  readonly rawBody: string;
  readonly headers: Record<string, string>;
}): Request {
  return new Request(new URL(RECEIPT_PATH, APP_ORIGIN).toString(), {
    method: "POST",
    headers: { "content-type": "application/json", ...input.headers },
    body: input.rawBody,
  });
}

/** The signed headers a delivery of `rawBody` carries. */
function signedHeaders(rawBody: string): Record<string, string> {
  return makeNovuWebhookHeaders({
    secret: TEST_NOVU_WEBHOOK_SECRET,
    id: RECEIPT_ID,
    timestamp: String(Math.floor(Date.now() / 1000)),
    rawBody,
  });
}

/** Run the work the receipt route deferred through `after()`, in scheduling order. */
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

/** Deliver a signed hard bounce for `dispatch` and project it. */
async function hardBounce(dispatch: StoredDispatch): Promise<void> {
  const rawBody = JSON.stringify(
    makeNovuReceiptBody({
      transactionId: messageIdOf(dispatch),
      status: "bounced",
      bounceType: "hard",
      to: STORED_EMAIL,
    })
  );
  await receiveNovuReceipt(receiptRequest({ rawBody, headers: signedHeaders(rawBody) }));
  await drainDeferredProjections();
}

/** A `POST` that applies a `scope: "marketing"` unsubscribe for `userId`. */
async function unsubscribeMarketing(userId: string): Promise<Response> {
  const token = signUnsubscribeToken(
    { userId, scope: "marketing" },
    { secret: String(process.env.UNSUBSCRIBE_SIGNING_SECRET), now: fanOutClock }
  );
  return applyUnsubscribe(
    new Request(new URL(`${UNSUBSCRIBE_PREFIX}/${token}`, APP_ORIGIN), { method: "POST" })
  );
}

describe("contact digest — the ledger the fan-out writes (I9)", () => {
  it("I9: the fan-out writes the shared digest of a stored address that is padded and mixed-case", async () => {
    // Arrange — the stored bytes are not their own canonical form.
    const userId = newId();
    await seedRecipient({ userId, email: STORED_EMAIL });
    expect(contactHashOf(STORED_EMAIL)).toBe(contactHashOf(CANONICAL_EMAIL));
    expect(STORED_EMAIL).not.toBe(CANONICAL_EMAIL);

    // Act
    await fanOutOtp(userId);

    // Assert — the ledger carries the shared digest, which is the value a
    // suppression lookup on this address is keyed by.
    const dispatch = await dispatchOf(userId, OTP_EVENT_KEY);
    expect(dispatch?.contactHash).toBe(contactHashOf(STORED_EMAIL));
  });
});

describe("contact digest — the suppression key the projection writes (I10, I11)", () => {
  it("I10: a hard bounce keys the suppression with the shared digest of the stored address", async () => {
    // Arrange — a real ledger row from the real fan-out.
    const userId = newId();
    await seedRecipient({ userId, email: STORED_EMAIL });
    const dispatch = await fanOutOtp(userId);

    // Act
    await hardBounce(dispatch);

    // Assert — §19.6: one row, keyed `"sha256:"` + the shared digest.
    expect(await suppressions()).toEqual([
      expect.objectContaining({
        channel: "email",
        contactHash: `sha256:${contactHashOf(STORED_EMAIL)}`,
        reason: "hard_bounce",
        scope: "all",
      }),
    ]);
  });

  it("I11: a later fan-out to the hard-bounced address is skipped as suppressed", async () => {
    // Arrange — the bounce lands first, so the next send must be refused before
    // the transport is ever asked.
    const userId = newId();
    await seedRecipient({ userId, email: STORED_EMAIL });
    await hardBounce(await fanOutOtp(userId));

    // Act — a fresh marketing send to the same stored address.
    const transport = memoryMessageTransport();
    await insertEvent({ eventKey: MARKETING_EVENT_KEY, subjectUserId: userId });
    await runFanOut(transport);

    // Assert
    expect(await dispatchOf(userId, MARKETING_EVENT_KEY)).toMatchObject({
      status: "skipped",
      skipReason: "suppressed",
    });
    expect(transport.outbox).toEqual([]);
  });
});

describe("contact digest — the row the unsubscribe route writes (I12, I13)", () => {
  it("I12: the unsubscribe route keys its row with the shared digest of the stored address", async () => {
    // Arrange
    const userId = newId();
    await seedRecipient({ userId, email: STORED_EMAIL });

    // Act — the mail-client `POST` the token authorises.
    const response = await unsubscribeMarketing(userId);

    // Assert
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ applied: true, scope: "marketing" });
    expect(await suppressions()).toEqual([
      expect.objectContaining({
        channel: "email",
        contactHash: `sha256:${contactHashOf(STORED_EMAIL)}`,
        reason: "unsubscribe",
        scope: "marketing",
      }),
    ]);
  });

  it("I13: after the unsubscribe applies, the next marketing fan-out to the stored address is skipped", async () => {
    // Arrange
    const userId = newId();
    await seedRecipient({ userId, email: STORED_EMAIL });
    const unsubscribed = await unsubscribeMarketing(userId);
    expect(unsubscribed.status).toBe(200);

    // Act — the fan-out looks the suppression up from the same stored address.
    const transport = memoryMessageTransport();
    await insertEvent({ eventKey: MARKETING_EVENT_KEY, subjectUserId: userId });
    await runFanOut(transport);

    // Assert
    expect(await dispatchOf(userId, MARKETING_EVENT_KEY)).toMatchObject({
      status: "skipped",
      skipReason: "suppressed",
    });
    expect(transport.outbox).toEqual([]);
  });
});
