import { ObjectId, type Db } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAuth, type AuthLike } from "@/server/auth";
import { NEW_DEVICE_WINDOW_MS, hashFingerprint } from "@/server/auth/device-fingerprint";
import {
  handleContactChanged,
  handleContactVerified,
  handleSessionsRevoked,
  handleSessionCreated,
  handleTwoFactorToggled,
  handleUserCreated,
} from "@/server/auth/identity-hooks";
import * as identityLifecycle from "@/server/auth/identity-lifecycle";
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
/**
 * The transient fan-out record for `auth.contact.changed` (ADR-0040 §3).
 *
 * The append-only outbox may not carry contact values, but a security alert
 * must reach the contact that was just replaced, so the raw old/new contacts
 * live in this short-lived collection (a `contactChangeFanouts` doc) that the
 * notification fan-out reads once. It is not a domain-event payload.
 */
const CONTACT_CHANGE_FANOUTS_COLLECTION = "contactChangeFanouts";

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
  readonly _id: ObjectId;
  readonly eventKey: string;
  readonly subjectRef: { readonly kind: string; readonly id: string };
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
  readonly dedupeKey?: string;
}

/** One side of a contact change — a resolvable email and/or phone number. */
interface ContactRef {
  readonly email?: string | null;
  readonly phoneNumber?: string | null;
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
  /**
   * The raw, unclaimed `op_att` cookie value when the session-created request
   * carried one (contract §1.5). The session-created handler hands it to the
   * attendee-session claim seam without blocking the sign-in.
   */
  readonly attendeeSessionToken?: string | null;
}

/**
 * `handleContactChanged` input — the contact that was replaced and the one that
 * replaced it. The previous contact is *input* because it is gone from the
 * stored user once the change commits.
 */
interface ContactChangedEvent {
  readonly userId: string;
  readonly previous: ContactRef;
  readonly current: ContactRef;
}

/** `handleTwoFactorToggled` input — the resulting 2FA state. */
interface TwoFactorToggledEvent {
  readonly userId: string;
  readonly enabled: boolean;
}

/** `handleSessionsRevoked` input — the user whose sessions were all revoked. */
interface SessionsRevokedEvent {
  readonly userId: string;
  readonly sessionIds?: readonly string[];
}

/** The transient `auth.contact.changed` fan-out record (ADR-0040 §3). */
interface ContactChangeFanout {
  readonly eventId: string;
  readonly userId: string;
  readonly previous: ContactRef;
  readonly current: ContactRef;
  readonly expireAt: Date;
}

/** The injected attendee-session claim seam the session-created hook calls. */
type ClaimAttendeeSession = (input: { userId: string; token: string }) => Promise<unknown>;

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

describe("handleContactChanged — fanned out to the old and the new contact", () => {
  it("S4: an email change emits one auth.contact.changed row whose payload carries flags only", async () => {
    await withTestDb(async (test) => {
      const userId = new ObjectId();
      const previousEmail = `old-${userId.toHexString()}@example.com`;
      const currentEmail = `new-${userId.toHexString()}@example.com`;

      await handleContactChanged(
        {
          userId: userId.toHexString(),
          previous: { email: previousEmail, phoneNumber: null },
          current: { email: currentEmail, phoneNumber: null },
        } satisfies ContactChangedEvent,
        { db: test.db, clock: fixedClock(T0) }
      );

      const changed = await eventsByKey(test, "auth.contact.changed");
      expect(changed).toHaveLength(1);

      // The payload carries change flags and nothing else: neither the previous
      // nor the new raw contact may reach the append-only outbox (ADR-0040 §3).
      const payload = changed[0]?.payload ?? {};
      expect(payload).toEqual({ emailChanged: true, phoneChanged: false });
      expect(JSON.stringify(payload)).not.toContain(previousEmail);
      expect(JSON.stringify(payload)).not.toContain(currentEmail);
    });
  });

  it("S4: the transient fan-out record references both the old and the new contact", async () => {
    await withTestDb(async (test) => {
      const userId = new ObjectId();
      const previousEmail = `old-${userId.toHexString()}@example.com`;
      const currentEmail = `new-${userId.toHexString()}@example.com`;

      await handleContactChanged(
        {
          userId: userId.toHexString(),
          previous: { email: previousEmail },
          current: { email: currentEmail },
        },
        { db: test.db, clock: fixedClock(T0) }
      );

      const changed = await eventsByKey(test, "auth.contact.changed");
      expect(changed).toHaveLength(1);

      const fanouts = await test.db
        .collection<ContactChangeFanout>(CONTACT_CHANGE_FANOUTS_COLLECTION)
        .find({})
        .toArray();
      expect(fanouts).toHaveLength(1);

      const fanout = fanouts[0];
      expect(fanout?.userId).toBe(userId.toHexString());
      // The record is resolvable back to the event the fan-out consumer claims.
      expect(fanout?.eventId).toBe(String(changed[0]?._id));
      // Both recipients: a hijacker must not be able to silently lock the owner
      // out of the old address, so the old contact is a fan-out target too.
      expect(fanout?.previous.email).toBe(previousEmail);
      expect(fanout?.current.email).toBe(currentEmail);
      expect(fanout?.expireAt).toBeInstanceOf(Date);
    });
  });

  it("S4: a phone change sets the phone flag and fans out to both numbers", async () => {
    await withTestDb(async (test) => {
      const userId = new ObjectId();
      const previousPhone = "+919000000001";
      const currentPhone = "+919000000002";

      await handleContactChanged(
        {
          userId: userId.toHexString(),
          previous: { phoneNumber: previousPhone },
          current: { phoneNumber: currentPhone },
        },
        { db: test.db, clock: fixedClock(T0) }
      );

      const changed = await eventsByKey(test, "auth.contact.changed");
      expect(changed).toHaveLength(1);
      expect(changed[0]?.payload).toEqual({ emailChanged: false, phoneChanged: true });
      expect(JSON.stringify(changed[0]?.payload)).not.toContain(previousPhone);

      const fanout = await test.db
        .collection<ContactChangeFanout>(CONTACT_CHANGE_FANOUTS_COLLECTION)
        .findOne({});
      expect(fanout?.previous.phoneNumber).toBe(previousPhone);
      expect(fanout?.current.phoneNumber).toBe(currentPhone);
    });
  });
});

describe("handleTwoFactorToggled — enabled and disabled are distinct security events", () => {
  it("S5: enabling 2FA emits auth.2fa.enabled and not auth.2fa.disabled", async () => {
    await withTestDb(async (test) => {
      const userId = new ObjectId();

      await handleTwoFactorToggled(
        { userId: userId.toHexString(), enabled: true } satisfies TwoFactorToggledEvent,
        { db: test.db, clock: fixedClock(T0) }
      );

      const enabled = await eventsByKey(test, "auth.2fa.enabled");
      expect(enabled).toHaveLength(1);
      expect(enabled[0]?.subjectRef).toEqual({ kind: "user", id: userId.toHexString() });
      expect(await eventsByKey(test, "auth.2fa.disabled")).toHaveLength(0);
    });
  });

  it("S5: disabling 2FA emits auth.2fa.disabled and not auth.2fa.enabled", async () => {
    await withTestDb(async (test) => {
      const userId = new ObjectId();

      await handleTwoFactorToggled(
        { userId: userId.toHexString(), enabled: false },
        { db: test.db, clock: fixedClock(T0) }
      );

      const disabled = await eventsByKey(test, "auth.2fa.disabled");
      expect(disabled).toHaveLength(1);
      expect(disabled[0]?.subjectRef).toEqual({ kind: "user", id: userId.toHexString() });
      expect(await eventsByKey(test, "auth.2fa.enabled")).toHaveLength(0);
    });
  });

  it("S5: re-running the same toggle dedupes to a single event", async () => {
    await withTestDb(async (test) => {
      const userId = new ObjectId();
      const event: TwoFactorToggledEvent = { userId: userId.toHexString(), enabled: true };

      await handleTwoFactorToggled(event, { db: test.db, clock: fixedClock(T0) });
      await handleTwoFactorToggled(event, { db: test.db, clock: fixedClock(T0) });

      expect(await eventsByKey(test, "auth.2fa.enabled")).toHaveLength(1);
    });
  });
});

describe("handleSessionsRevoked — revocation notice", () => {
  it("S6: revoking all sessions emits one account.sessions.revoked event", async () => {
    await withTestDb(async (test) => {
      const userId = new ObjectId();

      await handleSessionsRevoked(
        {
          userId: userId.toHexString(),
          sessionIds: ["session-a", "session-b"],
        } satisfies SessionsRevokedEvent,
        { db: test.db, clock: fixedClock(T0) }
      );

      const revoked = await eventsByKey(test, "account.sessions.revoked");
      expect(revoked).toHaveLength(1);
      expect(revoked[0]?.subjectRef).toEqual({ kind: "user", id: userId.toHexString() });
    });
  });
});

describe("handleSessionCreated — unclaimed op_att claim service", () => {
  it("S7: an unclaimed op_att token invokes the claim seam with that token", async () => {
    await withTestDb(async (test) => {
      const userId = new ObjectId();
      await insertAuthUser(test, userId);
      await insertProfile(test, userId);

      const claims: { userId: string; token: string }[] = [];
      const claim: ClaimAttendeeSession = (input) => {
        claims.push(input);
        return Promise.resolve();
      };

      await handleSessionCreated(
        {
          userId: userId.toHexString(),
          sessionId: "session-claim",
          device: {},
          attendeeSessionToken: "opat_9f2c",
        },
        { db: test.db, clock: fixedClock(T0), claim }
      );

      expect(claims).toEqual([{ userId: userId.toHexString(), token: "opat_9f2c" }]);
    });
  });

  it("S7: no unclaimed op_att token means the claim seam is never invoked", async () => {
    await withTestDb(async (test) => {
      const userId = new ObjectId();
      await insertAuthUser(test, userId);
      await insertProfile(test, userId);

      let claimCalls = 0;
      await handleSessionCreated(
        {
          userId: userId.toHexString(),
          sessionId: "session-no-claim",
          device: {},
          attendeeSessionToken: null,
        },
        {
          db: test.db,
          clock: fixedClock(T0),
          claim: () => {
            claimCalls += 1;
            return Promise.resolve();
          },
        }
      );

      expect(claimCalls).toBe(0);
    });
  });

  it("S7: a rejected claim does not fail the hook and logs identity_hook.claim_failed", async () => {
    await withTestDb(async (test) => {
      const sink = installMemoryLogger();
      const userId = new ObjectId();
      await insertAuthUser(test, userId);
      await insertProfile(test, userId);

      let claimCalls = 0;
      // The claim service being down must never turn a successful sign-in into a
      // failure: the handler swallows the rejection and records it.
      await expect(
        handleSessionCreated(
          {
            userId: userId.toHexString(),
            sessionId: "session-claim-rejected",
            device: {},
            attendeeSessionToken: "opat_reject",
          },
          {
            db: test.db,
            clock: fixedClock(T0),
            claim: () => {
              claimCalls += 1;
              return Promise.reject(new Error("claim service unavailable"));
            },
          }
        )
      ).resolves.toBeUndefined();

      expect(claimCalls).toBe(1);
      const failure = sink.entries.find((entry) => entry.event === "identity_hook.claim_failed");
      expect(failure).toBeDefined();
      expect(failure?.level).toBe("error");
    });
  });

  it("S7: a sign-in carrying an unclaimed op_att cookie invokes the injected claim seam", async () => {
    await withTestDb(async (test) => {
      const claims: { userId: string; token: string }[] = [];
      const auth: AuthLike = createAuth({
        db: test.db,
        emit: () => Promise.resolve({ deduped: false, id: null }),
        claim: (input: { userId: string; token: string }) => {
          claims.push(input);
          return Promise.resolve();
        },
      });
      const email = `op89-claim-${uniqueSuffix()}@example.com`;
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

      const signedIn = await authPost(
        auth,
        "http://localhost:3000",
        "/api/auth/sign-in/email-otp",
        { email, otp: otp.code },
        { "x-forwarded-for": ip, cookie: "op_att=opat_cookie_9f2c" }
      );
      expect(signedIn.status).toBe(200);
      expect(sessionCookie(signedIn)).toBeDefined();

      expect(claims).toHaveLength(1);
      expect(claims[0]).toMatchObject({ token: "opat_cookie_9f2c" });
      expect(typeof claims[0]?.userId).toBe("string");
    });
  });

  it("S7: a rejected claim through the auth surface still signs the user in", async () => {
    await withTestDb(async (test) => {
      const auth: AuthLike = createAuth({
        db: test.db,
        emit: () => Promise.resolve({ deduped: false, id: null }),
        claim: () => Promise.reject(new Error("claim service unavailable")),
      });
      const email = `op89-claim-fail-${uniqueSuffix()}@example.com`;
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
        { "x-forwarded-for": ip, cookie: "op_att=opat_cookie_rejected" }
      );
      expect(signedIn.status).toBe(200);
      expect(sessionCookie(signedIn)).toBeDefined();
    });
  });
});

/* ------------------------------------------------------------------------- *
 * OP-89 follow-up RED pins (ADR-0045) — append-only extension.
 *
 * These pin the two MEDIUM findings of the OP-89 GREEN review (ADR-0042 §4-5)
 * and the LOW 2FA transition finding (ADR-0042 §6):
 *
 *   - re-run idempotency for `handleContactChanged` / `handleSessionsRevoked`
 *     (currently no `dedupeKey`, so a redelivery emits a second row);
 *   - the 2FA enable -> disable -> enable re-emit;
 *   - the section 4-6 + contact-verified *surface* adapters: the Better Auth
 *     `user.update.after` adapter for contact-verified, and the injectable
 *     endpoint seam (`createIdentityLifecycleSeams`) the section 4-6 cards call.
 * ------------------------------------------------------------------------- */

/** The endpoint-facing seam the section 4-6 cards call after their own write. */
interface LifecycleSeams {
  contactChanged(event: ContactChangedEvent): Promise<void>;
  twoFactorToggled(event: TwoFactorToggledEvent): Promise<void>;
  sessionsRevoked(event: SessionsRevokedEvent): Promise<void>;
}

/** The wiring `createIdentityLifecycleSeams` accepts (a subset of the handler deps). */
interface LifecycleSeamWiring {
  readonly db: Db;
  readonly clock?: { now(): Date };
  readonly emit?: (
    input: unknown,
    options?: unknown
  ) => Promise<{ deduped: boolean; id: string | null }>;
}

/**
 * The not-yet-implemented factory, read through the module namespace so a
 * missing export fails each spec with "expected 'function', received
 * 'undefined'" rather than an import-time module-resolution error.
 */
const lifecycleModule = identityLifecycle as unknown as {
  readonly createIdentityLifecycleSeams?: (wiring: LifecycleSeamWiring) => LifecycleSeams;
};

/** Build the endpoint-facing seam; asserts the export exists first. */
function createSeams(wiring: LifecycleSeamWiring): LifecycleSeams {
  const factory = lifecycleModule.createIdentityLifecycleSeams;
  expect(typeof factory).toBe("function");
  if (factory === undefined) {
    throw new Error("createIdentityLifecycleSeams is not implemented");
  }
  return factory(wiring);
}

describe("re-run idempotency — a redelivered hook emits exactly once (card AC)", () => {
  it("I8: invoking handleContactChanged twice with identical input emits one auth.contact.changed row", async () => {
    await withTestDb(async (test) => {
      const userId = new ObjectId();
      const clock = fixedClock(T0);
      const event: ContactChangedEvent = {
        userId: userId.toHexString(),
        previous: { email: `old-${userId.toHexString()}@example.com` },
        current: { email: `new-${userId.toHexString()}@example.com` },
      };

      await handleContactChanged(event, { db: test.db, clock });
      await handleContactChanged(event, { db: test.db, clock });

      expect(await eventsByKey(test, "auth.contact.changed")).toHaveLength(1);
    });
  });

  it("I8: invoking handleContactChanged twice with identical input leaves one contactChangeFanouts row", async () => {
    await withTestDb(async (test) => {
      const userId = new ObjectId();
      const clock = fixedClock(T0);
      const event: ContactChangedEvent = {
        userId: userId.toHexString(),
        previous: { email: `old-${userId.toHexString()}@example.com` },
        current: { email: `new-${userId.toHexString()}@example.com` },
      };

      await handleContactChanged(event, { db: test.db, clock });
      await handleContactChanged(event, { db: test.db, clock });

      const fanouts = await test.db
        .collection(CONTACT_CHANGE_FANOUTS_COLLECTION)
        .countDocuments({});
      expect(fanouts).toBe(1);
    });
  });

  it("I9: invoking handleSessionsRevoked twice with identical input emits one account.sessions.revoked row", async () => {
    await withTestDb(async (test) => {
      const userId = new ObjectId();
      const clock = fixedClock(T0);
      const event: SessionsRevokedEvent = {
        userId: userId.toHexString(),
        sessionIds: ["session-a", "session-b"],
      };

      await handleSessionsRevoked(event, { db: test.db, clock });
      await handleSessionsRevoked(event, { db: test.db, clock });

      expect(await eventsByKey(test, "account.sessions.revoked")).toHaveLength(1);
    });
  });
});

describe("section 4-6 surface seam — createIdentityLifecycleSeams (ADR-0043 §3)", () => {
  it("S8: the contact-changed seam emits the flags event and records one fanout", async () => {
    await withTestDb(async (test) => {
      const userId = new ObjectId();
      const seams = createSeams({ db: test.db, clock: fixedClock(T0) });

      await seams.contactChanged({
        userId: userId.toHexString(),
        previous: { email: `old-${userId.toHexString()}@example.com` },
        current: { email: `new-${userId.toHexString()}@example.com` },
      });

      expect(await eventsByKey(test, "auth.contact.changed")).toHaveLength(1);
      expect(await test.db.collection(CONTACT_CHANGE_FANOUTS_COLLECTION).countDocuments({})).toBe(
        1
      );
    });
  });

  it("S8: the contact-changed seam surfaces a genuinely different change as a second row", async () => {
    await withTestDb(async (test) => {
      const userId = new ObjectId();
      const id = userId.toHexString();

      await createSeams({ db: test.db, clock: fixedClock(T0) }).contactChanged({
        userId: id,
        previous: { email: "first@example.com" },
        current: { email: "second@example.com" },
      });
      await createSeams({
        db: test.db,
        clock: fixedClock(new Date(T0.getTime() + 3_600_000)),
      }).contactChanged({
        userId: id,
        previous: { email: "second@example.com" },
        current: { email: "third@example.com" },
      });

      expect(await eventsByKey(test, "auth.contact.changed")).toHaveLength(2);
    });
  });

  it("S8: a broken outbox through the contact-changed seam does not throw and logs", async () => {
    await withTestDb(async (test) => {
      const sink = installMemoryLogger();
      const userId = new ObjectId();
      const seams = createSeams({
        db: test.db,
        clock: fixedClock(T0),
        emit: () => Promise.reject(new Error("outbox unavailable")),
      });

      await expect(
        seams.contactChanged({
          userId: userId.toHexString(),
          previous: { email: "old@example.com" },
          current: { email: "new@example.com" },
        })
      ).resolves.toBeUndefined();

      const failure = sink.entries.find((entry) => entry.event === "identity_hook.emit_failed");
      expect(failure).toBeDefined();
      expect(failure?.level).toBe("error");
    });
  });

  it("S10: the 2FA toggle seam re-emits across enable, disable and enable", async () => {
    await withTestDb(async (test) => {
      const userId = new ObjectId();
      const id = userId.toHexString();
      const at = (offsetMs: number) =>
        createSeams({ db: test.db, clock: fixedClock(new Date(T0.getTime() + offsetMs)) });

      await at(0).twoFactorToggled({ userId: id, enabled: true });
      await at(3_600_000).twoFactorToggled({ userId: id, enabled: false });
      await at(7_200_000).twoFactorToggled({ userId: id, enabled: true });

      expect(await eventsByKey(test, "auth.2fa.enabled")).toHaveLength(2);
      expect(await eventsByKey(test, "auth.2fa.disabled")).toHaveLength(1);
    });
  });

  it("S9: the sessions-revoked seam emits one account.sessions.revoked row", async () => {
    await withTestDb(async (test) => {
      const userId = new ObjectId();
      const seams = createSeams({ db: test.db, clock: fixedClock(T0) });

      await seams.sessionsRevoked({
        userId: userId.toHexString(),
        sessionIds: ["session-a", "session-b"],
      });

      const revoked = await eventsByKey(test, "account.sessions.revoked");
      expect(revoked).toHaveLength(1);
      expect(revoked[0]?.subjectRef).toEqual({ kind: "user", id: userId.toHexString() });
    });
  });
});

describe("section 2 surface — the contact-verified Better Auth adapter (ADR-0043 §3)", () => {
  it("S11: user.update.after completes the account and emits auth.account.completed once", async () => {
    await withTestDb(async (test) => {
      const userId = new ObjectId();
      await insertAuthUser(test, userId, { emailVerified: true, phoneNumberVerified: true });
      await insertProfile(test, userId, { accountCompletedAt: null });

      const hooks = identityLifecycle.createIdentityDatabaseHooks({
        db: test.db,
        clock: fixedClock(T0),
      });
      const after = hooks.user?.update?.after as unknown as
        ((user: Record<string, unknown>, context: unknown) => Promise<void>) | undefined;
      expect(typeof after).toBe("function");

      await after?.({ id: userId.toHexString() }, null);

      const profile = await test.db.collection(USER_PROFILES_COLLECTION).findOne({ userId });
      expect(profile?.accountCompletedAt).toEqual(T0);
      expect(await eventsByKey(test, "auth.account.completed")).toHaveLength(1);
    });
  });
});

/* ------------------------------------------------------------------------- *
 * OP-89 follow-up GREEN coverage pin (ADR-0045 §1) — append-only extension.
 *
 * `handleContactChanged` performs two writes that are **not atomic**: it
 * emits `auth.contact.changed` and then inserts the transient
 * `contactChangeFanouts` row the security alert reads. The emit is deduped on
 * `auth.contact.changed:${userId}:${instant}`, and the handler returns
 * *before* the fan-out insert whenever that emit dedupes (`emitted.id ===
 * null`). So when the emit commits but the fan-out insert fails, an
 * at-least-once redelivery at the same instant finds the emit already deduped,
 * short-circuits, and never re-runs the insert — the security alert's target
 * for the replaced contact is permanently lost.
 *
 * This spec pins the honest outcome: a redelivery after that partial failure
 * must not silently leave zero fan-out rows. It is RED against the current
 * handler (count 0), which is the defect the pin exists to expose.
 * ------------------------------------------------------------------------- */

/**
 * A `Db` whose first `contactChangeFanouts.insertOne` rejects.
 *
 * Wraps `base` so only that single write fails: the outbox emit and every
 * other collection pass through the real driver. This models the partial
 * failure `handleContactChanged` is exposed to — the emit has committed but
 * the fan-out insert has not.
 */
function contactFanoutInsertFailingDb(base: Db): Db {
  let failNextFanoutInsert = true;
  return new Proxy(base, {
    get(target, property, receiver): unknown {
      if (property !== "collection") {
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (name: string): unknown => {
        const collection = target.collection(name);
        if (name !== CONTACT_CHANGE_FANOUTS_COLLECTION) {
          return collection;
        }
        return new Proxy(collection, {
          get(fanoutTarget, fanoutProperty): unknown {
            if (fanoutProperty === "insertOne" && failNextFanoutInsert) {
              failNextFanoutInsert = false;
              return () => Promise.reject(new Error("contactChangeFanouts insert unavailable"));
            }
            const value: unknown = Reflect.get(fanoutTarget, fanoutProperty);
            return typeof value === "function"
              ? (value as (...args: unknown[]) => unknown).bind(fanoutTarget)
              : value;
          },
        });
      };
    },
  });
}

describe("handleContactChanged — the fan-out survives a partial failure (ADR-0045 §1)", () => {
  it("I10: a retry after a failed fan-out insert still records one fan-out row for the alert", async () => {
    await withTestDb(async (test) => {
      const userId = new ObjectId();
      const clock = fixedClock(T0);
      const event: ContactChangedEvent = {
        userId: userId.toHexString(),
        previous: { email: `old-${userId.toHexString()}@example.com` },
        current: { email: `new-${userId.toHexString()}@example.com` },
      };

      // Healthy outbox (the real emit) behind a db whose first
      // `contactChangeFanouts.insertOne` rejects: the emit commits, the
      // fan-out insert does not. The handler may throw here; the partial
      // failure itself is not the defect — losing the fan-out is.
      await handleContactChanged(event, { db: contactFanoutInsertFailingDb(test.db), clock }).catch(
        () => undefined
      );

      // At-least-once delivery redelivers the same change at the same instant.
      await handleContactChanged(event, { db: test.db, clock });

      // The emit dedupe held: exactly one event row.
      expect(await eventsByKey(test, "auth.contact.changed")).toHaveLength(1);

      // The security alert must not lose its target. Whatever the handler does
      // with the deduped emit, the redelivery has to leave a usable fan-out
      // record behind — not silently return with zero rows.
      const fanouts = await test.db
        .collection<ContactChangeFanout>(CONTACT_CHANGE_FANOUTS_COLLECTION)
        .find({})
        .toArray();
      expect(fanouts).toHaveLength(1);
      expect(fanouts[0]?.userId).toBe(userId.toHexString());
      expect(fanouts[0]?.previous.email).toBe(event.previous.email);
      expect(fanouts[0]?.current.email).toBe(event.current.email);
    });
  });
});
