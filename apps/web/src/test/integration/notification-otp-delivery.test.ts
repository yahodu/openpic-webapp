import { ObjectId, type Db, type Document } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { memoryMessageTransport } from "@/server/adapters/memory-message-transport";
import { TransportError } from "@/server/adapters/transport-error";
import { createAuth, type AuthLike } from "@/server/auth";
import { otpInbox } from "@/server/auth/otp-inbox";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { closeMongoClient } from "@/server/db/mongo";
import {
  createLogger,
  getLogger,
  memoryTransport,
  setLogger,
  type MemoryTransport,
} from "@/server/logging";
import type { MessageTransport, OutboundMessage } from "@/server/notifications/message-transport";
import { invalidateNotificationTypeCache } from "@/server/notifications/notification-type-cache";
import { SEED_NOTIFICATION_TEMPLATES } from "@/server/notifications/notification-templates.values";
import { SEED_NOTIFICATION_TYPES } from "@/server/notifications/notification-types.values";
import { platformRepo } from "@/server/repos";

import {
  MONGO_READY_HOOK_TIMEOUT_MS,
  createTestDb,
  setupMongoTestEnv,
  type TestDb,
} from "../helpers/db";
import { authPost } from "../helpers/auth-requests";
import { expectNoSecretsInLogs } from "../helpers/log-assertions";

/**
 * Integration / contract — OTP delivery through the NotificationService
 * (OP-95, design §5, §8.2, §19.5; API Contract §0.13, §7.6; ADR-0096).
 *
 * Better Auth's OTP callbacks must not talk to the legacy memory capture or to
 * a vendor directly: every delivered one-time code goes through the synchronous
 * `NotificationService` path (`notificationOtpSender` → `sendTransactionalNow`)
 * and out through an injected `MessageTransport`. This spec drives the real
 * Better Auth HTTP handler against a real `MongoMemoryReplSet` and the real
 * seed catalogue, with the in-memory transport as the provider, and asserts:
 *
 *   I1  an email OTP reaches the transport with the code, and the persisted
 *       dispatch ledger row contains the code **nowhere** (deep scan).
 *   I2  a `whatsappCapable` user still gets the code on `sms`, never WhatsApp.
 *   I3  a transport failure surfaces as an error to Better Auth's caller, is
 *       recorded as a retryable `failed` dispatch, and no log carries the code.
 *
 * ## Contract expected of the implementation
 *
 *   - `createAuth({ db, transport })` accepts an injected `MessageTransport`
 *     (defaulting from config) and wires `notificationOtpSender` as the OTP
 *     port, replacing the OP-85 `memoryOtpSender`.
 *   - `@/server/notifications/fan-out` exports `sendTransactionalNow(input)`
 *     (ADR-0096) — the synchronous resolve → render → dispatch path. It
 *     persists one `notificationDispatches` row (metadata only, `body: null`
 *     for `retainBody: false` types) and hands a fully rendered
 *     `OutboundMessage` to the transport.
 *   - The `auth.otp.*` templates render the code (`{{code}}`), since the code is
 *     a template variable, not a persisted field.
 *
 * ## Assumptions (ADR-0096)
 *
 *   - The synchronous path resolves only the recipient's fact for the requested
 *     channel; recipient *audience* resolution is the fan-out's concern and is
 *     not exercised here.
 *   - `userId` on the synchronous dispatch is the resolved account id when one
 *     exists, else `null` (an OTP may be requested before an account exists).
 */

/** The Better Auth user collection (schema §13.1). */
const USER = "user";
const APP_ORIGIN = "http://localhost:3000";

let seq = 0;

/** A unique email per spec so the process-wide `auth.otp` limiter never bleeds. */
function uniqueEmail(): string {
  seq += 1;
  return `op95-otp-${String(seq).padStart(4, "0")}-${String(Date.now())}@example.com`;
}

/** A unique verified E.164 phone per spec (composed, never one masked literal). */
function uniquePhone(): string {
  seq += 1;
  return `+9199${String(seq).padStart(8, "0")}`;
}

beforeAll(async () => {
  await setupMongoTestEnv({
    APP_BASE_URL: APP_ORIGIN,
    ALLOWED_ORIGINS: APP_ORIGIN,
    RATE_LIMIT_PROVIDER: "memory",
    MESSAGE_TRANSPORT: "memory",
  });
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await closeMongoClient();
});

beforeEach(() => {
  invalidateNotificationTypeCache();
  otpInbox.clear();
});

/** The pieces one spec drives. */
interface Harness {
  readonly auth: AuthLike;
  readonly db: Db;
  readonly transport: MessageTransport;
}

/** Seed the real routing catalogue and copy. */
async function seedCatalogue(database: Db): Promise<void> {
  await database.collection(COLLECTIONS.notificationTypes).insertMany([...SEED_NOTIFICATION_TYPES]);
  await database
    .collection(COLLECTIONS.notificationTemplates)
    .insertMany([...SEED_NOTIFICATION_TEMPLATES]);
}

/** Seed a verified user + profile, returning the hex user id. */
async function seedVerifiedUser(
  database: Db,
  input: { readonly phone: string; readonly whatsappCapable: boolean }
): Promise<string> {
  const userId = new ObjectId();
  await database.collection(USER).insertOne({
    _id: userId,
    email: uniqueEmail(),
    emailVerified: true,
    phoneNumber: input.phone,
    phoneNumberVerified: true,
  });
  await database.collection(COLLECTIONS.userProfiles).insertOne({
    userId,
    platformRole: "client",
    locale: "en-IN",
    contactCapabilities: { whatsappCapable: input.whatsappCapable, whatsappCheckedAt: null },
  });
  return userId.toHexString();
}

/** Run `fn` against a fresh db, the real catalogue and an injected transport. */
async function withHarness(
  transport: MessageTransport,
  fn: (harness: Harness) => Promise<void>
): Promise<void> {
  const test: TestDb = createTestDb("openpic_notification_otp");
  try {
    await ensureIndexes(test.db);
    await seedCatalogue(test.db);
    const auth = createAuth({ db: test.db, transport });
    await fn({ auth, db: test.db, transport });
  } finally {
    await test.cleanup();
  }
}

/** Every stored dispatch row for one `typeKey`. */
async function dispatchesOf(database: Db, typeKey: string): Promise<readonly Document[]> {
  return database.collection(COLLECTIONS.dispatches).find({ typeKey }).toArray();
}

/** Every string anywhere in `value` that is exactly six digits. */
function sixDigitStrings(value: unknown): string[] {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      if (/^\d{6}$/.test(node)) found.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node !== null && typeof node === "object") {
      Object.values(node).forEach(visit);
    }
  };
  visit(value);
  return found;
}

/** The subject + rendered text/html of an outbound message, joined for scanning. */
function renderedBody(message: OutboundMessage | undefined): string {
  return [message?.subject, message?.text, message?.html]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
}

describe("OTP delivery through the NotificationService (OP-95)", () => {
  it("I1: an email OTP reaches the memory transport and the dispatch row carries no code", async () => {
    const transport = memoryMessageTransport();

    await withHarness(transport, async ({ auth, db }) => {
      const email = uniqueEmail();

      const response = await authPost(
        auth,
        APP_ORIGIN,
        "/api/auth/email-otp/send-verification-otp",
        { email, type: "sign-in" },
        { "x-forwarded-for": "203.0.113.10" }
      );
      expect(response.status).toBe(200);

      const captured = otpInbox.list().find((entry) => entry.to === email);
      expect(
        captured,
        "the real sender must still expose the code to the test inbox"
      ).toBeDefined();
      const code = captured?.code ?? "";
      expect(code).toMatch(/^\d{6}$/);

      // The rendered message (not a vendor payload) reaches the transport.
      const emails = transport.outbox.filter((message) => message.channel === "email");
      expect(emails).toHaveLength(1);
      expect(JSON.stringify(emails[0])).toContain(code);

      // The ledger records metadata only — the code is nowhere in it.
      const dispatches = await dispatchesOf(db, "auth.otp.email.requested");
      expect(dispatches).toHaveLength(1);
      expect(dispatches[0]).toMatchObject({
        typeKey: "auth.otp.email.requested",
        channel: "email",
        status: "sent",
      });
      expect(JSON.stringify(dispatches[0])).not.toContain(code);
      expect(sixDigitStrings(dispatches[0])).toEqual([]);

      // An OTP never enters the durable in-app feed.
      const feed = await platformRepo(db)
        .collection(COLLECTIONS.notifications)
        .countDocuments({ typeKey: "auth.otp.email.requested" });
      expect(feed).toBe(0);
    });
  });

  it("I2: a whatsappCapable user still receives the mobile OTP on sms", async () => {
    const transport = memoryMessageTransport();

    await withHarness(transport, async ({ auth, db }) => {
      const phone = uniquePhone();
      await seedVerifiedUser(db, { phone, whatsappCapable: true });

      const response = await authPost(
        auth,
        APP_ORIGIN,
        "/api/auth/phone-number/send-otp",
        { phoneNumber: phone },
        { "x-forwarded-for": "203.0.113.11" }
      );
      expect(response.status).toBe(200);

      const messages = transport.outbox;
      expect(messages).toHaveLength(1);
      expect(messages[0]?.channel).toBe("sms");
      expect(messages.map((message) => message.channel)).not.toContain("whatsapp");

      const dispatches = await dispatchesOf(db, "auth.otp.mobile.requested");
      expect(dispatches).toHaveLength(1);
      expect(dispatches[0]).toMatchObject({
        typeKey: "auth.otp.mobile.requested",
        channelGroup: "mobile",
        channel: "sms",
        status: "sent",
      });
    });
  });

  it("I3: a transport failure surfaces an error and logs no code", async () => {
    const failing: MessageTransport = {
      send: () =>
        Promise.reject(
          new TransportError("provider unavailable", { retryable: true, code: "http", status: 503 })
        ),
    };

    const previousLogger = getLogger();
    const sink: MemoryTransport = memoryTransport();
    setLogger(
      createLogger({
        level: "info",
        transports: [sink],
        service: "openpic-web",
        env: "test",
        version: "test-sha",
      })
    );

    try {
      await withHarness(failing, async ({ auth, db }) => {
        const email = uniqueEmail();

        const response = await authPost(
          auth,
          APP_ORIGIN,
          "/api/auth/email-otp/send-verification-otp",
          { email, type: "sign-in" },
          { "x-forwarded-for": "203.0.113.12" }
        );

        // The synchronous sender rejects; Better Auth surfaces a retryable 503.
        expect(response.status).toBe(503);

        // The attempt is recorded and retryable, with no code anywhere.
        const dispatches = await dispatchesOf(db, "auth.otp.email.requested");
        expect(dispatches).toHaveLength(1);
        expect(dispatches[0]).toMatchObject({
          status: "failed",
          attempts: 1,
          lastError: { retryable: true, status: 503 },
        });
        expect(sixDigitStrings(dispatches[0])).toEqual([]);

        expect(sixDigitStrings(sink.entries)).toEqual([]);
        expectNoSecretsInLogs(sink);
      });
    } finally {
      setLogger(previousLogger);
    }
  });

  /**
   * F1 (OP-95 follow-up RED, ADR-0100) — the synchronous copy is well-formed.
   *
   * `auth.otp.email.requested` declares `code` **and** `actionUrl`; the sync
   * sender passed only `{ code }`, and `renderVarsFor` defaults every missing
   * declared variable to `""`, so the delivered email read
   * `"… View the details at ."`. The settled behaviour: the synchronous OTP
   * path supplies the `actionUrl` variable it renders, using
   * `getConfig().app.baseUrl` (a non-secret app link) as the destination.
   *
   * These pins are additive; I1/I2 above still assert the code/secret rules.
   */
  it("F1: the synchronous email OTP body carries the app link and no empty-variable artefact", async () => {
    const transport = memoryMessageTransport();

    await withHarness(transport, async ({ auth }) => {
      const email = uniqueEmail();

      const response = await authPost(
        auth,
        APP_ORIGIN,
        "/api/auth/email-otp/send-verification-otp",
        { email, type: "sign-in" },
        { "x-forwarded-for": "203.0.113.20" }
      );
      expect(response.status).toBe(200);

      const code = otpInbox.list().find((entry) => entry.to === email)?.code ?? "";
      expect(code).toMatch(/^\d{6}$/);

      const emails = transport.outbox.filter((message) => message.channel === "email");
      expect(emails).toHaveLength(1);
      const body = renderedBody(emails[0]);

      // Regression (extends I1): the code still renders.
      expect(body).toContain(code);
      // The declared `actionUrl` must be supplied, not defaulted to "".
      expect(body).toContain(APP_ORIGIN);
      // No unresolved placeholder and no empty-variable artefact (" at .").
      expect(body).not.toContain("{{");
      expect(body).not.toMatch(/\bat\s*\./i);
    });
  });

  it("F1b: the synchronous sms OTP body is well-formed and carries no unresolved placeholder", async () => {
    const transport = memoryMessageTransport();

    await withHarness(transport, async ({ auth, db }) => {
      const phone = uniquePhone();
      await seedVerifiedUser(db, { phone, whatsappCapable: true });

      const response = await authPost(
        auth,
        APP_ORIGIN,
        "/api/auth/phone-number/send-otp",
        { phoneNumber: phone },
        { "x-forwarded-for": "203.0.113.21" }
      );
      expect(response.status).toBe(200);

      const messages = transport.outbox;
      expect(messages).toHaveLength(1);
      const code = otpInbox.list().find((entry) => entry.to === phone)?.code ?? "";
      expect(code).toMatch(/^\d{6}$/);

      const body = renderedBody(messages[0]);
      expect(body).toContain(code);
      expect(body).not.toContain("{{");
      expect(body).not.toMatch(/\bat\s*\./i);
    });
  });

  /**
   * F5 (OP-95 follow-up RED, ADR-0100) — the phone-path 503 surface.
   *
   * I3 pins the retryable `upstream_unavailable` surface for the email OTP
   * endpoint; this pins the same contract for `POST /api/auth/phone-number/send-otp`.
   */
  it("I4: a transport failure on the phone OTP path surfaces a retryable 503 and logs no code", async () => {
    const failing: MessageTransport = {
      send: () =>
        Promise.reject(
          new TransportError("provider unavailable", { retryable: true, code: "http", status: 503 })
        ),
    };

    const previousLogger = getLogger();
    const sink: MemoryTransport = memoryTransport();
    setLogger(
      createLogger({
        level: "info",
        transports: [sink],
        service: "openpic-web",
        env: "test",
        version: "test-sha",
      })
    );

    try {
      await withHarness(failing, async ({ auth, db }) => {
        const phone = uniquePhone();
        await seedVerifiedUser(db, { phone, whatsappCapable: true });

        const response = await authPost(
          auth,
          APP_ORIGIN,
          "/api/auth/phone-number/send-otp",
          { phoneNumber: phone },
          { "x-forwarded-for": "203.0.113.13" }
        );

        // The synchronous sender rejects; Better Auth surfaces a retryable 503.
        expect(response.status).toBe(503);
        const payload = (await response.clone().json()) as { code?: string };
        expect(payload.code).toBe("upstream_unavailable");

        // The attempt is recorded and retryable, with no code anywhere.
        const dispatches = await dispatchesOf(db, "auth.otp.mobile.requested");
        expect(dispatches).toHaveLength(1);
        expect(dispatches[0]).toMatchObject({
          status: "failed",
          attempts: 1,
          lastError: { retryable: true, status: 503 },
        });
        expect(sixDigitStrings(dispatches[0])).toEqual([]);

        expect(sixDigitStrings(sink.entries)).toEqual([]);
        expectNoSecretsInLogs(sink);
      });
    } finally {
      setLogger(previousLogger);
    }
  });
});
