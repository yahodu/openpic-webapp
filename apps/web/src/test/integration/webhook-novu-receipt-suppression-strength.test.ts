import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `next/server`'s `after` is again the seam this suite drains for the "answer
 * first, project after" half of contract §10.1 (ADR-0882). The mock is hoisted
 * so the route binds to it on import.
 */
const afterMock = vi.hoisted(() => vi.fn<(callback: () => unknown) => void>());

vi.mock("next/server", () => ({ after: afterMock }));

import { POST as applyUnsubscribe } from "@/app/api/v1/notifications/unsubscribe/[token]/route";
import { POST as receiveNovuReceipt } from "@/app/api/v1/webhooks/novu/route";
import { memoryMessageTransport } from "@/server/adapters/memory-message-transport";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { getLogger, setLogger } from "@/server/logging";
import { contactHashOf } from "@/server/notifications/contact-hash";
import { runNotificationFanOut, type RecipientRepository } from "@/server/notifications/fan-out";
import { invalidateNotificationTypeCache } from "@/server/notifications/notification-type-cache";
import { SEED_NOTIFICATION_TEMPLATES } from "@/server/notifications/notification-templates.values";
import { SEED_NOTIFICATION_TYPES } from "@/server/notifications/notification-types.values";
import { signUnsubscribeToken } from "@/server/notifications/unsubscribe";
import { fixedClock } from "@/server/runtime/clock";

import { APP_ORIGIN, makeIdentity, startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { fixtureInstant } from "../helpers/fixture-clock";
import {
  makeNovuReceiptBody,
  makeNovuWebhookHeaders,
  NOVU_RECEIPT_WEBHOOK_ID,
  TEST_NOVU_WEBHOOK_SECRET,
} from "../factories/novu-webhook";

/**
 * Integration / contract — the **strength** of a delivery-receipt suppression
 * (OP-137, contract §10.1.3 and §19.6; ADR-0889).
 *
 * The user story is *"we never re-send to hard-bounced or DND contacts"*. Two
 * writes own the same `{channel, contactHash}` suppression key: the receipt
 * projection (`@/server/notifications/receipt-projection`, ADR-0882) and the
 * one-click unsubscribe route (`…/notifications/unsubscribe/[token]/route`,
 * ADR-0240). A `hard_bounce` is `scope: "all"`; a marketing unsubscribe is
 * `scope: "marketing"` and — by §10.1.3's own note — must never block a
 * transactional OTP. The key is shared, so whichever write lands second decides
 * which contacts keep receiving:
 *
 *  - **P1** a later `hard_bounce` **upgrades** a `scope: "marketing"`
 *    unsubscribe row to `reason: "hard_bounce"`, `scope: "all"`, so the
 *    hard-bounced contact is not sent the next transactional email;
 *  - **P2** a `hard_bounce` **re-arms** a lapsed all-scope row
 *    (`expiresAt` → `null`), so a suppression the fan-out's
 *    `expiresAt: { $gt: now }` filter has stopped honouring starts applying
 *    again;
 *  - **P3** a later marketing unsubscribe **never downgrades** a
 *    `hard_bounce`/`all` row: the row stays all-scope (the marketing opt-out
 *    itself is still recorded on the profile);
 *  - **P4** the projection stores the **digest only**: the whole suppression
 *    document's key set is pinned, so a raw `contact` field cannot ride along.
 *
 * ## Contract expected of the implementation
 *
 * - The suppression upsert on the receipt path may not treat an existing row as
 *   unmodifiable: `reason`, `scope`, `expiresAt` and `source` are the row's
 *   live strength, and a stronger receipt must replace a weaker one.
 * - The unsubscribe route may not rewrite a row whose `scope` is already
 *   stronger than the write it is applying (ADR-0300's "upgrade, never
 *   downgrade" applies to the same key).
 * - The stored document is `{channel, contactHash, reason, scope, source,
 *   createdAt, expiresAt}` (design §19.6) and nothing else; `contactHash` is
 *   `"sha256:"` + `contactHashOf(contact)`, never the raw address.
 *
 * ## Assumptions recorded in the handoff (ADR-0889)
 *
 * - `T0` (`fixtureInstant("00:00:00.000Z")`) is the suite's fixture instant; the
 *   lapsed row of P2 is anchored an hour **before** it, so "expired" is a fact
 *   of the seed and never of when the suite runs.
 * - The marketing unsubscribe of P3 is driven through the real route with a
 *   token minted by `signUnsubscribeToken` and the app's own
 *   `UNSUBSCRIBE_SIGNING_SECRET`, i.e. the same path a mail client takes.
 * - The dispatch rows come from the **real** fan-out, so the suppression key is
 *   the ledger's own `contactHash`, not a fixture's guess.
 */

/** The recipient's address; the suppression key under test. */
const RECIPIENT_EMAIL = "strength.recipient@example.com";

/** The transactional type a hard bounce must stop; a marketing row must not. */
const OTP_EVENT_KEY = "auth.otp.email.requested";

/** The receipt webhook's path. */
const RECEIPT_PATH = "/api/v1/webhooks/novu";

/** The one-click unsubscribe prefix (contract §7.5). */
const UNSUBSCRIBE_PREFIX = "/api/v1/notifications/unsubscribe";

/** The environment the suite boots with. */
const RECEIPT_ENV: Record<string, string> = {
  MESSAGE_TRANSPORT: "memory",
  NOVU_WEBHOOK_SECRET: TEST_NOVU_WEBHOOK_SECRET,
};

/** The suite's fixture instant (retention-anchored, never a literal date). */
const T0 = fixtureInstant("00:00:00.000Z");

/** One hour before the anchor: a suppression the fan-out no longer honours. */
const LAPSED_AT = new Date(new Date(T0).getTime() - 60 * 60 * 1000);

/** The clock the fan-out runs against. */
const fanOutClock = fixedClock(T0);

/** Fields of a stored dispatch row this suite reads (schema §19.5). */
interface StoredDispatch {
  readonly _id: unknown;
  readonly typeKey?: unknown;
  readonly status?: unknown;
  readonly skipReason?: unknown;
  readonly attempts?: unknown;
  readonly contactHash?: unknown;
  readonly providerRef?: { readonly provider?: unknown; readonly messageId?: unknown };
}

let app: TestApp;

/** The process logger in place before the suite touches it. */
let ambientLogger: ReturnType<typeof getLogger>;

/** The signing secret the app under test reads for unsubscribe tokens. */
let unsubscribeSecret: string;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op137-strength", env: RECEIPT_ENV });
  // The unique indexes of §18.4 and §19.6 **are** the dedupe, so the suite
  // builds the declared registry against its private database first.
  await ensureIndexes(app.db);
  await app.db.collection(COLLECTIONS.notificationTypes).insertMany([...SEED_NOTIFICATION_TYPES]);
  await app.db
    .collection(COLLECTIONS.notificationTemplates)
    .insertMany([...SEED_NOTIFICATION_TEMPLATES]);
  ambientLogger = getLogger();
  unsubscribeSecret = String(process.env.UNSUBSCRIBE_SIGNING_SECRET);
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
    claimerId: "worker_op137_strength",
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

/** Seed the suppression row a first-party unsubscribe writes (§19.6, ADR-0240). */
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
  readonly status: "delivered" | "bounced";
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

describe("suppression strength — a hard bounce upgrades a weaker row (P1)", () => {
  it("P1: a hard bounce replaces a marketing-unsubscribe row with reason hard_bounce, scope all, and the next transactional send is suppressed", async () => {
    // Arrange — the ledger row, then exactly the row a provider unsubscribe
    // leaves behind for the same `{channel, contactHash}` key.
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

    // Act — the provider reports a permanent bounce for that dispatch.
    const response = await deliverReceipt({ dispatch, status: "bounced", bounceType: "hard" });

    // Assert — the receipt was applied…
    expect(response.status).toBe(200);
    expect((await dispatchesOfType(userId, OTP_EVENT_KEY))[0]).toMatchObject({
      status: "bounced",
    });

    // …and the all-scope hard bounce is the row that survives: it must not be
    // masked by the weaker marketing unsubscribe it shares a key with.
    const row = await onlySuppression();
    expect(row).toMatchObject({
      channel: "email",
      contactHash: key,
      reason: "hard_bounce",
      scope: "all",
      expiresAt: null,
    });

    // The observable consequence: the hard-bounced contact receives no further
    // transactional email, so no dispatch of the type reaches `sent`.
    const transport = memoryMessageTransport();
    await insertEvent({ eventKey: OTP_EVENT_KEY, subjectUserId: userId });
    await runFanOut(transport);
    expect(await dispatchesOfType(userId, OTP_EVENT_KEY)).not.toContainEqual(
      expect.objectContaining({ status: "sent" })
    );
    expect(transport.outbox).toEqual([]);
  });
});

describe("suppression strength — a hard bounce re-arms a lapsed row (P2)", () => {
  it("P2: a hard bounce clears a past expiresAt, so the all-scope row stops being excluded by the fan-out", async () => {
    // Arrange — the same key, all-scope, with an `expiresAt` the fan-out's
    // `expiresAt: { $gt: now }` filter treats as lapsed.
    const userId = newId();
    await seedRecipient({ userId, email: RECIPIENT_EMAIL });
    const dispatch = await fanOutOtp(userId);
    const key = suppressionContactHash(RECIPIENT_EMAIL);
    await seedSuppression({
      contactHash: key,
      reason: "hard_bounce",
      scope: "all",
      expiresAt: LAPSED_AT,
      source: { provider: "novu", providerEventId: NOVU_RECEIPT_WEBHOOK_ID },
    });

    // Act
    const response = await deliverReceipt({ dispatch, status: "bounced", bounceType: "hard" });

    // Assert — the projection re-arms the row rather than leaving it expired.
    expect(response.status).toBe(200);
    const row = await onlySuppression();
    expect(row).toMatchObject({
      channel: "email",
      contactHash: key,
      reason: "hard_bounce",
      scope: "all",
      expiresAt: null,
    });
  });
});

describe("suppression strength — a marketing unsubscribe never downgrades (P3)", () => {
  it("P3: a marketing unsubscribe after a hard bounce leaves the row all-scope and still records the marketing opt-out", async () => {
    // Arrange — a signed-in contact whose address already carries the
    // all-scope hard-bounce row the receipt projection writes.
    const session = await app.signIn(makeIdentity("op137-strength-p3"));
    const key = suppressionContactHash(session.identity.email);
    await seedSuppression({
      contactHash: key,
      reason: "hard_bounce",
      scope: "all",
      expiresAt: null,
      source: { provider: "novu", providerEventId: NOVU_RECEIPT_WEBHOOK_ID },
    });

    // Act — the contact clicks "unsubscribe from marketing" in a mail footer.
    const token = signUnsubscribeToken(
      { userId: session.userId.toHexString(), scope: "marketing" },
      { secret: unsubscribeSecret, now: fixedClock(new Date()) }
    );
    const response = await applyUnsubscribe(
      new Request(new URL(`${UNSUBSCRIBE_PREFIX}/${token}`, APP_ORIGIN), { method: "POST" })
    );

    // Assert — the write applied…
    expect(response.status).toBe(200);

    // …and the stronger row survives: an all-scope hard bounce can never be
    // narrowed to marketing by a later, weaker unsubscribe.
    const row = await onlySuppression();
    expect(row).toMatchObject({
      channel: "email",
      contactHash: key,
      reason: "hard_bounce",
      scope: "all",
      expiresAt: null,
    });

    // The marketing opt-out itself is still recorded on the profile.
    const profile = await app.db
      .collection(COLLECTIONS.userProfiles)
      .findOne({ userId: session.userId });
    expect(profile?.marketingOptIn).toBe(false);
  });
});

describe("suppression strength — the stored document is the digest only (P4)", () => {
  it("P4: a receipt-written suppression stores exactly the §19.6 key set and never the raw contact", async () => {
    // Arrange — a fresh hard bounce, so the row is the projection's own insert.
    const userId = newId();
    await seedRecipient({ userId, email: RECIPIENT_EMAIL });
    const dispatch = await fanOutOtp(userId);
    const key = suppressionContactHash(RECIPIENT_EMAIL);

    // Act
    await deliverReceipt({ dispatch, status: "bounced", bounceType: "hard" });

    // Assert — the whole document, so an extra field cannot hide behind a
    // `objectContaining` matcher.
    const row = await onlySuppression();
    expect(row).toEqual({
      _id: expect.any(ObjectId),
      channel: "email",
      contactHash: key,
      reason: "hard_bounce",
      scope: "all",
      source: { provider: "novu", providerEventId: NOVU_RECEIPT_WEBHOOK_ID },
      createdAt: expect.any(Date),
      expiresAt: null,
    });
    expect(Object.keys(row).sort()).toEqual([
      "_id",
      "channel",
      "contactHash",
      "createdAt",
      "expiresAt",
      "reason",
      "scope",
      "source",
    ]);

    // The requirement behind the shape: the contact is stored hashed, never raw.
    expect(JSON.stringify(row)).not.toContain(RECIPIENT_EMAIL);
    expect(String(row.contactHash)).toBe(key);
  });
});
