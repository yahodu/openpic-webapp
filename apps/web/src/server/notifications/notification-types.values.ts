import type {
  ChannelGroup,
  NotificationAudience,
  NotificationCategory,
  NotificationDedupe,
  NotificationSeverity,
  NotificationThrottle,
  NotificationType,
} from "./notification-types";

/**
 * The seeded `notificationTypes` routing catalogue (OP-84, schema §19.1,
 * contract §7.6).
 *
 * `SEED_NOTIFICATION_TYPES` is the §4 matrix as **data** — the single source of
 * truth for every channel, candidate order, opt-out rule, throttle and dedupe
 * key. Contract §7.6 enumerates the only valid `typeKey`s in v1; the seed must
 * produce exactly those **81** documents, and {@link NOTIFICATION_TYPE_KEYS}
 * freezes that list for the contract test (ADR-0016 "the frozen 81-key list").
 *
 * ## Prose is derived, values are transcribed
 *
 * Routing facts (channels, transactional, severity, opt-out) are transcribed
 * from design §4. The `label`/`description` copy served by
 * `GET /api/v1/notification-types` is a read-route projection and is not stored
 * here. Severity beyond §4.1 (which states every authentication type is
 * `critical`) is assigned from the section's risk: money/access/erasure notices
 * are `critical`, receipts and states are `important`, and purely informational
 * confirmations are `informational`. `respectQuietHours` is derived as
 * `severity !== "critical"` because §19.1 states quiet hours are ignored for
 * `critical` types. These derived values are flagged TODO(product) — the
 * structural invariants (U1–U9) are what the suite pins.
 */

/** Audience tags for the authenticated account holder (organizer/co-organizer/attendee). */
const ACCOUNT_HOLDERS: readonly NotificationAudience[] = [
  "organizer",
  "co_organizer",
  "attendee_identified",
];

/** Audience tags for an event's organizers (the actor's peers), minus the actor. */
const ORGANIZERS: readonly NotificationAudience[] = ["organizer", "co_organizer"];

/** Audience tag for the sole event owner. */
const ORGANIZER: readonly NotificationAudience[] = ["organizer"];

/** Audience tag for an identified attendee linked to an event. */
const ATTENDEE: readonly NotificationAudience[] = ["attendee_identified"];

/** Audience tag for a platform administrator. */
const ADMIN: readonly NotificationAudience[] = ["platform_admin"];

/** Audience tag for a tenant's billing contact (never a co-organizer — U2). */
const BILLING: readonly NotificationAudience[] = ["billing_contact"];

/** The default throttle: every occurrence is delivered (design §6). */
const NO_THROTTLE: NotificationThrottle = { strategy: "none" };

/** A rate-limited throttle; the budget is advisory until the resolver story pins it. */
function rate(maxPerWindow?: number, windowHours?: number): NotificationThrottle {
  return {
    strategy: "rate_limit",
    ...(maxPerWindow === undefined ? {} : { maxPerWindow }),
    ...(windowHours === undefined ? {} : { windowHours }),
  };
}

/** A digest throttle: occurrences accumulate for `windowHours` before one message. */
function digest(windowHours: number): NotificationThrottle {
  return { strategy: "digest", windowHours };
}

/** A coalesce throttle: occurrences within `windowHours` merge into one row. */
function coalesce(windowHours: number): NotificationThrottle {
  return { strategy: "coalesce", windowHours };
}

/** The fields a seed entry declares; the rest are derived by {@link build}. */
interface TypeSpec {
  readonly key: string;
  readonly category: NotificationCategory;
  readonly audiences: readonly NotificationAudience[];
  /** Enabled groups in `[in_app, email, mobile]` order. */
  readonly channels: readonly [boolean, boolean, boolean];
  readonly transactional: boolean;
  readonly severity: NotificationSeverity;
  /** Whether email/mobile may be opted out of; forced `false` for transactional types. */
  readonly optOutAllowed: boolean;
  readonly throttle: NotificationThrottle;
  readonly dedupe?: NotificationDedupe;
  readonly retainBody?: boolean;
  readonly actionable?: boolean;
  /** Mobile provider candidates; defaults to WhatsApp→SMS (U5). */
  readonly mobileCandidates?: readonly ["whatsapp"] | readonly ["sms"];
}

/**
 * Build a schema-shaped {@link NotificationType} from a {@link TypeSpec}.
 *
 * `in_app` is never opt-out-outable (U4); a transactional type forces
 * `optOutAllowed: false` on every group (U3); a disabled group is omitted from
 * templating by its `enabled: false` flag (AC2). All three groups are always
 * present so the copy of the routing decision is complete.
 */
function build(spec: TypeSpec): NotificationType {
  const [inApp, email, mobile] = spec.channels;
  const optOut = spec.transactional ? false : spec.optOutAllowed;

  const channelGroups: ChannelGroup[] = [
    { group: "in_app", enabled: inApp, optOutAllowed: false },
    { group: "email", enabled: email, optOutAllowed: email ? optOut : false },
  ];

  if (mobile) {
    const candidates: readonly ("whatsapp" | "sms")[] = spec.mobileCandidates ?? [
      "whatsapp",
      "sms",
    ];
    channelGroups.push({
      group: "mobile",
      enabled: true,
      optOutAllowed: optOut,
      candidates: [...candidates],
      strategy: "first_eligible",
    });
  } else {
    channelGroups.push({ group: "mobile", enabled: false, optOutAllowed: false });
  }

  return {
    typeKey: spec.key,
    category: spec.category,
    audiences: [...spec.audiences],
    channelGroups,
    transactional: spec.transactional,
    severity: spec.severity,
    respectQuietHours: spec.severity !== "critical",
    throttle: spec.throttle,
    dedupe: spec.dedupe ?? { keyTemplate: null, windowHours: null },
    retainBody: spec.retainBody ?? true,
    actionable: spec.actionable ?? false,
    enabled: true,
    version: 1,
  };
}

/** The §4.1 `auth.otp.*` dedupe/retention rules share one shape. */
const OTP: Pick<TypeSpec, "retainBody"> = { retainBody: false };

/**
 * The 81 seeded types, in contract §7.6 order (grouped by category).
 *
 * TODO(product): confirm every derived severity and the per-type channel toggles
 * against the §4 matrix before launch; only the structural invariants are pinned
 * by the RED suite.
 */
const TYPE_SPECS: readonly TypeSpec[] = [
  // §4.1 Authentication & security — all transactional, severity critical.
  {
    key: "auth.otp.email.requested",
    category: "authentication",
    audiences: ACCOUNT_HOLDERS,
    channels: [false, true, false],
    transactional: true,
    severity: "critical",
    optOutAllowed: false,
    throttle: rate(5, 1),
    ...OTP,
  },
  {
    key: "auth.otp.mobile.requested",
    category: "authentication",
    audiences: ACCOUNT_HOLDERS,
    channels: [false, false, true],
    transactional: true,
    severity: "critical",
    optOutAllowed: false,
    throttle: rate(5, 1),
    mobileCandidates: ["sms"],
    ...OTP,
  },
  {
    key: "auth.signin.new_device",
    category: "authentication",
    audiences: ACCOUNT_HOLDERS,
    channels: [true, true, false],
    transactional: true,
    severity: "critical",
    optOutAllowed: false,
    throttle: rate(1, 24),
    dedupe: { keyTemplate: "{typeKey}:{deviceId}", windowHours: 24 },
  },
  {
    key: "auth.2fa.enabled",
    category: "authentication",
    audiences: ACCOUNT_HOLDERS,
    channels: [true, true, true],
    transactional: true,
    severity: "critical",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "auth.2fa.disabled",
    category: "authentication",
    audiences: ACCOUNT_HOLDERS,
    channels: [true, true, true],
    transactional: true,
    severity: "critical",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "auth.contact.changed",
    category: "authentication",
    audiences: ACCOUNT_HOLDERS,
    channels: [true, true, true],
    transactional: true,
    severity: "critical",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "auth.account.completed",
    category: "authentication",
    audiences: ACCOUNT_HOLDERS,
    channels: [true, true, false],
    transactional: true,
    severity: "important",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "auth.suspicious.blocked",
    category: "authentication",
    audiences: ACCOUNT_HOLDERS,
    channels: [true, true, true],
    transactional: true,
    severity: "critical",
    optOutAllowed: false,
    throttle: rate(1, 6),
  },
  {
    key: "auth.admin.signin",
    category: "authentication",
    audiences: ADMIN,
    channels: [true, true, true],
    transactional: true,
    severity: "critical",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },

  // §4.2 Account lifecycle.
  {
    key: "account.welcome",
    category: "account",
    audiences: ACCOUNT_HOLDERS,
    channels: [true, true, false],
    transactional: false,
    severity: "informational",
    optOutAllowed: false,
    throttle: rate(1),
  },
  {
    key: "account.verification.incomplete",
    category: "account",
    audiences: ACCOUNT_HOLDERS,
    channels: [true, true, false],
    transactional: false,
    severity: "important",
    optOutAllowed: true,
    throttle: rate(2),
  },
  {
    key: "account.deletion.requested",
    category: "account",
    audiences: ACCOUNT_HOLDERS,
    channels: [true, true, true],
    transactional: true,
    severity: "critical",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "account.deletion.completed",
    category: "account",
    audiences: ACCOUNT_HOLDERS,
    channels: [false, true, false],
    transactional: true,
    severity: "critical",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "account.sessions.revoked",
    category: "account",
    audiences: ACCOUNT_HOLDERS,
    channels: [true, true, false],
    transactional: true,
    severity: "critical",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },

  // §4.3 Billing & subscription — recipient is always the billing contact (U2).
  {
    key: "billing.mandate.pending",
    category: "billing",
    audiences: BILLING,
    channels: [true, true, false],
    transactional: true,
    severity: "important",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "billing.mandate.failed",
    category: "billing",
    audiences: BILLING,
    channels: [true, true, true],
    transactional: true,
    severity: "critical",
    optOutAllowed: false,
    throttle: rate(1, 1),
  },
  {
    key: "billing.subscription.activated",
    category: "billing",
    audiences: BILLING,
    channels: [true, true, true],
    transactional: true,
    severity: "important",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "billing.renewal.upcoming",
    category: "billing",
    audiences: BILLING,
    channels: [true, true, false],
    transactional: true,
    severity: "important",
    optOutAllowed: false,
    throttle: rate(1),
  },
  {
    key: "billing.payment.succeeded",
    category: "billing",
    audiences: BILLING,
    channels: [true, true, false],
    transactional: true,
    severity: "important",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "billing.payment.failed",
    category: "billing",
    audiences: BILLING,
    channels: [true, true, true],
    transactional: true,
    severity: "critical",
    optOutAllowed: false,
    throttle: rate(1, 24),
  },
  {
    key: "billing.grace.reminder",
    category: "billing",
    audiences: BILLING,
    channels: [true, true, true],
    transactional: true,
    severity: "critical",
    optOutAllowed: false,
    throttle: rate(1, 24),
  },
  {
    key: "billing.subscription.downgraded",
    category: "billing",
    audiences: BILLING,
    channels: [true, true, true],
    transactional: true,
    severity: "critical",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "billing.subscription.reactivated",
    category: "billing",
    audiences: BILLING,
    channels: [true, true, true],
    transactional: true,
    severity: "important",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "billing.plan.upgraded",
    category: "billing",
    audiences: BILLING,
    channels: [true, true, false],
    transactional: true,
    severity: "important",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "billing.plan.downgrade_scheduled",
    category: "billing",
    audiences: BILLING,
    channels: [true, true, false],
    transactional: true,
    severity: "important",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "billing.plan.downgrade_applied",
    category: "billing",
    audiences: BILLING,
    channels: [true, true, false],
    transactional: true,
    severity: "important",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "billing.addon.purchased",
    category: "billing",
    audiences: BILLING,
    channels: [true, true, false],
    transactional: true,
    severity: "important",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "billing.invoice.issued",
    category: "billing",
    audiences: BILLING,
    channels: [true, true, false],
    transactional: false,
    severity: "informational",
    optOutAllowed: true,
    throttle: NO_THROTTLE,
  },
  {
    key: "billing.subscription.cancelled",
    category: "billing",
    audiences: BILLING,
    channels: [true, true, true],
    transactional: true,
    severity: "critical",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "billing.refund.processed",
    category: "billing",
    audiences: BILLING,
    channels: [true, true, false],
    transactional: true,
    severity: "important",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },

  // §4.4 Usage & entitlements.
  {
    key: "usage.storage.threshold",
    category: "usage",
    audiences: ORGANIZER,
    channels: [true, true, false],
    transactional: false,
    severity: "important",
    optOutAllowed: true,
    throttle: rate(1),
  },
  {
    key: "usage.events.threshold",
    category: "usage",
    audiences: ORGANIZER,
    channels: [true, true, false],
    transactional: false,
    severity: "important",
    optOutAllowed: true,
    throttle: rate(1),
  },
  {
    key: "usage.action.blocked",
    category: "usage",
    audiences: ORGANIZERS,
    channels: [true, false, false],
    transactional: false,
    severity: "informational",
    optOutAllowed: false,
    throttle: rate(1, 1),
  },
  {
    key: "usage.limit.restored",
    category: "usage",
    audiences: ORGANIZER,
    channels: [true, false, false],
    transactional: false,
    severity: "informational",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },

  // §4.5 Event lifecycle.
  {
    key: "event.created",
    category: "event",
    audiences: ORGANIZERS,
    channels: [true, true, false],
    transactional: false,
    severity: "important",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "event.details.updated",
    category: "event",
    audiences: ORGANIZERS,
    channels: [true, true, false],
    transactional: false,
    severity: "informational",
    optOutAllowed: true,
    throttle: coalesce(15),
  },
  {
    key: "event.starting_soon",
    category: "event",
    audiences: ORGANIZERS,
    channels: [true, true, false],
    transactional: false,
    severity: "important",
    optOutAllowed: true,
    throttle: NO_THROTTLE,
  },
  {
    key: "event.ended",
    category: "event",
    audiences: ORGANIZERS,
    channels: [true, true, false],
    transactional: false,
    severity: "informational",
    optOutAllowed: true,
    throttle: NO_THROTTLE,
  },
  {
    key: "event.upload_window.closing",
    category: "event",
    audiences: ORGANIZERS,
    channels: [true, true, true],
    transactional: false,
    severity: "important",
    optOutAllowed: false,
    throttle: rate(2),
  },
  {
    key: "event.upload_window.closed",
    category: "event",
    audiences: ORGANIZERS,
    channels: [true, true, false],
    transactional: false,
    severity: "important",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "event.link.rotated",
    category: "event",
    audiences: ORGANIZERS,
    channels: [true, true, false],
    transactional: false,
    severity: "critical",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "event.archived",
    category: "event",
    audiences: ORGANIZERS,
    channels: [true, true, false],
    transactional: false,
    severity: "important",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "event.deleted",
    category: "event",
    audiences: ORGANIZERS,
    channels: [true, true, true],
    transactional: false,
    severity: "critical",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "event.retention.expiring",
    category: "event",
    audiences: ORGANIZERS,
    channels: [true, true, true],
    transactional: false,
    severity: "critical",
    optOutAllowed: false,
    throttle: rate(2),
  },
  {
    key: "event.attendee.milestone",
    category: "event",
    audiences: ORGANIZERS,
    channels: [true, false, false],
    transactional: false,
    severity: "informational",
    optOutAllowed: true,
    throttle: digest(24),
  },

  // §4.6 Collaboration.
  {
    key: "collab.invite.sent",
    category: "collaboration",
    audiences: ["co_organizer"],
    channels: [true, true, true],
    transactional: false,
    severity: "important",
    optOutAllowed: false,
    throttle: rate(1),
    actionable: true,
  },
  {
    key: "collab.invite.reminder",
    category: "collaboration",
    audiences: ["co_organizer"],
    channels: [true, true, false],
    transactional: false,
    severity: "informational",
    optOutAllowed: true,
    throttle: rate(1),
  },
  {
    key: "collab.invite.accepted",
    category: "collaboration",
    audiences: ORGANIZER,
    channels: [true, true, false],
    transactional: false,
    severity: "informational",
    optOutAllowed: true,
    throttle: NO_THROTTLE,
  },
  {
    key: "collab.invite.rejected",
    category: "collaboration",
    audiences: ORGANIZER,
    channels: [true, true, false],
    transactional: false,
    severity: "informational",
    optOutAllowed: true,
    throttle: NO_THROTTLE,
  },
  {
    key: "collab.invite.revoked",
    category: "collaboration",
    audiences: ["co_organizer"],
    channels: [true, true, false],
    transactional: false,
    severity: "important",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "collab.invite.expired",
    category: "collaboration",
    audiences: ["co_organizer", "organizer"],
    channels: [true, false, false],
    transactional: false,
    severity: "informational",
    optOutAllowed: true,
    throttle: NO_THROTTLE,
  },
  {
    key: "collab.member.removed",
    category: "collaboration",
    audiences: ["co_organizer"],
    channels: [true, true, false],
    transactional: false,
    severity: "important",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "collab.member.removed.ack",
    category: "collaboration",
    audiences: ORGANIZER,
    channels: [true, false, false],
    transactional: false,
    severity: "informational",
    optOutAllowed: true,
    throttle: NO_THROTTLE,
  },

  // §4.7 Uploads & processing.
  {
    key: "upload.batch.completed",
    category: "pipeline",
    audiences: ORGANIZERS,
    channels: [true, true, false],
    transactional: false,
    severity: "informational",
    optOutAllowed: true,
    throttle: rate(1),
  },
  {
    key: "upload.batch.completed_with_errors",
    category: "pipeline",
    audiences: ORGANIZERS,
    channels: [true, true, false],
    transactional: false,
    severity: "important",
    optOutAllowed: false,
    throttle: rate(1),
  },
  {
    key: "upload.batch.files_rejected",
    category: "pipeline",
    audiences: ORGANIZERS,
    channels: [true, false, false],
    transactional: false,
    severity: "informational",
    optOutAllowed: true,
    throttle: NO_THROTTLE,
  },
  {
    key: "upload.session.stalled",
    category: "pipeline",
    audiences: ORGANIZERS,
    channels: [true, true, false],
    transactional: false,
    severity: "important",
    optOutAllowed: true,
    throttle: rate(1),
  },
  {
    key: "upload.blocked.quota",
    category: "pipeline",
    audiences: ORGANIZERS,
    channels: [true, true, false],
    transactional: false,
    severity: "critical",
    optOutAllowed: false,
    throttle: rate(1, 6),
  },
  {
    key: "pipeline.event.indexed",
    category: "pipeline",
    audiences: ORGANIZERS,
    channels: [true, true, false],
    transactional: false,
    severity: "informational",
    optOutAllowed: true,
    throttle: rate(1, 6),
  },
  {
    key: "pipeline.image.failed",
    category: "pipeline",
    audiences: ORGANIZER,
    channels: [true, true, false],
    transactional: false,
    severity: "important",
    optOutAllowed: false,
    throttle: digest(24),
  },
  {
    key: "pipeline.delayed",
    category: "pipeline",
    audiences: ORGANIZER,
    channels: [true, false, false],
    transactional: false,
    severity: "important",
    optOutAllowed: false,
    throttle: rate(1, 6),
  },

  // §4.8 Attendee experience.
  {
    key: "attendee.selfie.accepted",
    category: "matching",
    audiences: ATTENDEE,
    channels: [true, false, false],
    transactional: false,
    severity: "informational",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "attendee.selfie.rejected",
    category: "matching",
    audiences: ATTENDEE,
    channels: [true, true, false],
    transactional: false,
    severity: "important",
    optOutAllowed: false,
    throttle: rate(1),
  },
  {
    key: "attendee.matches.ready",
    category: "matching",
    audiences: ATTENDEE,
    channels: [true, true, true],
    transactional: true,
    severity: "important",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
    dedupe: { keyTemplate: "{typeKey}:{profileId}", windowHours: null },
  },
  {
    key: "attendee.matches.new",
    category: "matching",
    audiences: ATTENDEE,
    channels: [true, true, false],
    transactional: false,
    severity: "informational",
    optOutAllowed: true,
    throttle: digest(6),
  },
  {
    key: "attendee.matches.none_found",
    category: "matching",
    audiences: ATTENDEE,
    channels: [true, true, false],
    transactional: false,
    severity: "informational",
    optOutAllowed: true,
    throttle: rate(1),
  },
  {
    key: "attendee.event.linked",
    category: "matching",
    audiences: ATTENDEE,
    channels: [true, false, false],
    transactional: false,
    severity: "informational",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "attendee.gallery.expiring",
    category: "matching",
    audiences: ATTENDEE,
    channels: [true, true, true],
    transactional: false,
    severity: "critical",
    optOutAllowed: false,
    throttle: rate(2),
  },
  {
    key: "attendee.download.ready",
    category: "matching",
    audiences: ATTENDEE,
    channels: [true, true, false],
    transactional: false,
    severity: "important",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "attendee.consent.receipt",
    category: "matching",
    audiences: ATTENDEE,
    channels: [false, true, false],
    transactional: true,
    severity: "important",
    optOutAllowed: false,
    throttle: rate(1),
  },

  // §4.9 Legal & privacy.
  {
    key: "legal.terms.updated",
    category: "compliance",
    audiences: ACCOUNT_HOLDERS,
    channels: [true, true, false],
    transactional: true,
    severity: "important",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "privacy.dsr.received",
    category: "compliance",
    audiences: ACCOUNT_HOLDERS,
    channels: [true, true, false],
    transactional: true,
    severity: "important",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "privacy.export.ready",
    category: "compliance",
    audiences: ACCOUNT_HOLDERS,
    channels: [true, true, false],
    transactional: true,
    severity: "important",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "privacy.erasure.completed",
    category: "compliance",
    audiences: ACCOUNT_HOLDERS,
    channels: [false, true, false],
    transactional: true,
    severity: "critical",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },

  // §4.10 Platform operations.
  {
    key: "admin.invite.sent",
    category: "platform_ops",
    audiences: ADMIN,
    channels: [true, true, true],
    transactional: false,
    severity: "important",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "admin.abuse.flagged",
    category: "platform_ops",
    audiences: ADMIN,
    channels: [true, true, false],
    transactional: false,
    severity: "important",
    optOutAllowed: true,
    throttle: digest(1),
  },
  {
    key: "admin.queue.backlog",
    category: "platform_ops",
    audiences: ADMIN,
    channels: [true, true, true],
    transactional: false,
    severity: "critical",
    optOutAllowed: false,
    throttle: rate(1),
  },
  {
    key: "admin.provider.failing",
    category: "platform_ops",
    audiences: ADMIN,
    channels: [true, true, true],
    transactional: false,
    severity: "critical",
    optOutAllowed: false,
    throttle: rate(1),
  },
  {
    key: "admin.billing.manual_review",
    category: "platform_ops",
    audiences: ADMIN,
    channels: [true, true, false],
    transactional: false,
    severity: "important",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
  {
    key: "admin.dsr.sla_risk",
    category: "platform_ops",
    audiences: ADMIN,
    channels: [true, true, false],
    transactional: false,
    severity: "important",
    optOutAllowed: false,
    throttle: digest(24),
  },
  {
    key: "admin.plan.modified",
    category: "platform_ops",
    audiences: ADMIN,
    channels: [true, true, false],
    transactional: false,
    severity: "important",
    optOutAllowed: false,
    throttle: NO_THROTTLE,
  },
];

/**
 * The frozen 81 contract `typeKey`s (contract §7.6), in catalogue order.
 *
 * U1 asserts this set equals the inlined contract list exactly — a change is a
 * deliberate contract change, never something to absorb silently.
 */
export const NOTIFICATION_TYPE_KEYS: readonly string[] = TYPE_SPECS.map((spec) => spec.key);

/** One validated {@link NotificationType} per {@link NOTIFICATION_TYPE_KEYS} entry. */
export const SEED_NOTIFICATION_TYPES: readonly NotificationType[] = TYPE_SPECS.map(build);
