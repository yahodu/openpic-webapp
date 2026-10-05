import { describe, expect, it } from "vitest";

import type {
  NotificationCategory,
  NotificationType,
} from "@/server/notifications/notification-types";
import { SEED_NOTIFICATION_TYPES } from "@/server/notifications/notification-types.values";
import { SEED_NOTIFICATION_TEMPLATES } from "@/server/notifications/notification-templates.values";

import { requireType } from "../../test/factories/notification";

/**
 * Table-driven contract — the §4 routing matrix, transcribed key by key.
 *
 * `notification-types.test.ts` pins the *structural* invariants (U1–U9) and a
 * handful of specific rows. This spec closes the remaining drift gap: it
 * transcribes the **whole** §4 matrix (all 81 rows) into an expected table and
 * asserts `SEED_NOTIFICATION_TYPES`/`SEED_NOTIFICATION_TEMPLATES` against it, so
 * a future edit to `notification-types.values.ts` that silently mis-routes,
 * re-enables opted-out mail or drops a template fails here rather than reaching
 * a provider (design §8, ADR-0016 "Coverage gap").
 *
 * The expected values are **inlined** — never a Vitest snapshot. A snapshot is
 * written on first run and would therefore pass before the seed exists, making
 * the red state vacuous and absorbing an unintended change silently
 * (ADR-0016 "The frozen 81-key list is inlined, never snapshotted").
 *
 * Column mapping from design §4:
 * - `channels` is `[in_app, email, mobile]`; `⚙️` (conditional) is treated as an
 *   **enabled** group because `channelGroups[].enabled` is a boolean and the
 *   conditional rule (e.g. "mobile only at T-24h") is a resolver concern, not a
 *   per-type toggle. Flagged as an assumption in the ADR.
 * - `optOutAllowed` is the §4 **Opt-out** column: `Yes` → `true`, `No` →
 *   `false`; `"Yes (80 % only)"` is opt-out-allowed → `true`.
 * - `throttle` maps the §4 **Throttle** column onto `throttle.strategy`:
 *   `—` and quota-folded rows → `none`; any `N/…` budget → `rate_limit`;
 *   "…digest" → `digest`; "coalesce N min" → `coalesce`. A row whose §4 basis is
 *   *dedupe* (`attendee.matches.ready`, "once per attendee+event (dedupe)") is
 *   `none` under §6, because dedupe is a separate mechanism from rate limiting.
 * - Severity is pinned only for `authentication`, where §4.1 states every type
 *   is `critical` (the per-category severities for non-auth types are not
 *   normative in §4 and are owned by a later story).
 */

type ThrottleStrategy = "none" | "rate_limit" | "digest" | "coalesce";

interface MatrixRow {
  readonly key: string;
  readonly category: NotificationCategory;
  /** `[in_app, email, mobile]` — enabled groups, transcribed from §4. */
  readonly channels: readonly [boolean, boolean, boolean];
  /** The §4 Opt-out column, before the transactional/in_app overrides. */
  readonly optOutAllowed: boolean;
  readonly throttle: ThrottleStrategy;
}

/** Design §4, all 81 rows, in contract §7.6 order (grouped by category). */
const MATRIX = [
  // §4.1 Authentication & security — all transactional, severity critical.
  {
    key: "auth.otp.email.requested",
    category: "authentication",
    channels: [false, true, false],
    optOutAllowed: false,
    throttle: "rate_limit",
  },
  {
    key: "auth.otp.mobile.requested",
    category: "authentication",
    channels: [false, false, true],
    optOutAllowed: false,
    throttle: "rate_limit",
  },
  {
    key: "auth.signin.new_device",
    category: "authentication",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "rate_limit",
  },
  {
    key: "auth.2fa.enabled",
    category: "authentication",
    channels: [true, true, true],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "auth.2fa.disabled",
    category: "authentication",
    channels: [true, true, true],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "auth.contact.changed",
    category: "authentication",
    channels: [true, true, true],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "auth.account.completed",
    category: "authentication",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "auth.suspicious.blocked",
    category: "authentication",
    channels: [true, true, true],
    optOutAllowed: false,
    throttle: "rate_limit",
  },
  {
    key: "auth.admin.signin",
    category: "authentication",
    channels: [true, true, true],
    optOutAllowed: false,
    throttle: "none",
  },

  // §4.2 Account lifecycle.
  {
    key: "account.welcome",
    category: "account",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "rate_limit",
  },
  {
    key: "account.verification.incomplete",
    category: "account",
    channels: [true, true, false],
    optOutAllowed: true,
    throttle: "rate_limit",
  },
  {
    key: "account.deletion.requested",
    category: "account",
    channels: [true, true, true],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "account.deletion.completed",
    category: "account",
    channels: [false, true, false],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "account.sessions.revoked",
    category: "account",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "none",
  },

  // §4.3 Billing & subscription — recipient always the billing contact.
  {
    key: "billing.mandate.pending",
    category: "billing",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "billing.mandate.failed",
    category: "billing",
    channels: [true, true, true],
    optOutAllowed: false,
    throttle: "rate_limit",
  },
  {
    key: "billing.subscription.activated",
    category: "billing",
    channels: [true, true, true],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "billing.renewal.upcoming",
    category: "billing",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "rate_limit",
  },
  {
    key: "billing.payment.succeeded",
    category: "billing",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "billing.payment.failed",
    category: "billing",
    channels: [true, true, true],
    optOutAllowed: false,
    throttle: "rate_limit",
  },
  {
    key: "billing.grace.reminder",
    category: "billing",
    channels: [true, true, true],
    optOutAllowed: false,
    throttle: "rate_limit",
  },
  {
    key: "billing.subscription.downgraded",
    category: "billing",
    channels: [true, true, true],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "billing.subscription.reactivated",
    category: "billing",
    channels: [true, true, true],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "billing.plan.upgraded",
    category: "billing",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "billing.plan.downgrade_scheduled",
    category: "billing",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "billing.plan.downgrade_applied",
    category: "billing",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "billing.addon.purchased",
    category: "billing",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "billing.invoice.issued",
    category: "billing",
    channels: [true, true, false],
    optOutAllowed: true,
    throttle: "none",
  },
  {
    key: "billing.subscription.cancelled",
    category: "billing",
    channels: [true, true, true],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "billing.refund.processed",
    category: "billing",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "none",
  },

  // §4.4 Usage & entitlements.
  {
    key: "usage.storage.threshold",
    category: "usage",
    channels: [true, true, false],
    optOutAllowed: true,
    throttle: "rate_limit",
  },
  {
    key: "usage.events.threshold",
    category: "usage",
    channels: [true, true, false],
    optOutAllowed: true,
    throttle: "rate_limit",
  },
  {
    key: "usage.action.blocked",
    category: "usage",
    channels: [true, false, false],
    optOutAllowed: false,
    throttle: "rate_limit",
  },
  {
    key: "usage.limit.restored",
    category: "usage",
    channels: [true, false, false],
    optOutAllowed: false,
    throttle: "none",
  },

  // §4.5 Event lifecycle.
  {
    key: "event.created",
    category: "event",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "event.details.updated",
    category: "event",
    channels: [true, true, false],
    optOutAllowed: true,
    throttle: "coalesce",
  },
  {
    key: "event.starting_soon",
    category: "event",
    channels: [true, true, false],
    optOutAllowed: true,
    throttle: "none",
  },
  {
    key: "event.ended",
    category: "event",
    channels: [true, true, false],
    optOutAllowed: true,
    throttle: "none",
  },
  {
    key: "event.upload_window.closing",
    category: "event",
    channels: [true, true, true],
    optOutAllowed: false,
    throttle: "rate_limit",
  },
  {
    key: "event.upload_window.closed",
    category: "event",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "event.link.rotated",
    category: "event",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "event.archived",
    category: "event",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "event.deleted",
    category: "event",
    channels: [true, true, true],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "event.retention.expiring",
    category: "event",
    channels: [true, true, true],
    optOutAllowed: false,
    throttle: "rate_limit",
  },
  {
    key: "event.attendee.milestone",
    category: "event",
    channels: [true, false, false],
    optOutAllowed: true,
    throttle: "digest",
  },

  // §4.6 Collaboration.
  {
    key: "collab.invite.sent",
    category: "collaboration",
    channels: [true, true, true],
    optOutAllowed: false,
    throttle: "rate_limit",
  },
  {
    key: "collab.invite.reminder",
    category: "collaboration",
    channels: [true, true, false],
    optOutAllowed: true,
    throttle: "rate_limit",
  },
  {
    key: "collab.invite.accepted",
    category: "collaboration",
    channels: [true, true, false],
    optOutAllowed: true,
    throttle: "none",
  },
  {
    key: "collab.invite.rejected",
    category: "collaboration",
    channels: [true, true, false],
    optOutAllowed: true,
    throttle: "none",
  },
  {
    key: "collab.invite.revoked",
    category: "collaboration",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "collab.invite.expired",
    category: "collaboration",
    channels: [true, false, false],
    optOutAllowed: true,
    throttle: "none",
  },
  {
    key: "collab.member.removed",
    category: "collaboration",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "collab.member.removed.ack",
    category: "collaboration",
    channels: [true, false, false],
    optOutAllowed: true,
    throttle: "none",
  },

  // §4.7 Uploads & processing.
  {
    key: "upload.batch.completed",
    category: "pipeline",
    channels: [true, true, false],
    optOutAllowed: true,
    throttle: "rate_limit",
  },
  {
    key: "upload.batch.completed_with_errors",
    category: "pipeline",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "rate_limit",
  },
  {
    key: "upload.batch.files_rejected",
    category: "pipeline",
    channels: [true, false, false],
    optOutAllowed: true,
    throttle: "none",
  },
  {
    key: "upload.session.stalled",
    category: "pipeline",
    channels: [true, true, false],
    optOutAllowed: true,
    throttle: "rate_limit",
  },
  {
    key: "upload.blocked.quota",
    category: "pipeline",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "rate_limit",
  },
  {
    key: "pipeline.event.indexed",
    category: "pipeline",
    channels: [true, true, false],
    optOutAllowed: true,
    throttle: "rate_limit",
  },
  {
    key: "pipeline.image.failed",
    category: "pipeline",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "digest",
  },
  {
    key: "pipeline.delayed",
    category: "pipeline",
    channels: [true, false, false],
    optOutAllowed: false,
    throttle: "rate_limit",
  },

  // §4.8 Attendee experience.
  {
    key: "attendee.selfie.accepted",
    category: "matching",
    channels: [true, false, false],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "attendee.selfie.rejected",
    category: "matching",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "rate_limit",
  },
  {
    key: "attendee.matches.ready",
    category: "matching",
    channels: [true, true, true],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "attendee.matches.new",
    category: "matching",
    channels: [true, true, false],
    optOutAllowed: true,
    throttle: "digest",
  },
  {
    key: "attendee.matches.none_found",
    category: "matching",
    channels: [true, true, false],
    optOutAllowed: true,
    throttle: "rate_limit",
  },
  {
    key: "attendee.event.linked",
    category: "matching",
    channels: [true, false, false],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "attendee.gallery.expiring",
    category: "matching",
    channels: [true, true, true],
    optOutAllowed: false,
    throttle: "rate_limit",
  },
  {
    key: "attendee.download.ready",
    category: "matching",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "attendee.consent.receipt",
    category: "matching",
    channels: [false, true, false],
    optOutAllowed: false,
    throttle: "rate_limit",
  },

  // §4.9 Legal & privacy — §4 has no Throttle column; every occurrence is delivered.
  {
    key: "legal.terms.updated",
    category: "compliance",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "privacy.dsr.received",
    category: "compliance",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "privacy.export.ready",
    category: "compliance",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "privacy.erasure.completed",
    category: "compliance",
    channels: [false, true, false],
    optOutAllowed: false,
    throttle: "none",
  },

  // §4.10 Platform operations — audience `platform_admin`.
  {
    key: "admin.invite.sent",
    category: "platform_ops",
    channels: [true, true, true],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "admin.abuse.flagged",
    category: "platform_ops",
    channels: [true, true, false],
    optOutAllowed: true,
    throttle: "digest",
  },
  {
    key: "admin.queue.backlog",
    category: "platform_ops",
    channels: [true, true, true],
    optOutAllowed: false,
    throttle: "rate_limit",
  },
  {
    key: "admin.provider.failing",
    category: "platform_ops",
    channels: [true, true, true],
    optOutAllowed: false,
    throttle: "rate_limit",
  },
  {
    key: "admin.billing.manual_review",
    category: "platform_ops",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "none",
  },
  {
    key: "admin.dsr.sla_risk",
    category: "platform_ops",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "digest",
  },
  {
    key: "admin.plan.modified",
    category: "platform_ops",
    channels: [true, true, false],
    optOutAllowed: false,
    throttle: "none",
  },
] as const satisfies readonly MatrixRow[];

/** The routing groups, in the §4 column order. */
type GroupName = "in_app" | "email" | "mobile";

/** One channel group's routing flags. */
interface GroupView {
  readonly enabled: boolean;
  readonly optOutAllowed: boolean;
}

/** The routing flags for one group of a type; throws when the group is absent. */
function view(type: NotificationType, group: GroupName): GroupView {
  const found = type.channelGroups.find((candidate) => candidate.group === group);

  if (found === undefined) {
    throw new Error(`${type.typeKey} is missing the ${group} routing group`);
  }

  return found;
}

describe("§4 matrix — table completeness", () => {
  it("transcribes all 81 contract rows with no duplicates", () => {
    expect(MATRIX).toHaveLength(81);
    expect(new Set(MATRIX.map((row) => row.key)).size).toBe(81);
  });

  it("has one seed row per matrix row, and no extra seed rows", () => {
    expect(SEED_NOTIFICATION_TYPES.map((type) => type.typeKey).sort()).toEqual(
      MATRIX.map((row) => row.key).sort()
    );
  });
});

describe("§4 matrix — enabled groups", () => {
  it.each(MATRIX)("$key enables exactly the §4 in_app/email/mobile groups", (row) => {
    const type = requireType(row.key);
    const [inApp, email, mobile] = row.channels;

    expect(view(type, "in_app").enabled, `${row.key}:in_app`).toBe(inApp);
    expect(view(type, "email").enabled, `${row.key}:email`).toBe(email);
    expect(view(type, "mobile").enabled, `${row.key}:mobile`).toBe(mobile);
  });
});

describe("§4 matrix — opt-out", () => {
  it.each(MATRIX)("$key allows opt-out only where §4 does, and only on an enabled group", (row) => {
    const type = requireType(row.key);
    const [, email, mobile] = row.channels;

    // `in_app` is never opt-outable (U4); on email/mobile opt-out is only
    // meaningful when the group is enabled.
    expect(view(type, "in_app").optOutAllowed, `${row.key}:in_app`).toBe(false);
    expect(view(type, "email").optOutAllowed, `${row.key}:email`).toBe(email && row.optOutAllowed);
    expect(view(type, "mobile").optOutAllowed, `${row.key}:mobile`).toBe(
      mobile && row.optOutAllowed
    );
  });
});

describe("§4 matrix — throttle strategy", () => {
  it.each(MATRIX)("$key uses the §4 throttle strategy", (row) => {
    expect(requireType(row.key).throttle.strategy, row.key).toBe(row.throttle);
  });
});

describe("§4.1 severity — all authentication types are critical", () => {
  const AUTH_ROWS = MATRIX.filter((row) => row.category === "authentication");

  it("has nine authentication rows to check", () => {
    expect(AUTH_ROWS).toHaveLength(9);
  });

  it.each(AUTH_ROWS)("$key is severity critical", (row) => {
    expect(requireType(row.key).severity, row.key).toBe("critical");
  });
});

describe("§4 matrix — template correspondence", () => {
  it.each(MATRIX)("$key has an active en-IN template exactly for each enabled group", (row) => {
    const activeTemplates = SEED_NOTIFICATION_TEMPLATES.filter(
      (template) => template.typeKey === row.key && template.locale === "en-IN" && template.active
    );
    const [inApp, email, mobile] = row.channels;

    expect(
      activeTemplates.some((template) => template.channel === "in_app"),
      `${row.key}:in_app`
    ).toBe(inApp);
    expect(
      activeTemplates.some((template) => template.channel === "email"),
      `${row.key}:email`
    ).toBe(email);
    expect(
      activeTemplates.some((template) => template.channel === "mobile"),
      `${row.key}:mobile`
    ).toBe(mobile);
  });
});
