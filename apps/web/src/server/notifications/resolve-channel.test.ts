import { describe, expect, it } from "vitest";

import type { ChannelGroup, NotificationType } from "@/server/notifications/notification-types";
import {
  makeChannelGroups,
  makeNotificationType,
  requireType,
} from "../../test/factories/notification";

import {
  resolveChannel,
  type NotificationSuppression,
  type ResolveChannelInput,
  type ResolveContacts,
  type ResolvePreferences,
  type ResolveProfile,
} from "@/server/notifications/resolve-channel";

/**
 * `resolveChannel` — the pure per-(recipient × type × group) routing decision
 * (design §5, contract Appendix F Phase 1; ADR-0078).
 *
 * This spec pins the observable contract the fan-out worker depends on:
 * `resolveChannel(input)` returns exactly one of
 *
 *   - `{ kind: "send", channel }`
 *   - `{ kind: "skip", reason }`          (all seven `SkipReason`s reachable)
 *   - `{ kind: "defer", until, reason: "quiet_hours_deferred" }`
 *   - `{ kind: "digest", bucketKey }`
 *
 * and performs **zero** I/O — every input is a plain value handed in by the
 * caller. The resolver never reads Mongo, a clock, or the network, so the whole
 * routing matrix is unit-testable offline (design §5, §8).
 *
 * Precedence under test (design §5 / contract §7.4):
 *   transactional → forced ON; else byEvent > byType > global > catalogue default.
 *
 * The scenarios below deliberately isolate one rule each; the module contract
 * (input shape, the added `eventId`, suppression shape, digest bucket key) is
 * recorded in ADR-0078.
 */

/** The three routing channel groups (design §1.1, factory type). */
type GroupName = ChannelGroup["group"];

/**
 * Select one channel group from a type's routing block.
 *
 * @param type - The notification type carrying the groups.
 * @param name - The group to select.
 * @returns The matching channel group.
 * @throws When the type omits the group — a contract violation, so the specs
 *   stay free of `as`/`!` assertions.
 */
function groupOf(type: NotificationType, name: GroupName): ChannelGroup {
  const group = type.channelGroups.find((candidate: ChannelGroup) => candidate.group === name);

  if (group === undefined) {
    throw new Error(`Missing channel group: ${name}`);
  }

  return group;
}

/**
 * The baseline type under test: non-transactional, informational, quiet hours
 * respected, with both `email` and `mobile` opt-out-allowed so a preference
 * assertion is meaningful.
 */
function baseType(overrides: Partial<NotificationType> = {}): NotificationType {
  return makeNotificationType({
    typeKey: "event.details.updated",
    channelGroups: makeChannelGroups({
      email: { optOutAllowed: true },
      mobile: { optOutAllowed: true },
    }),
    ...overrides,
  });
}

/** Baseline preference document (design §19.3); quiet hours off unless overridden. */
function makePrefs(overrides: Partial<ResolvePreferences> = {}): ResolvePreferences {
  return {
    global: {},
    byType: {},
    byEvent: {},
    quietHours: { enabled: false, start: "22:00", end: "07:00", timeZone: "Asia/Kolkata" },
    locale: "en-IN",
    ...overrides,
  };
}

/** Baseline profile: no WhatsApp capability yet (phase 1), so `mobile` → sms. */
function makeProfile(overrides: Partial<ResolveProfile> = {}): ResolveProfile {
  return {
    userId: "user-1",
    contactCapabilities: { whatsappCapable: null, whatsappCheckedAt: null },
    ...overrides,
  };
}

/** Baseline contacts: both email and phone verified. */
function makeContacts(overrides: Partial<ResolveContacts> = {}): ResolveContacts {
  return {
    email: "rahul@example.com",
    emailVerified: true,
    phoneNumber: "+919812345678",
    phoneNumberVerified: true,
    ...overrides,
  };
}

/**
 * Assemble a complete resolver input. The `email` group is the default home of
 * the preference scenarios; mobile/render scenarios override `group` (and
 * `typeRow`) explicitly.
 */
function makeInput(overrides: Partial<ResolveChannelInput> = {}): ResolveChannelInput {
  const typeRow = overrides.typeRow ?? baseType();

  return {
    typeRow,
    group: groupOf(typeRow, "email"),
    prefs: makePrefs(),
    profile: makeProfile(),
    contacts: makeContacts(),
    suppressions: [],
    // 14:30 IST — outside the default 22:00–07:00 quiet window.
    now: new Date("2026-10-05T09:00:00.000Z"),
    eventId: "evt-1",
    ...overrides,
  };
}

/** A single suppression row for `channel` (design §19.6). */
function suppression(overrides: Partial<NotificationSuppression> = {}): NotificationSuppression {
  return { channel: "email", scope: "all", reason: "hard_bounce", ...overrides };
}

describe("resolveChannel — preference precedence and opt-out", () => {
  it("U1: a transactional type is forced on even when every preference scope is off", () => {
    const typeRow = baseType({
      typeKey: "billing.payment.failed",
      transactional: true,
      channelGroups: makeChannelGroups({ email: { optOutAllowed: true } }),
    });

    const decision = resolveChannel(
      makeInput({
        typeRow,
        group: groupOf(typeRow, "email"),
        prefs: makePrefs({
          global: { email: "off" },
          byType: { "billing.payment.failed": { email: "off" } },
          byEvent: { "evt-1": { email: "off" } },
        }),
      })
    );

    expect(decision).toEqual({ kind: "send", channel: "email" });
  });

  it("U2: an event-scoped opt-out overrides a type-scoped opt-in", () => {
    const decision = resolveChannel(
      makeInput({
        prefs: makePrefs({
          global: { email: "on" },
          byType: { "event.details.updated": { email: "on" } },
          byEvent: { "evt-1": { email: "off" } },
        }),
      })
    );

    expect(decision).toEqual({ kind: "skip", reason: "user_opt_out" });
  });

  it("U3: a type-scoped opt-out overrides the global preference", () => {
    const decision = resolveChannel(
      makeInput({
        prefs: makePrefs({
          global: { email: "on" },
          byType: { "event.details.updated": { email: "off" } },
        }),
      })
    );

    expect(decision).toEqual({ kind: "skip", reason: "user_opt_out" });
  });

  it("U4: a group absent from the scoped overrides falls back to the global preference", () => {
    const decision = resolveChannel(
      makeInput({
        prefs: makePrefs({
          global: { email: "on" },
          byType: { "event.details.updated": { mobile: "off" } },
          byEvent: { "evt-1": { mobile: "off" } },
        }),
      })
    );

    expect(decision).toEqual({ kind: "send", channel: "email" });
  });

  it("U5: an in_app opt-out is ignored — in_app is never opt-outable", () => {
    const typeRow = baseType();

    const decision = resolveChannel(
      makeInput({
        typeRow,
        group: groupOf(typeRow, "in_app"),
        prefs: makePrefs({
          global: { in_app: "off" },
          byType: { "event.details.updated": { in_app: "off" } },
        }),
        contacts: makeContacts({
          email: null,
          emailVerified: false,
          phoneNumber: null,
          phoneNumberVerified: false,
        }),
      })
    );

    expect(decision).toEqual({ kind: "send", channel: "in_app" });
  });
});

describe("resolveChannel — mobile first_eligible candidates", () => {
  it("U6: resolves the mobile group to sms when whatsappCapable is null", () => {
    const typeRow = baseType();

    const decision = resolveChannel(
      makeInput({
        typeRow,
        group: groupOf(typeRow, "mobile"),
        profile: makeProfile({
          contactCapabilities: { whatsappCapable: null, whatsappCheckedAt: null },
        }),
      })
    );

    expect(decision).toEqual({ kind: "send", channel: "sms" });
  });

  it("U7: resolves the mobile group to whatsapp when whatsappCapable is true", () => {
    const typeRow = baseType();

    const decision = resolveChannel(
      makeInput({
        typeRow,
        group: groupOf(typeRow, "mobile"),
        profile: makeProfile({
          contactCapabilities: { whatsappCapable: true, whatsappCheckedAt: null },
        }),
      })
    );

    expect(decision).toEqual({ kind: "send", channel: "whatsapp" });
  });

  it("U17: pins the OTP mobile type to sms even when whatsappCapable is true", () => {
    const typeRow = requireType("auth.otp.mobile.requested");

    const decision = resolveChannel(
      makeInput({
        typeRow,
        group: groupOf(typeRow, "mobile"),
        profile: makeProfile({
          contactCapabilities: { whatsappCapable: true, whatsappCheckedAt: null },
        }),
      })
    );

    expect(decision).toEqual({ kind: "send", channel: "sms" });
  });
});

describe("resolveChannel — verified-contact and suppression gates", () => {
  it("U8: skips with no_verified_contact when no verified phone exists for the mobile group", () => {
    const typeRow = baseType();

    const decision = resolveChannel(
      makeInput({
        typeRow,
        group: groupOf(typeRow, "mobile"),
        contacts: makeContacts({ phoneNumber: null, phoneNumberVerified: false }),
      })
    );

    expect(decision).toEqual({ kind: "skip", reason: "no_verified_contact" });
  });

  it("U9: skips with no_verified_contact when the email is unverified", () => {
    const decision = resolveChannel(
      makeInput({
        contacts: makeContacts({ emailVerified: false }),
      })
    );

    expect(decision).toEqual({ kind: "skip", reason: "no_verified_contact" });
  });

  it("U10: a hard_bounce suppression skips the email with reason suppressed", () => {
    const decision = resolveChannel(
      makeInput({
        suppressions: [suppression({ channel: "email", scope: "all", reason: "hard_bounce" })],
      })
    );

    expect(decision).toEqual({ kind: "skip", reason: "suppressed" });
  });

  it("U11: a marketing-scoped suppression does not block a transactional email", () => {
    const typeRow = baseType({
      typeKey: "billing.payment.failed",
      transactional: true,
      channelGroups: makeChannelGroups({ email: { optOutAllowed: true } }),
    });

    const decision = resolveChannel(
      makeInput({
        typeRow,
        group: groupOf(typeRow, "email"),
        suppressions: [
          suppression({ channel: "email", scope: "marketing", reason: "unsubscribe" }),
        ],
      })
    );

    expect(decision).toEqual({ kind: "send", channel: "email" });
  });
});

describe("resolveChannel — throttle, dedupe and digest", () => {
  it("U12: skips with throttled when the rate-limit budget is exhausted", () => {
    const typeRow = baseType({
      throttle: { strategy: "rate_limit", maxPerWindow: 5, windowHours: 1 },
    });

    const decision = resolveChannel(
      makeInput({
        typeRow,
        throttleState: { rateLimitExceeded: true },
      })
    );

    expect(decision).toEqual({ kind: "skip", reason: "throttled" });
  });

  it("U13: passes a pre-detected dedupe through as a deduped skip", () => {
    const typeRow = baseType({
      dedupe: { keyTemplate: "{typeKey}:{profileId}", windowHours: null },
    });

    const decision = resolveChannel(
      makeInput({
        typeRow,
        throttleState: { deduped: true },
      })
    );

    expect(decision).toEqual({ kind: "skip", reason: "deduped" });
  });

  it("U14: returns a digest decision keyed by type and entity for a digest-strategy type", () => {
    const typeRow = baseType({
      typeKey: "attendee.matches.new",
      throttle: { strategy: "digest" },
    });

    const decision = resolveChannel(
      makeInput({
        typeRow,
        eventId: "6702abc",
      })
    );

    expect(decision).toEqual({ kind: "digest", bucketKey: "attendee.matches.new:6702abc" });
  });
});

describe("resolveChannel — quiet hours", () => {
  it("U15: defers a non-critical send inside the 22:00–07:00 IST window until 07:00 IST", () => {
    const decision = resolveChannel(
      makeInput({
        prefs: makePrefs({
          quietHours: {
            enabled: true,
            start: "22:00",
            end: "07:00",
            timeZone: "Asia/Kolkata",
          },
        }),
        // 23:30 IST (UTC+05:30) — inside the window, which crosses midnight.
        now: new Date("2026-10-05T18:00:00.000Z"),
      })
    );

    expect(decision).toEqual({
      kind: "defer",
      until: "2026-10-06T01:30:00.000Z",
      reason: "quiet_hours_deferred",
    });
  });

  it("U16: a critical-severity type bypasses quiet hours and sends immediately", () => {
    const typeRow = baseType({ severity: "critical", respectQuietHours: true });

    const decision = resolveChannel(
      makeInput({
        typeRow,
        group: groupOf(typeRow, "email"),
        prefs: makePrefs({
          quietHours: {
            enabled: true,
            start: "22:00",
            end: "07:00",
            timeZone: "Asia/Kolkata",
          },
        }),
        now: new Date("2026-10-05T18:00:00.000Z"),
      })
    );

    expect(decision).toEqual({ kind: "send", channel: "email" });
  });
});

describe("resolveChannel — type gate", () => {
  it("U22: skips with type_disabled when the notification type is disabled", () => {
    const typeRow = baseType({ enabled: false });

    const decision = resolveChannel(makeInput({ typeRow }));

    expect(decision).toEqual({ kind: "skip", reason: "type_disabled" });
  });
});
