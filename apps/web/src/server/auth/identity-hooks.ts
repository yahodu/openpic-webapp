import type { Db, Document } from "mongodb";
import { ObjectId } from "mongodb";

import { getRateLimitConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import {
  emitDomainEvent,
  type DomainEventInput,
  type EmitDomainEventOptions,
  type EmitDomainEventResult,
} from "@/server/domain/domain-events";
import { getLogger } from "@/server/logging";
import { platformRepo } from "@/server/repos";
import { systemClock, type Clock } from "@/server/runtime/clock";
import { addMilliseconds } from "@/server/runtime/time";

import {
  hashFingerprint,
  isNewDevice,
  NEW_DEVICE_WINDOW_MS,
  type PriorDeviceSighting,
} from "./device-fingerprint";
import { parseLocale } from "./locale";

/**
 * Better Auth identity lifecycle hooks — the policy handlers (OP-89, contract
 * §1.1 "hook table", §7.7 domain events; ADR-0038, ADR-0040).
 *
 * Better Auth's `after`/database hooks adapt their context into the plain-input
 * events these handlers accept, so the policy is testable without the library:
 *
 *   user created     → `userProfiles` + `notificationPreferences` defaults,
 *                      `account.welcome`, and lazy-invite resolution;
 *   contact verified → `accountCompletedAt` once, then
 *                      `auth.account.completed` once;
 *   session created  → `auth.signin.new_device` (1/device/24h),
 *                      `auth.admin.signin` for admins, and the non-blocking
 *                      unclaimed `op_att` claim;
 *   contact changed  → `auth.contact.changed` (flags only) plus the transient
 *                      `contactChangeFanouts` record holding both contacts;
 *   2FA toggled      → `auth.2fa.enabled` / `auth.2fa.disabled`;
 *   sessions revoked → `account.sessions.revoked`.
 *
 * Every handler is **idempotent** and **never throws on a notification
 * failure**: a broken outbox logs `identity_hook.emit_failed` at error level and
 * the auth request still succeeds. Raw contacts and fingerprint parts never
 * reach a domain-event payload (the append-only outbox has a 180-day TTL).
 *
 * The stored auth collections are Better Auth-owned (`user`, `session`) and the
 * outbox is `domain_events`. The app-owned collections are registered in
 * `COLLECTIONS` (schema §13.2, §19.3, §13.6) so their indexes can be declared in
 * `INDEX_SPECS` without duplicating the names.
 */

/** The Better Auth-owned user collection (schema §13.1). */
const USER_COLLECTION = "user";
/** App-owned profile, keyed 1:1 by `userId` (schema §13.2). */
export const USER_PROFILES_COLLECTION = COLLECTIONS.userProfiles;
/** App-owned notification preferences, keyed 1:1 by `userId` (schema §19.3). */
export const NOTIFICATION_PREFERENCES_COLLECTION = COLLECTIONS.notificationPreferences;
/** Unified invitations collection (schema §13.6). */
export const INVITATIONS_COLLECTION = COLLECTIONS.invitations;
/** Per-session device sightings backing the 24-hour new-device decision. */
export const SESSION_DEVICES_COLLECTION = COLLECTIONS.sessionDevices;
/** Transient `auth.contact.changed` fan-out records (ADR-0040 §2). */
export const CONTACT_CHANGE_FANOUTS_COLLECTION = COLLECTIONS.contactChangeFanouts;

/** How long a transient contact-change fan-out record is kept, in ms. */
const CONTACT_CHANGE_FANOUT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a device sighting is retained, in ms.
 *
 * Comfortably longer than {@link NEW_DEVICE_WINDOW_MS} so a sighting is never
 * reaped while it can still suppress a duplicate `auth.signin.new_device`; the
 * TTL index (`session_devices_expire_at_ttl`) then keeps the collection bounded
 * for the long tail of inactive users (ADR-0043).
 */
const SESSION_DEVICE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many recent sightings of the incoming device the new-device read considers,
 * newest-first.
 *
 * The decision only needs the newest in-window sighting of the incoming
 * fingerprint, so the read is keyed on `{ userId, fingerprintHash }` and bounded
 * (ADR-0050): keying it on the device keeps an in-window match from being dropped
 * by the cap, and the cap keeps the read indexed and bounded on the sign-in path
 * (ADR-0043 §2).
 */
const SESSION_DEVICE_READ_LIMIT = 100;

/** The default time zone when the client supplies no hint (contract §1.1). */
const DEFAULT_TIME_ZONE = "Asia/Kolkata";

/** The event key of a successful first account creation. */
const ACCOUNT_WELCOME_EVENT = "account.welcome";

/** Where the outbox door is injected, mirroring `emitDomainEvent`'s own seam. */
export type EmitDomainEvent = (
  input: DomainEventInput,
  options?: EmitDomainEventOptions
) => Promise<EmitDomainEventResult>;

/**
 * The attendee-session claim service the session-created hook may invoke.
 *
 * Contract §6.7's full `POST /me/attendee-sessions:claim` endpoint is out of
 * OP-89 scope; this seam exists so the hook can be wired to the real service
 * once it lands (ADR-0040 §5).
 */
export type ClaimAttendeeSession = (input: { userId: string; token: string }) => Promise<unknown>;

/** Inputs to the user-created handler. */
export interface UserCreatedEvent {
  /** Better Auth user id, as a hex string. */
  readonly userId: string;
  readonly email: string;
  readonly phoneNumber?: string | null;
  readonly acceptLanguage?: string | null;
  readonly timeZone?: string | null;
}

/** Inputs to the contact-verified handler. */
export interface ContactVerifiedEvent {
  readonly userId: string;
}

/** Inputs to the session-created handler. */
export interface SessionCreatedEvent {
  readonly userId: string;
  readonly sessionId: string;
  readonly device: {
    readonly userAgent?: string | null;
    readonly ip?: string | null;
    readonly acceptLanguage?: string | null;
  };
  /** The raw, unclaimed `op_att` cookie value, when the request carried one. */
  readonly attendeeSessionToken?: string | null;
}

/** One side of a contact change — a resolvable email and/or phone number. */
export interface ContactRef {
  readonly email?: string | null;
  readonly phoneNumber?: string | null;
}

/** Inputs to the contact-changed handler. */
export interface ContactChangedEvent {
  readonly userId: string;
  readonly previous: ContactRef;
  readonly current: ContactRef;
}

/** Inputs to the 2FA-toggled handler. */
export interface TwoFactorToggledEvent {
  readonly userId: string;
  readonly enabled: boolean;
}

/** Inputs to the sessions-revoked handler. */
export interface SessionsRevokedEvent {
  readonly userId: string;
  readonly sessionIds?: readonly string[];
}

/** Shared seams every handler accepts. */
export interface IdentityHookDeps {
  /** The database the hook reads and writes. */
  readonly db: Db;
  /** The outbox door; defaults to {@link emitDomainEvent}. */
  readonly emit?: EmitDomainEvent;
  /** The clock stamping domain events and windows; defaults to the system clock. */
  readonly clock?: Clock;
  /** The attendee-session claim seam; defaults to a no-op placeholder. */
  readonly claim?: ClaimAttendeeSession;
}

/** A resolved clock and outbox door for one handler invocation. */
interface ResolvedDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly emit: EmitDomainEvent;
  readonly claim: ClaimAttendeeSession;
}

/**
 * The default claim seam.
 *
 * The §6.7 claim service is owned by a later card; until it exists this seam is
 * a no-op so the session-created hook can be wired without blocking a sign-in.
 */
const noopClaim: ClaimAttendeeSession = () => Promise.resolve();

/** Narrow a string to a usable ObjectId, or `null` when it is malformed. */
function toObjectId(value: string): ObjectId | null {
  return ObjectId.isValid(value) ? new ObjectId(value) : null;
}

/** Read a stored id (ObjectId or string) as its hex string form. */
function asHexString(value: unknown): string | null {
  if (value instanceof ObjectId) {
    return value.toHexString();
  }
  return typeof value === "string" ? value : null;
}

/** Read a stored value as a `Date`, or `null`. */
function asDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** The 24-hour bucket index a device sighting falls into. */
function deviceWindowBucket(at: Date): number {
  return Math.floor(at.getTime() / NEW_DEVICE_WINDOW_MS);
}

/** Resolve the injected seams, defaulting the outbox and clock. */
function resolveDeps(deps: IdentityHookDeps): ResolvedDeps {
  return {
    db: deps.db,
    clock: deps.clock ?? systemClock,
    emit: deps.emit ?? emitDomainEvent,
    claim: deps.claim ?? noopClaim,
  };
}

/**
 * Emit one domain event without ever throwing into the auth path.
 *
 * A rejected emit is logged at error level as `identity_hook.emit_failed` and
 * swallowed, so a broken outbox can never fail the sign-in it describes.
 */
async function safeEmit(
  deps: ResolvedDeps,
  input: DomainEventInput
): Promise<EmitDomainEventResult | null> {
  try {
    return await deps.emit(input, { db: deps.db, clock: deps.clock });
  } catch (error) {
    getLogger().error("identity hook emit failed", {
      event: "identity_hook.emit_failed",
      eventKey: input.eventKey,
      err: error,
    });
    return null;
  }
}

/** A `user`-scoped ref for every account lifecycle event. */
function userRef(userId: string): { kind: string; id: string } {
  return { kind: "user", id: userId };
}

/**
 * Insert the profile and preferences defaults for a newly created account.
 *
 * Both writes are upserts keyed by `userId` (`$setOnInsert`), so a duplicate
 * invocation (Better Auth retry, at-least-once delivery) cannot create a second
 * row. The welcome and lazy-invite side effects run only on the insert that
 * actually created the profile.
 *
 * @param event - The new account's identity and advisory header hints.
 * @param deps - The database/outbox/clock seams.
 */
export async function handleUserCreated(
  event: UserCreatedEvent,
  deps: IdentityHookDeps
): Promise<void> {
  const resolved = resolveDeps(deps);
  const { db, clock } = resolved;
  const userId = toObjectId(event.userId);
  if (userId === null) {
    return;
  }

  const now = clock.now();
  const locale = parseLocale(event.acceptLanguage);
  const timeZoneHint = event.timeZone?.trim();
  const timeZone =
    timeZoneHint === undefined || timeZoneHint === "" ? DEFAULT_TIME_ZONE : timeZoneHint;

  const profileInsert = await platformRepo(db)
    .collection(USER_PROFILES_COLLECTION)
    .updateOne(
      { userId },
      {
        $setOnInsert: {
          userId,
          platformRole: "client",
          status: "active",
          locale,
          timeZone,
          accountCompletedAt: null,
          primaryTenantId: null,
          marketingOptIn: false,
          contactCapabilities: {
            whatsappCapable: null,
            whatsappCheckedAt: null,
            pushTokens: [],
          },
          schemaVersion: 1,
          /**
           * Marks this row as the lazily-created default so an explicitly managed
           * profile for the same user always takes precedence on read (see
           * `loadProfile` in `guards.ts`).
           */
          autoProvisioned: true,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true }
    );

  await platformRepo(db)
    .collection(NOTIFICATION_PREFERENCES_COLLECTION)
    .updateOne(
      { userId },
      {
        $setOnInsert: {
          userId,
          global: { email: "on", mobile: "off", in_app: "on" },
          byType: {},
          byEvent: {},
          quietHours: { enabled: true, start: "22:00", end: "07:00", timeZone },
          digest: {},
          locale,
          updatedAt: now,
        },
      },
      { upsert: true }
    );

  // Already provisioned (duplicate invocation): stay idempotent and emit nothing.
  if (profileInsert.upsertedCount === 0) {
    return;
  }

  await safeEmit(resolved, {
    eventKey: ACCOUNT_WELCOME_EVENT,
    tenantId: event.userId,
    actorRef: userRef(event.userId),
    subjectRef: userRef(event.userId),
    payload: {},
    dedupeKey: `${ACCOUNT_WELCOME_EVENT}:${event.userId}`,
  });

  await resolvePendingInvitations(event, resolved, userId, now);
}

/**
 * Resolve pending invitations addressed to the new account's email or phone.
 *
 * The matching invitations get `invitee.userId` set and each re-emits the
 * `collab.invite.sent` notification as a domain event, deduped `1/invite`.
 *
 * @param event - The new account's identity.
 * @param deps - The database/outbox seams.
 * @param userId - The new account's id as an ObjectId.
 * @param now - The instant stamped on the invitation update.
 */
async function resolvePendingInvitations(
  event: UserCreatedEvent,
  deps: ResolvedDeps,
  userId: ObjectId,
  now: Date
): Promise<void> {
  const { db } = deps;
  const matches: Document[] = [{ "invitee.email": event.email }];
  if (typeof event.phoneNumber === "string" && event.phoneNumber !== "") {
    matches.push({ "invitee.phoneE164": event.phoneNumber });
  }

  const pending = await platformRepo(db)
    .collection(INVITATIONS_COLLECTION)
    .find({ status: "pending", $or: matches })
    .toArray();

  for (const raw of pending) {
    const invitation = raw as {
      _id?: unknown;
      tenantId?: unknown;
      eventId?: unknown;
      role?: unknown;
      kind?: unknown;
    };
    const invitationId = asHexString(invitation._id);
    if (invitationId === null) {
      continue;
    }

    await platformRepo(db)
      .collection(INVITATIONS_COLLECTION)
      .updateOne({ _id: invitation._id }, { $set: { "invitee.userId": userId, updatedAt: now } });

    const eventId = asHexString(invitation.eventId);
    await safeEmit(deps, {
      eventKey: "collab.invite.sent",
      tenantId: asHexString(invitation.tenantId) ?? event.userId,
      actorRef: userRef(event.userId),
      subjectRef: { kind: "invitation", id: invitationId },
      payload: {
        inviteId: invitationId,
        ...(typeof invitation.role === "string" ? { role: invitation.role } : {}),
        ...(typeof invitation.kind === "string" ? { kind: invitation.kind } : {}),
        ...(eventId === null ? {} : { eventId }),
      },
      dedupeKey: `collab.invite.sent:${invitationId}`,
    });
  }
}

/**
 * Complete an account once both its email and phone are verified.
 *
 * The `accountCompletedAt` write is a conditional update (`accountCompletedAt:
 * null`), so a re-verification can neither move the instant nor re-emit
 * `auth.account.completed`.
 *
 * @param event - The user whose contact verification just changed.
 * @param deps - The database/outbox/clock seams.
 */
export async function handleContactVerified(
  event: ContactVerifiedEvent,
  deps: IdentityHookDeps
): Promise<void> {
  const resolved = resolveDeps(deps);
  const { db, clock } = resolved;
  const userId = toObjectId(event.userId);
  if (userId === null) {
    return;
  }

  const user = (await platformRepo(db).collection(USER_COLLECTION).findOne({ _id: userId })) as {
    emailVerified?: unknown;
    phoneNumberVerified?: unknown;
  } | null;
  if (user === null) {
    return;
  }
  if (user.emailVerified !== true || user.phoneNumberVerified !== true) {
    return;
  }

  const now = clock.now();
  const updated = await platformRepo(db)
    .collection(USER_PROFILES_COLLECTION)
    .findOneAndUpdate(
      { userId, accountCompletedAt: null },
      { $set: { accountCompletedAt: now, updatedAt: now } },
      { returnDocument: "after" }
    );
  if (updated === null) {
    return;
  }

  await safeEmit(resolved, {
    eventKey: "auth.account.completed",
    tenantId: event.userId,
    actorRef: userRef(event.userId),
    subjectRef: userRef(event.userId),
    payload: {},
    dedupeKey: `auth.account.completed:${event.userId}`,
  });
}

/**
 * Record a new session: new-device and admin sign-in security events, plus the
 * non-blocking unclaimed `op_att` claim.
 *
 * The device fingerprint is salted with `getRateLimitConfig().salt`; only the
 * hashed `deviceHash` reaches the outbox. A device is "new" when no sighting in
 * the last 24 hours matches, so one event is emitted per device per window.
 *
 * @param event - The session's user, id, device and any unclaimed op_att token.
 * @param deps - The database/outbox/clock/claim seams.
 */
export async function handleSessionCreated(
  event: SessionCreatedEvent,
  deps: IdentityHookDeps
): Promise<void> {
  const resolved = resolveDeps(deps);
  const { db, clock } = resolved;
  const userId = toObjectId(event.userId);
  if (userId === null) {
    return;
  }

  const now = clock.now();
  const salt = getRateLimitConfig().salt;
  const deviceHash = hashFingerprint(event.device, salt);

  const sightings = await platformRepo(db)
    .collection(SESSION_DEVICES_COLLECTION)
    .find({
      userId,
      fingerprintHash: deviceHash,
      createdAt: { $gt: new Date(now.getTime() - NEW_DEVICE_WINDOW_MS) },
    })
    .sort({ createdAt: -1 })
    .limit(SESSION_DEVICE_READ_LIMIT)
    .toArray();
  const prior: PriorDeviceSighting[] = [];
  for (const raw of sightings) {
    const sighting = raw as { fingerprintHash?: unknown; createdAt?: unknown };
    const fingerprintHash = sighting.fingerprintHash;
    const createdAt = asDate(sighting.createdAt);
    if (typeof fingerprintHash === "string" && createdAt !== null) {
      prior.push({ fingerprintHash, createdAt });
    }
  }

  if (isNewDevice({ fingerprintHash: deviceHash, prior, now, windowMs: NEW_DEVICE_WINDOW_MS })) {
    await safeEmit(resolved, {
      eventKey: "auth.signin.new_device",
      tenantId: event.userId,
      actorRef: userRef(event.userId),
      subjectRef: userRef(event.userId),
      payload: { deviceHash },
      dedupeKey: `auth.signin.new_device:${event.userId}:${deviceHash}:${String(
        deviceWindowBucket(now)
      )}`,
    });
  }

  await platformRepo(db)
    .collection(SESSION_DEVICES_COLLECTION)
    .insertOne({
      userId,
      fingerprintHash: deviceHash,
      createdAt: now,
      expireAt: addMilliseconds(now, SESSION_DEVICE_TTL_MS),
    });

  const profile = (await platformRepo(db)
    .collection(USER_PROFILES_COLLECTION)
    .findOne({ userId })) as { platformRole?: unknown } | null;
  if (profile?.platformRole === "admin") {
    await safeEmit(resolved, {
      eventKey: "auth.admin.signin",
      tenantId: event.userId,
      actorRef: userRef(event.userId),
      subjectRef: userRef(event.userId),
      payload: {},
    });
  }

  await runClaim(event, resolved);
}

/** Invoke the claim seam for an unclaimed `op_att` token, never throwing. */
async function runClaim(event: SessionCreatedEvent, deps: ResolvedDeps): Promise<void> {
  const token = event.attendeeSessionToken;
  if (typeof token !== "string" || token.trim() === "") {
    return;
  }

  try {
    await deps.claim({ userId: event.userId, token: token.trim() });
  } catch (error) {
    getLogger().error("identity hook claim failed", {
      event: "identity_hook.claim_failed",
      err: error,
    });
  }
}

/**
 * Announce a contact change and record the transient fan-out targets.
 *
 * The event payload carries **flags only** (`{ emailChanged, phoneChanged }`);
 * the raw previous and current contacts go into a short-lived
 * `contactChangeFanouts` record the fan-out consumer reads once, so the
 * security alert can reach the address that was just replaced without leaking a
 * contact into the append-only outbox (ADR-0040 §2).
 *
 * @param event - The replaced and replacement contact references.
 * @param deps - The database/outbox/clock seams.
 */
export async function handleContactChanged(
  event: ContactChangedEvent,
  deps: IdentityHookDeps
): Promise<void> {
  const resolved = resolveDeps(deps);
  const { db, clock } = resolved;
  const now = clock.now();

  const previous = {
    email: event.previous.email ?? null,
    phoneNumber: event.previous.phoneNumber ?? null,
  };
  const current = {
    email: event.current.email ?? null,
    phoneNumber: event.current.phoneNumber ?? null,
  };
  const emailChanged = previous.email !== current.email;
  const phoneChanged = previous.phoneNumber !== current.phoneNumber;

  const emitted = await safeEmit(resolved, {
    eventKey: "auth.contact.changed",
    tenantId: event.userId,
    actorRef: userRef(event.userId),
    subjectRef: userRef(event.userId),
    payload: { emailChanged, phoneChanged },
    dedupeKey: `auth.contact.changed:${event.userId}:${now.toISOString()}`,
  });

  if (emitted === null) {
    return;
  }
  if (emitted.id === null) {
    return;
  }

  await platformRepo(db)
    .collection(CONTACT_CHANGE_FANOUTS_COLLECTION)
    .insertOne({
      eventId: emitted.id,
      userId: event.userId,
      previous,
      current,
      expireAt: addMilliseconds(now, CONTACT_CHANGE_FANOUT_TTL_MS),
    });
}

/**
 * Announce a two-factor state change.
 *
 * `enabled` and `disabled` are distinct security events and are deduped on the
 * transition (`typeKey:userId:instant`), so re-running the same invocation
 * collapses to one row while a genuinely new toggle re-emits (ADR-0040 §3).
 *
 * @param event - The user and the resulting 2FA state.
 * @param deps - The database/outbox/clock seams.
 */
export async function handleTwoFactorToggled(
  event: TwoFactorToggledEvent,
  deps: IdentityHookDeps
): Promise<void> {
  const resolved = resolveDeps(deps);
  const now = resolved.clock.now();
  const eventKey = event.enabled ? "auth.2fa.enabled" : "auth.2fa.disabled";

  await safeEmit(resolved, {
    eventKey,
    tenantId: event.userId,
    actorRef: userRef(event.userId),
    subjectRef: userRef(event.userId),
    payload: { enabled: event.enabled },
    dedupeKey: `${eventKey}:${event.userId}:${now.toISOString()}`,
  });
}

/**
 * Announce that every session of a user was revoked.
 *
 * Deduped on the instant (`eventKey:userId:instant`), matching the contact-changed
 * and 2FA schemes, so a redelivered invocation collapses to one row while a
 * genuinely new revoke-all at a later instant re-emits (ADR-0043 §1).
 *
 * @param event - The user and the revoked session ids.
 * @param deps - The database/outbox/clock seams.
 */
export async function handleSessionsRevoked(
  event: SessionsRevokedEvent,
  deps: IdentityHookDeps
): Promise<void> {
  const resolved = resolveDeps(deps);
  const now = resolved.clock.now();

  await safeEmit(resolved, {
    eventKey: "account.sessions.revoked",
    tenantId: event.userId,
    actorRef: userRef(event.userId),
    subjectRef: userRef(event.userId),
    payload: { revokedCount: event.sessionIds?.length ?? 0 },
    dedupeKey: `account.sessions.revoked:${event.userId}:${now.toISOString()}`,
  });
}
