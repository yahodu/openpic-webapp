import { describe, expect, it } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import {
  notificationTypeSchema,
  type ChannelGroup,
  type NotificationType,
} from "@/server/notifications/notification-types";
import {
  NOTIFICATION_TYPE_KEYS,
  SEED_NOTIFICATION_TYPES,
} from "@/server/notifications/notification-types.values";

import { makeNotificationType, requireType } from "../../test/factories/notification";

/**
 * Unit contract — the `notificationTypes` routing catalogue (schema §19.1,
 * contract §7.6).
 *
 * The routing matrix is **stored as data**, not code (design §8): Novu holds no
 * routing knowledge, and `GET /api/v1/notification-types` serves these documents
 * verbatim, so the seed is the single source of truth for every channel,
 * candidate order, opt-out rule and dedupe key. These specs pin the invariants
 * the §4 matrix promises — the frozen 81-key set, the billing audience guard,
 * transactional opt-out, in-app opt-out, the mobile candidate order and the OTP
 * secrecy rules — so an incorrect transcription fails here rather than silently
 * mis-routing a production notification.
 *
 * Contract expected of the implementation:
 *
 *   @/server/notifications/notification-types
 *     notificationTypeSchema : Zod schema of a stored `notificationTypes` doc
 *     type NotificationType, ChannelGroup, NotificationCategory, …
 *   @/server/notifications/notification-types.values
 *     NOTIFICATION_TYPE_KEYS : readonly string[] — the frozen 81 contract keys
 *     SEED_NOTIFICATION_TYPES : readonly NotificationType[] — one per key
 *
 * The key set is asserted against an **inlined** contract list rather than a
 * Vitest snapshot: a snapshot is written on first run and would therefore pass
 * before the seed exists, making the red state vacuous.
 */

/** The normative 81 `typeKey`s from contract §7.6, grouped by contract category. */
const CONTRACT_KEYS_BY_CATEGORY = {
  authentication: [
    "auth.otp.email.requested",
    "auth.otp.mobile.requested",
    "auth.signin.new_device",
    "auth.2fa.enabled",
    "auth.2fa.disabled",
    "auth.contact.changed",
    "auth.account.completed",
    "auth.suspicious.blocked",
    "auth.admin.signin",
  ],
  account: [
    "account.welcome",
    "account.verification.incomplete",
    "account.deletion.requested",
    "account.deletion.completed",
    "account.sessions.revoked",
  ],
  billing: [
    "billing.mandate.pending",
    "billing.mandate.failed",
    "billing.subscription.activated",
    "billing.renewal.upcoming",
    "billing.payment.succeeded",
    "billing.payment.failed",
    "billing.grace.reminder",
    "billing.subscription.downgraded",
    "billing.subscription.reactivated",
    "billing.plan.upgraded",
    "billing.plan.downgrade_scheduled",
    "billing.plan.downgrade_applied",
    "billing.addon.purchased",
    "billing.invoice.issued",
    "billing.subscription.cancelled",
    "billing.refund.processed",
  ],
  usage: [
    "usage.storage.threshold",
    "usage.events.threshold",
    "usage.action.blocked",
    "usage.limit.restored",
  ],
  event: [
    "event.created",
    "event.details.updated",
    "event.starting_soon",
    "event.ended",
    "event.upload_window.closing",
    "event.upload_window.closed",
    "event.link.rotated",
    "event.archived",
    "event.deleted",
    "event.retention.expiring",
    "event.attendee.milestone",
  ],
  collaboration: [
    "collab.invite.sent",
    "collab.invite.reminder",
    "collab.invite.accepted",
    "collab.invite.rejected",
    "collab.invite.revoked",
    "collab.invite.expired",
    "collab.member.removed",
    "collab.member.removed.ack",
  ],
  pipeline: [
    "upload.batch.completed",
    "upload.batch.completed_with_errors",
    "upload.batch.files_rejected",
    "upload.session.stalled",
    "upload.blocked.quota",
    "pipeline.event.indexed",
    "pipeline.image.failed",
    "pipeline.delayed",
  ],
  matching: [
    "attendee.selfie.accepted",
    "attendee.selfie.rejected",
    "attendee.matches.ready",
    "attendee.matches.new",
    "attendee.matches.none_found",
    "attendee.event.linked",
    "attendee.gallery.expiring",
    "attendee.download.ready",
    "attendee.consent.receipt",
  ],
  compliance: [
    "legal.terms.updated",
    "privacy.dsr.received",
    "privacy.export.ready",
    "privacy.erasure.completed",
  ],
  platform_ops: [
    "admin.invite.sent",
    "admin.abuse.flagged",
    "admin.queue.backlog",
    "admin.provider.failing",
    "admin.billing.manual_review",
    "admin.dsr.sla_risk",
    "admin.plan.modified",
  ],
} as const satisfies Record<string, readonly string[]>;

/** Every contract key, sorted for stable comparison. */
const CONTRACT_TYPE_KEYS: readonly string[] = Object.values(CONTRACT_KEYS_BY_CATEGORY)
  .flat()
  .sort();

/** The two OTP types, whose bodies must never be retained (design rule 6). */
const OTP_TYPE_KEYS = ["auth.otp.email.requested", "auth.otp.mobile.requested"] as const;

/** Find one channel group on a type, or `undefined` when absent. */
function groupOf(type: NotificationType, group: ChannelGroup["group"]): ChannelGroup | undefined {
  return type.channelGroups.find((candidate) => candidate.group === group);
}

/** Every seeded type's key, sorted. */
function seededKeys(): string[] {
  return SEED_NOTIFICATION_TYPES.map((type) => type.typeKey).sort();
}

describe("frozen typeKey catalogue (U1)", () => {
  it("U1: NOTIFICATION_TYPE_KEYS is exactly the 81 contract keys", () => {
    expect(CONTRACT_TYPE_KEYS).toHaveLength(81);
    expect([...NOTIFICATION_TYPE_KEYS].sort()).toEqual(CONTRACT_TYPE_KEYS);
  });

  it("U1: the seed ships exactly one type per contract key, no more and no fewer", () => {
    expect(seededKeys()).toEqual(CONTRACT_TYPE_KEYS);
    expect(new Set(seededKeys()).size).toBe(81);
  });

  it("U1: every seeded type carries the contract category for its key", () => {
    for (const [category, keys] of Object.entries(CONTRACT_KEYS_BY_CATEGORY)) {
      const seeded = SEED_NOTIFICATION_TYPES.filter((type) => type.category === category)
        .map((type) => type.typeKey)
        .sort();

      expect(seeded, `category "${category}"`).toEqual([...keys].sort());
    }
  });
});

describe("channelGroups shape (schema §19.1)", () => {
  it("every type carries in_app, email and mobile exactly once", () => {
    for (const type of SEED_NOTIFICATION_TYPES) {
      const groups = type.channelGroups.map((group) => group.group).sort();

      expect(groups, type.typeKey).toEqual(["email", "in_app", "mobile"]);
    }
  });
});

describe("billing audience guard (U2)", () => {
  it("U2: no billing type is routed to a co-organizer", () => {
    const billing = SEED_NOTIFICATION_TYPES.filter((type) => type.category === "billing");

    expect(billing).toHaveLength(16);

    for (const type of billing) {
      expect(type.audiences, type.typeKey).not.toContain("co_organizer");
    }
  });
});

describe("transactional opt-out (U3)", () => {
  it("U3: every transactional type sets optOutAllowed false on every channel group", () => {
    const transactional = SEED_NOTIFICATION_TYPES.filter((type) => type.transactional);

    expect(transactional.length).toBeGreaterThan(0);

    for (const type of transactional) {
      for (const group of type.channelGroups) {
        expect(group.optOutAllowed, `${type.typeKey}:${group.group}`).toBe(false);
      }
    }
  });
});

describe("in_app is never opt-outable (U4)", () => {
  it("U4: every type sets optOutAllowed false on its in_app group", () => {
    for (const type of SEED_NOTIFICATION_TYPES) {
      expect(groupOf(type, "in_app")?.optOutAllowed, type.typeKey).toBe(false);
    }
  });
});

describe("mobile candidate order (U5)", () => {
  it("U5: every enabled mobile group prefers WhatsApp then SMS", () => {
    for (const type of SEED_NOTIFICATION_TYPES) {
      const mobile = groupOf(type, "mobile");
      if (mobile?.enabled !== true) continue;
      if (type.typeKey === "auth.otp.mobile.requested") continue;

      expect(mobile.candidates, type.typeKey).toEqual(["whatsapp", "sms"]);
      expect(mobile.strategy, type.typeKey).toBe("first_eligible");
    }
  });

  it("U5: the mobile OTP type is pinned to SMS only and never reroutes to WhatsApp", () => {
    const otp = requireType("auth.otp.mobile.requested");

    expect(groupOf(otp, "mobile")?.candidates).toEqual(["sms"]);
    expect(groupOf(otp, "mobile")?.enabled).toBe(true);
  });
});

describe("OTP secrecy (U6, design rule 6)", () => {
  it("U6: OTP types disable in_app and never retain the body", () => {
    for (const key of OTP_TYPE_KEYS) {
      const type = requireType(key);

      expect(groupOf(type, "in_app")?.enabled, key).toBe(false);
      expect(type.retainBody, key).toBe(false);
    }
  });
});

describe("first-match dedupe (U9)", () => {
  /**
   * The card names `attendee.matches.new`, but the design doc (schema §19.1,
   * §6, matrix §4.8) makes `attendee.matches.ready` the once-per-attendee+event
   * mobile notification and `attendee.matches.new` the digest-throttled
   * follow-up. The spec pins both readings so neither can drift.
   */
  it("U9: the first-match notification is deduped once per profile+event on the mobile group", () => {
    const type = requireType("attendee.matches.ready");

    expect(groupOf(type, "mobile")?.enabled).toBe(true);
    expect(type.dedupe.keyTemplate).toContain("{typeKey}");
    expect(type.dedupe.keyTemplate).toContain("{profileId}");
    expect(type.dedupe.windowHours).toBeNull();
  });

  it("U9: the follow-up match type is digest-throttled and never sent on mobile", () => {
    const type = requireType("attendee.matches.new");

    expect(groupOf(type, "mobile")?.enabled).toBe(false);
    expect(type.throttle.strategy).toBe("digest");
  });
});

describe("notification collection registry", () => {
  it("registers the routing and template collections under their schema names", () => {
    expect(COLLECTIONS.notificationTypes).toBe("notification_types");
    expect(COLLECTIONS.notificationTemplates).toBe("notification_templates");
  });
});

describe("notificationTypeSchema", () => {
  it("accepts the factory baseline and every seeded type", () => {
    expect(notificationTypeSchema.safeParse(makeNotificationType()).success).toBe(true);

    for (const type of SEED_NOTIFICATION_TYPES) {
      expect(notificationTypeSchema.safeParse(type).success, type.typeKey).toBe(true);
    }
  });

  it("rejects a channel group that is not one of the three routing groups", () => {
    const type = makeNotificationType({
      channelGroups: [
        { group: "carrier_pigeon", enabled: true, optOutAllowed: false },
      ] as unknown as ChannelGroup[],
    });

    expect(notificationTypeSchema.safeParse(type).success).toBe(false);
  });
});
