import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAuth, type AuthLike } from "@/server/auth";
import { NEW_DEVICE_WINDOW_MS, hashFingerprint } from "@/server/auth/device-fingerprint";
import {
  handleContactVerified,
  handleSessionCreated,
  handleUserCreated,
} from "@/server/auth/identity-hooks";
import { otpInbox } from "@/server/auth/otp-inbox";
import { getRateLimitConfig } from "@/server/config/env";
import { ensureIndexes } from "@/server/db/indexes";
import { closeMongoClient } from "@/server/db/mongo";
import { createLogger, memoryTransport, setLogger, type MemoryTransport } from "@/server/logging";
import { invalidateNotificationTypeCache } from "@/server/notifications/notification-type-cache";
import { fixedClock } from "@/server/runtime/clock";
import { invalidatePlatformSettings } from "@/server/settings/platform-settings";

import { authPost, sessionCookie, setCookies, cookiePair } from "../helpers/auth-requests";
import {
  MONGO_READY_HOOK_TIMEOUT_MS,
  createTestDb,
  setupMongoTestEnv,
  type TestDb,
} from "../helpers/db";

/**
 * Integration / contract — Better Auth identity lifecycle hooks (OP-89,
 * contract §1.1 "hook table", §7.7 domain events; schema §13.2, §18.3, §19.3).
 *
 * The card pins three lifecycle events and their observable effects:
 *
 *   after user created     → userProfiles + notificationPreferences defaults,
 *                            lazy invite resolution, and the welcome event;
 *   after contact verified → accountCompletedAt once, then no re-emit;
 *   after session created  → new-device (1/device/24h) and admin sign-in events.
 *
 * ## Contract expected of the implementation
 *
 * `@/server/auth/identity-hooks` exports three plain-input policy handlers
 * (the Better Auth `after` hook adapts its context into these inputs):
 *
 *   handleUserCreated(event, deps)
 *   handleContactVerified(event, deps)
 *   handleSessionCreated(event, deps)
 *
 *   event: { userId: string; ... } — the Better Auth user id as a hex string
 *   deps:  { db: Db; emit?; clock? } — `emit` defaults to `emitDomainEvent`
 *
 * To make the failure path injectable, `createAuth` gains an optional `emit`
 * seam beside its existing `db` seam:
 *
 *   createAuth({ db, emit? }): AuthLike
 *
 * Every handler is **idempotent** and **must never throw on an emit failure**:
 * a broken outbox logs `identity_hook.emit_failed` at error level and the auth
 * request still succeeds.
 *
 * Device fingerprints are salted with the deployment salt
 * (`getRateLimitConfig().salt`) and are emitted on the `auth.signin.new_device`
 * payload as `{ deviceHash }`; raw user-agent/IP values never reach the outbox.
 *
 * Stored-collection names follow the schema §13.2 / §19.3 (camelCase, not in
 * `COLLECTIONS`): `userProfiles`, `notificationPreferences`; the Better Auth
 * auth collections are `user`/`session`, and the outbox is `domain_events`.
 */

/** The auth collections Better Auth owns (schema §13.1). */
const USER_COLLECTION = "user";
const USER_PROFILES_COLLECTION = "userProfiles";
const NOTIFICATION_PREFERENCES_COLLECTION = "notificationPreferences";
const INVITATIONS_COLLECTION = "invitations";
const DOMAIN_EVENTS_COLLECTION = "domain_events";

/** A fixed instant so `accountCompletedAt` / dedupe buckets are deterministic. */
const T0 = new Date("2026-03-01T00:00:00.000Z");

/** A per-run unique suffix so emailed identities never share a rate-limit bucket. */
function uniqueSuffix(): string {
  return `${String(Date.now())}-${Math.random().toString(16).slice(2)}`;
}

/** The documented 24-hour new-device window, as a local number for arithmetic. */
const NEW_DEVICE_WINDOW = 24 * 60 * 60 * 1000;

/** The stored outbox fields these specs inspect. */
interface StoredEvent {
  readonly eventKey: string;
  readonly subjectRef: { readonly kind: string; readonly id: string };
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
  readonly dedupeKey?: string;
}

/** Plain inputs the lifecycle handlers accept. */
interface UserCreatedEvent {
  readonly userId: string;
  readonly email: string;
  readonly phoneNumber?: string | null;
  readonly acceptLanguage?: string | null;
  readonly timeZone?: string | null;
}

interface ContactVerifiedEvent {
  readonly userId: string;
}

interface SessionCreatedEvent {
  readonly userId: string;
  readonly sessionId: string;
  readonly device: {
    readonly userAgent?: string | null;
    readonly ip?: string | null;
    readonly acceptLanguage?: string | null;
  };
}

beforeAll(async () => {
  await setupMongoTestEnv({
    APP_BASE_URL: "http://localhost:3000",
    ALLOWED_ORIGINS: "http://localhost:3000",
    RATE_LIMIT_PROVIDER: "memory",
    MESSAGE_TRANSPORT: "memory",
  });
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await closeMongoClient();
});

beforeEach(() => {
  // Both read paths are cached process-wide; the outbox resolves the enabled
  // notification-type set on every emit.
  invalidatePlatformSettings();
  invalidateNotificationTypeCache();
});

/** Run `fn` against a fresh, indexed throwaway database, always dropping it. */
async function withTestDb(fn: (test: TestDb) => Promise<void>): Promise<void> {
  const test = createTestDb("openpic_identity_hooks");
  try {
    await ensureIndexes(test.db);
    await fn(test);
  } finally {
    await test.cleanup();
  }
}

/** Every outbox row at `eventKey`, in insertion order. */
async function eventsByKey(test: TestDb, eventKey: string): Promise<StoredEvent[]> {
  return test.db.collection<StoredEvent>(DOMAIN_EVENTS_COLLECTION).find({ eventKey }).toArray();
}

/** Insert the Better Auth `user` document the contact-verified hook reads. */
async function insertAuthUser(
  test: TestDb,
  userId: ObjectId,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  await test.db.collection(USER_COLLECTION).insertOne({
    _id: userId,
    email: `user-${userId.toHexString()}@example.com`,
    emailVerified: false,
    phoneNumberVerified: false,
    ...overrides,
  });
}

/** Insert the `userProfiles` row a session-created hook reads. */
async function insertProfile(
  test: TestDb,
  userId: ObjectId,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  await test.db.collection(USER_PROFILES_COLLECTION).insertOne({
    userId,
    status: "active",
    platformRole: "client",
    accountCompletedAt: null,
    primaryTenantId: null,
    locale: "en-IN",
    schemaVersion: 1,
    ...overrides,
  });
}

/** Install a capturing logger and return its transport. */
function installMemoryLogger(): MemoryTransport {
  const sink = memoryTransport();
  setLogger(
    createLogger({
      level: "info",
      transports: [sink],
      service: "openpic-web",
      env: "test",
      version: "test-sha",
    })
  );
  return sink;
}

describe("handleUserCreated — profile, preferences and lazy invites", () => {
  it("I1: sign-up through the auth surface creates exactly one profile and one preferences doc", async () => {
    await withTestDb(async (test) => {
      const auth: AuthLike = createAuth({ db: test.db });
      const email = `op89-signup-${uniqueSuffix()}@example.com`;
      const ip = `203.0.113.${String((Date.now() % 200) + 10)}`;

      const sent = await authPost(
        auth,
        "http://localhost:3000",
        "/api/auth/email-otp/send-verification-otp",
        { email, type: "sign-in" },
        { "x-forwarded-for": ip }
      );
      expect(sent.status).toBe(200);
      const otp = otpInbox.take("email", email) as { code: string } | undefined;
      if (otp === undefined) {
        throw new Error("expected an email OTP to be captured");
      }

      const signedIn = await authPost(
        auth,
        "http://localhost:3000",
        "/api/auth/sign-in/email-otp",
        { email, otp: otp.code },
        { "x-forwarded-for": ip }
      );
      expect(signedIn.status).toBe(200);
      expect(sessionCookie(signedIn)).toBeDefined();

      const profiles = await test.db.collection(USER_PROFILES_COLLECTION).find({}).toArray();
      const preferences = await test.db
        .collection(NOTIFICATION_PREFERENCES_COLLECTION)
        .find({})
        .toArray();

      expect(profiles).toHaveLength(1);
      expect(preferences).toHaveLength(1);
      expect(profiles[0]?.platformRole).toBe("client");
      expect(profiles[0]?.status).toBe("active");
      expect(profiles[0]?.marketingOptIn).toBe(false);
      expect(preferences[0]?.global).toEqual({ email: "on", mobile: "off", in_app: "on" });
    });
  });

  it("I1: creating the same profile twice still leaves exactly one profile and one preferences doc", async () => {
    await withTestDb(async (test) => {
      const userId = new ObjectId();
      const event: UserCreatedEvent = {
        userId: userId.toHexString(),
        email: `dup-${userId.toHexString()}@example.com`,
        acceptLanguage: "en-IN",
        timeZone: "Asia/Kolkata",
      };

      await handleUserCreated(event, { db: test.db, clock: fixedClock(T0) });
      await handleUserCreated(event, { db: test.db, clock: fixedClock(T0) });

      expect(await test.db.collection(USER_PROFILES_COLLECTION).countDocuments({})).toBe(1);
      expect(await test.db.collection(NOTIFICATION_PREFERENCES_COLLECTION).countDocuments({})).toBe(
        1
      );
    });
  });

  it("I2: a pending invitation for the email gets invitee.userId set and emits the invite event", async () => {
    await withTestDb(async (test) => {
      const userId = new ObjectId();
      const invitationId = new ObjectId();
      const tenantId = new ObjectId();
      const email = `invitee-${userId.toHexString()}@example.com`;

      await test.db.collection(INVITATIONS_COLLECTION).insertOne({
        _id: invitationId,
        kind: "event_co_organizer",
        tenantId,
        eventId: new ObjectId(),
        invitedByUserId: new ObjectId(),
        invitee: { kind: "email", email },
        status: "pending",
        role: "co_organizer",
        tokenHash: `token-${invitationId.toHexString()}`,
        channelsNotified: ["email"],
        expiresAt: new Date(T0.getTime() + 14 * 24 * 3600_000),
        createdAt: T0,
        updatedAt: T0,
      });

      await handleUserCreated(
        { userId: userId.toHexString(), email, acceptLanguage: "en-IN" },
        { db: test.db, clock: fixedClock(T0) }
      );

      const invitation = await test.db
        .collection(INVITATIONS_COLLECTION)
        .findOne({ _id: invitationId });
      expect(invitation?.invitee).toMatchObject({ userId });

      const invites = await eventsByKey(test, "collab.invite.sent");
      expect(invites).toHaveLength(1);
      expect(invites[0]?.subjectRef).toEqual({
        kind: "invitation",
        id: invitationId.toHexString(),
      });

      // The welcome for the new account is emitted alongside the invite.
      expect(await eventsByKey(test, "account.welcome")).toHaveLength(1);
    });
  });

  it("I7: a new profile has marketingOptIn false", async () => {
    await withTestDb(async (test) => {
      const userId = new ObjectId();

      await handleUserCreated(
        { userId: userId.toHexString(), email: "marketing-opt-out@example.com" },
        { db: test.db, clock: fixedClock(T0) }
      );

      const profile = await test.db.collection(USER_PROFILES_COLLECTION).findOne({ userId });
      expect(profile?.marketingOptIn).toBe(false);
    });
  });
});

describe("handleContactVerified — account completion", () => {
  it("I3: verifying email then phone sets accountCompletedAt and emits completed exactly once", async () => {
    await withTestDb(async (test) => {
      const userId = new ObjectId();
      await insertAuthUser(test, userId, { emailVerified: true, phoneNumberVerified: false });
      await insertProfile(test, userId, { accountCompletedAt: null });

      // Email verified, phone not yet: the account is not complete and no
      // completion event may fire.
      await handleContactVerified({ userId: userId.toHexString() } satisfies ContactVerifiedEvent, {
        db: test.db,
        clock: fixedClock(T0),
      });
      let profile = await test.db.collection(USER_PROFILES_COLLECTION).findOne({ userId });
      expect(profile?.accountCompletedAt).toBeNull();
      expect(await eventsByKey(test, "auth.account.completed")).toHaveLength(0);

      // Phone now verified: completion fires once.
      await test.db
        .collection(USER_COLLECTION)
        .updateOne({ _id: userId }, { $set: { phoneNumberVerified: true } });
      await handleContactVerified(
        { userId: userId.toHexString() },
        {
          db: test.db,
          clock: fixedClock(T0),
        }
      );

      profile = await test.db.collection(USER_PROFILES_COLLECTION).findOne({ userId });
      expect(profile?.accountCompletedAt).toEqual(T0);
      const completed = await eventsByKey(test, "auth.account.completed");
      expect(completed).toHaveLength(1);

      // Re-verifying must not re-emit or move the completion instant.
      await handleContactVerified(
        { userId: userId.toHexString() },
        {
          db: test.db,
          clock: fixedClock(new Date(T0.getTime() + 3_600_000)),
        }
      );

      const after = await eventsByKey(test, "auth.account.completed");
      expect(after).toHaveLength(1);
      const reread = await test.db.collection(USER_PROFILES_COLLECTION).findOne({ userId });
      expect(reread?.accountCompletedAt).toEqual(T0);
    });
  });
});

describe("handleSessionCreated — new device and admin sign-in", () => {
  it("I4: a second login from the same device within 24h emits only one new_device event", async () => {
    await withTestDb(async (test) => {
      const userId = new ObjectId();
      await insertAuthUser(test, userId);
      await insertProfile(test, userId, { platformRole: "client" });

      const device = {
        userAgent: "Mozilla/5.0 (TestBrowser)",
        ip: "203.0.113.42",
        acceptLanguage: "en-IN,en;q=0.9",
      };
      const base: SessionCreatedEvent = {
        userId: userId.toHexString(),
        sessionId: "session-one",
        device,
      };

      await handleSessionCreated(base, { db: test.db, clock: fixedClock(T0) });
      await handleSessionCreated(
        { ...base, sessionId: "session-two" },
        { db: test.db, clock: fixedClock(new Date(T0.getTime() + 60_000)) }
      );

      const sameDay = await eventsByKey(test, "auth.signin.new_device");
      expect(sameDay).toHaveLength(1);

      // The raw fingerprint parts never reach the outbox payload; a hashed
      // device reference does.
      const expectedHash = hashFingerprint(device, getRateLimitConfig().salt);
      const stored = sameDay[0] as unknown as StoredEvent;
      expect(stored.payload.deviceHash).toBe(expectedHash);
      expect(JSON.stringify(stored.payload)).not.toContain("203.0.113.42");
      expect(JSON.stringify(stored.payload)).not.toContain("TestBrowser");

      // Past the 24h window the same device counts as a fresh sighting again.
      expect(NEW_DEVICE_WINDOW_MS).toBe(NEW_DEVICE_WINDOW);
      await handleSessionCreated(
        { ...base, sessionId: "session-three" },
        {
          db: test.db,
          clock: fixedClock(new Date(T0.getTime() + NEW_DEVICE_WINDOW + 3_600_000)),
        }
      );
      expect(await eventsByKey(test, "auth.signin.new_device")).toHaveLength(2);
    });
  });

  it("I5: an admin login emits auth.admin.signin", async () => {
    await withTestDb(async (test) => {
      const userId = new ObjectId();
      await insertAuthUser(test, userId);
      await insertProfile(test, userId, { platformRole: "admin" });

      await handleSessionCreated(
        {
          userId: userId.toHexString(),
          sessionId: "admin-session-one",
          device: { userAgent: "Mozilla/5.0 (AdminConsole)", ip: "203.0.113.99" },
        },
        { db: test.db, clock: fixedClock(T0) }
      );

      const adminEvents = await eventsByKey(test, "auth.admin.signin");
      expect(adminEvents).toHaveLength(1);
      expect(adminEvents[0]?.subjectRef).toEqual({
        kind: "user",
        id: userId.toHexString(),
      });
    });
  });

  it("I6: an emit failure inside a hook logs an error and sign-in still succeeds", async () => {
    await withTestDb(async (test) => {
      const sink = installMemoryLogger();
      const auth: AuthLike = createAuth({
        db: test.db,
        // The outbox is down for the whole request: every lifecycle event the
        // hooks try to emit rejects.
        emit: () => Promise.reject(new Error("outbox unavailable")),
      });
      const email = `op89-emit-failure-${uniqueSuffix()}@example.com`;
      const ip = `192.0.2.${String((Date.now() % 200) + 10)}`;

      const sent = await authPost(
        auth,
        "http://localhost:3000",
        "/api/auth/email-otp/send-verification-otp",
        { email, type: "sign-in" },
        { "x-forwarded-for": ip }
      );
      expect(sent.status).toBe(200);
      const otp = otpInbox.take("email", email) as { code: string } | undefined;
      if (otp === undefined) {
        throw new Error("expected an email OTP to be captured");
      }

      // A broken outbox must not turn a successful sign-in into a 5xx.
      const signedIn = await authPost(
        auth,
        "http://localhost:3000",
        "/api/auth/sign-in/email-otp",
        { email, otp: otp.code },
        { "x-forwarded-for": ip }
      );
      expect(signedIn.status).toBe(200);
      expect(sessionCookie(signedIn)).toBeDefined();

      const error = sink.entries.find((entry) => entry.event === "identity_hook.emit_failed");
      expect(error).toBeDefined();
      expect(error?.level).toBe("error");
    });
  });
});

/** A `Set-Cookie` header carrying every cookie the response set. */
function cookieHeader(response: Response): string {
  return setCookies(response).map(cookiePair).join("; ");
}

describe("identity hooks are wired into the configured auth surface", () => {
  it("E1: signing in with an email OTP runs the user-created hook", async () => {
    await withTestDb(async (test) => {
      const auth = createAuth({ db: test.db });
      const email = `op89-wiring-${uniqueSuffix()}@example.com`;
      const ip = `198.51.100.${String((Date.now() % 200) + 10)}`;

      const sent = await authPost(
        auth,
        "http://localhost:3000",
        "/api/auth/email-otp/send-verification-otp",
        { email, type: "sign-in" },
        { "x-forwarded-for": ip }
      );
      expect(sent.status).toBe(200);
      const otp = otpInbox.take("email", email) as { code: string } | undefined;
      if (otp === undefined) {
        throw new Error("expected an email OTP to be captured");
      }

      const signedIn = await authPost(
        auth,
        "http://localhost:3000",
        "/api/auth/sign-in/email-otp",
        { email, otp: otp.code },
        { "x-forwarded-for": ip }
      );
      expect(signedIn.status).toBe(200);
      const cookie = sessionCookie(signedIn);
      if (cookie === undefined) {
        throw new Error("sign-in did not set a session cookie");
      }
      expect(cookieHeader(signedIn)).toContain(cookiePair(cookie));

      expect(await test.db.collection(USER_PROFILES_COLLECTION).countDocuments({})).toBe(1);
      expect(await test.db.collection(NOTIFICATION_PREFERENCES_COLLECTION).countDocuments({})).toBe(
        1
      );
      expect(await eventsByKey(test, "account.welcome")).toHaveLength(1);
    });
  });
});
