/**
 * `resolveChannel` — the pure per-(recipient × type × group) routing decision
 * (design §5, contract Appendix F Phase 1, ADR-0085).
 *
 * The routing matrix is stored as data (`notificationTypes`, OP-84); this module
 * is the code that *reads* it. It is deliberately **pure**: every fact it needs
 * (`typeRow`, `group`, `prefs`, `profile`, `contacts`, `suppressions`, `now`,
 * `eventId`, `throttleState`) is handed in by the caller, so the whole §5
 * decision is exercised offline with zero Mongo, clock or network access.
 *
 * Resolution order (design §5 / ADR-0085):
 *   type disabled → group preference (transactional forces ON; else
 *   `byEvent[eventId][group] ?? byType[typeKey][group] ?? global[group] ?? "on"`,
 *   `off` honoured only when the group allows opt-out and is not `in_app`) →
 *   candidate eligibility + per-candidate suppression → throttle/dedupe/digest →
 *   quiet hours.
 *
 * The returned {@link ChannelDecision} is exactly one of `send`, `skip`, `defer`
 * or `digest`; the fan-out worker persists it verbatim.
 */

import type { ChannelGroup, NotificationType } from "@/server/notifications/notification-types";

/** The concrete channel a decision may address (design §1.1). */
export type ResolvedChannel = "in_app" | "email" | "sms" | "whatsapp";

/**
 * Why a send was skipped (contract §19.5).
 *
 * `quiet_hours_deferred` is never returned as a `skip` — the §5 flow
 * *schedules* the send after the window, so it surfaces on the `defer` decision
 * instead — but it is part of the vocabulary the caller branches on.
 */
export type SkipReason =
  | "user_opt_out"
  | "no_verified_contact"
  | "suppressed"
  | "throttled"
  | "deduped"
  | "type_disabled"
  | "quiet_hours_deferred";

/** The seven decision shapes the fan-out worker understands (ADR-0085). */
export type ChannelDecision =
  | { readonly kind: "send"; readonly channel: ResolvedChannel }
  | { readonly kind: "skip"; readonly reason: SkipReason }
  | { readonly kind: "defer"; readonly until: string; readonly reason: "quiet_hours_deferred" }
  | { readonly kind: "digest"; readonly bucketKey: string };

/** The three routing channel groups (design §1.1). */
export type ChannelGroupName = ChannelGroup["group"];

/** A single group's preference value within one scope. */
export type GroupPreference = "on" | "off";

/** A group-keyed preference scope (`global` / `byType[...]` / `byEvent[...]`). */
export type ResolveGroupPreferences = Partial<Record<ChannelGroupName, GroupPreference>>;

/** The quiet-hours window (design §19.3); `start`/`end` are `HH:MM` wall clocks. */
export interface QuietHours {
  readonly enabled: boolean;
  readonly start: string;
  readonly end: string;
  readonly timeZone: string;
}

/**
 * The user's notification-preference document (schema §19.3).
 *
 * The stored document is sparse: an override absent from a scope is not a
 * preference value at all, so it falls through to the next scope (U4).
 */
export interface ResolvePreferences {
  readonly global: ResolveGroupPreferences;
  readonly byType: Readonly<Record<string, ResolveGroupPreferences>>;
  readonly byEvent: Readonly<Record<string, ResolveGroupPreferences>>;
  readonly quietHours: QuietHours;
  readonly locale: string;
}

/**
 * The profile facts the resolver reads (schema §13, contract §1.2 `Me`).
 *
 * Only `contactCapabilities.whatsappCapable` is consulted today; the verified
 * flags live on {@link ResolveContacts} (Better Auth facts, ADR-0085).
 */
export interface ResolveProfile {
  readonly userId: string;
  readonly contactCapabilities: {
    readonly whatsappCapable: boolean | null;
    readonly whatsappCheckedAt: Date | null;
  };
}

/** The recipient's contact facts, mirroring the Better Auth user (ADR-0085). */
export interface ResolveContacts {
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly phoneNumber: string | null;
  readonly phoneNumberVerified: boolean;
}

/**
 * An already-matched suppression row (schema §19.6).
 *
 * Hashing the destination to `contactHash` is the caller's job; the resolver
 * receives only the rows that already apply. A `marketing` scope blocks a
 * candidate only for a **non-transactional** type (U11).
 */
export interface NotificationSuppression {
  readonly channel: ResolvedChannel;
  readonly scope: "all" | "marketing";
  readonly reason: string;
}

/**
 * The throttle state the caller has already established upstream (design §6).
 *
 * Dedupe is a passthrough: the unique index has already matched, so the resolver
 * does not re-implement it (ADR-0085).
 */
export interface ThrottleState {
  readonly rateLimitExceeded?: boolean;
  readonly deduped?: boolean;
}

/** The full input to {@link resolveChannel} (ADR-0085). */
export interface ResolveChannelInput {
  readonly typeRow: NotificationType;
  readonly group: ChannelGroup;
  readonly prefs: ResolvePreferences;
  readonly profile: ResolveProfile;
  readonly contacts: ResolveContacts;
  readonly suppressions: readonly NotificationSuppression[];
  /** Injected clock — the resolver never reads a clock itself. */
  readonly now: Date;
  /** The event scope for `byEvent` precedence and the digest bucket key. */
  readonly eventId?: string | null;
  readonly throttleState?: ThrottleState;
}

/** The `mobile` candidate order when the group does not declare one (design §1.1). */
const DEFAULT_MOBILE_CANDIDATES: readonly ResolvedChannel[] = ["whatsapp", "sms"];

/** `HH:MM` → minutes from midnight. */
function parseClock(value: string): number {
  const [hours, minutes] = value.split(":");
  return Number(hours ?? 0) * 60 + Number(minutes ?? 0);
}

/** Resolve the effective `on`/`off` for a group through the preference scopes. */
function effectivePreference(
  typeRow: NotificationType,
  groupName: ChannelGroupName,
  prefs: ResolvePreferences,
  eventId: string | null | undefined
): GroupPreference {
  // A transactional type is never opt-outable: it forces the group ON.
  if (typeRow.transactional) return "on";

  const byEvent = eventId === undefined || eventId === null ? undefined : prefs.byEvent[eventId];

  return (
    byEvent?.[groupName] ??
    prefs.byType[typeRow.typeKey]?.[groupName] ??
    prefs.global[groupName] ??
    "on"
  );
}

/** True when the group preference is `off` and the group honours opt-out. */
function isOptedOut(
  typeRow: NotificationType,
  group: ChannelGroup,
  prefs: ResolvePreferences,
  eventId: string | null | undefined
): boolean {
  // `in_app` is never opt-outable (U5), and a group that forbids opt-out ignores it.
  if (group.group === "in_app" || !group.optOutAllowed) return false;

  return effectivePreference(typeRow, group.group, prefs, eventId) === "off";
}

/** True when a suppression row blocks this candidate for this type. */
function isSuppressed(
  channel: ResolvedChannel,
  suppressions: readonly NotificationSuppression[],
  typeRow: NotificationType
): boolean {
  return suppressions.some((row) => {
    if (row.channel !== channel) return false;
    if (row.scope === "all") return true;
    // A marketing unsubscribe must never silently block a transactional send (U11).
    return !typeRow.transactional;
  });
}

/** True when a verified contact exists for the candidate's channel. */
function isCandidateEligible(
  candidate: ResolvedChannel,
  profile: ResolveProfile,
  contacts: ResolveContacts
): boolean {
  if (candidate === "in_app") return true;
  if (candidate === "email") return contacts.email !== null && contacts.emailVerified;

  // sms / whatsapp both need a verified phone; whatsapp additionally needs capability.
  const hasPhone = contacts.phoneNumber !== null && contacts.phoneNumberVerified;
  if (!hasPhone) return false;
  if (candidate === "whatsapp") {
    return profile.contactCapabilities.whatsappCapable === true;
  }
  return true;
}

/** The candidate channels for a group, in first-eligible order. */
function candidateChannels(group: ChannelGroup): readonly ResolvedChannel[] {
  if (group.group === "mobile") return group.candidates ?? DEFAULT_MOBILE_CANDIDATES;
  return [group.group];
}

/** Select the first eligible, non-suppressed candidate for the group. */
function selectCandidate(
  typeRow: NotificationType,
  group: ChannelGroup,
  profile: ResolveProfile,
  contacts: ResolveContacts,
  suppressions: readonly NotificationSuppression[]
): ChannelDecision {
  let sawSuppressedCandidate = false;

  for (const candidate of candidateChannels(group)) {
    if (!isCandidateEligible(candidate, profile, contacts)) continue;

    if (isSuppressed(candidate, suppressions, typeRow)) {
      sawSuppressedCandidate = true;
      continue;
    }

    return { kind: "send", channel: candidate };
  }

  // Every eligible candidate was suppressed → suppressed; otherwise no contact (U25b).
  return sawSuppressedCandidate
    ? { kind: "skip", reason: "suppressed" }
    : { kind: "skip", reason: "no_verified_contact" };
}

/** The throttle/dedupe/digest decision, or `null` to continue to quiet hours. */
function resolveThrottle(
  typeRow: NotificationType,
  throttleState: ThrottleState | undefined,
  eventId: string | null | undefined
): ChannelDecision | null {
  if (throttleState?.deduped === true) return { kind: "skip", reason: "deduped" };
  if (throttleState?.rateLimitExceeded === true) return { kind: "skip", reason: "throttled" };

  if (typeRow.throttle.strategy === "digest") {
    return { kind: "digest", bucketKey: `${typeRow.typeKey}:${eventId ?? ""}` };
  }

  return null;
}

/** The wall-clock fields of an instant in a named time zone. */
interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly minutes: number;
  /** `localWallClockAsUtc - instant`; the zone offset in milliseconds. */
  readonly offsetMs: number;
}

/** Read an instant's civil time in `timeZone` (no external tz dependency). */
function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);

  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  const year = value("year");
  const month = value("month");
  const day = value("day");
  const hour = value("hour");
  const minute = value("minute");
  const second = value("second");

  const localWallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);

  return {
    year,
    month,
    day,
    minutes: hour * 60 + minute,
    offsetMs: localWallClockAsUtc - instant.getTime(),
  };
}

/** True when `minutes` falls inside the window, handling a midnight crossing. */
function withinWindow(minutes: number, start: string, end: string): boolean {
  const startMinutes = parseClock(start);
  const endMinutes = parseClock(end);

  return startMinutes <= endMinutes
    ? minutes >= startMinutes && minutes < endMinutes
    : minutes >= startMinutes || minutes < endMinutes;
}

/** The quiet-hours defer decision, or `null` when the send may proceed. */
function resolveQuietHours(
  typeRow: NotificationType,
  prefs: ResolvePreferences,
  now: Date
): ChannelDecision | null {
  if (!typeRow.respectQuietHours || typeRow.severity === "critical") return null;

  const quiet = prefs.quietHours;
  if (!quiet.enabled) return null;

  const local = zonedParts(now, quiet.timeZone);
  if (!withinWindow(local.minutes, quiet.start, quiet.end)) return null;

  const end = parseClock(quiet.end);
  const endTodayAsUtc = Date.UTC(local.year, local.month - 1, local.day, 0, end);
  let untilMs = endTodayAsUtc - local.offsetMs;
  if (untilMs <= now.getTime()) untilMs += 24 * 60 * 60 * 1000;

  return {
    kind: "defer",
    until: new Date(untilMs).toISOString(),
    reason: "quiet_hours_deferred",
  };
}

/**
 * Resolve one group's channel decision for one recipient (design §5).
 *
 * @param input - Every fact the decision depends on, as plain values.
 * @returns The single decision (send / skip / defer / digest) for this group.
 */
export function resolveChannel(input: ResolveChannelInput): ChannelDecision {
  const { typeRow, group, prefs, profile, contacts, suppressions, now, eventId, throttleState } =
    input;

  if (!typeRow.enabled) return { kind: "skip", reason: "type_disabled" };

  if (isOptedOut(typeRow, group, prefs, eventId)) {
    return { kind: "skip", reason: "user_opt_out" };
  }

  const candidate = selectCandidate(typeRow, group, profile, contacts, suppressions);
  if (candidate.kind === "skip") return candidate;

  const throttle = resolveThrottle(typeRow, throttleState, eventId);
  if (throttle !== null) return throttle;

  const quiet = resolveQuietHours(typeRow, prefs, now);
  if (quiet !== null) return quiet;

  return candidate;
}
