import { z } from "zod";

/**
 * The `notificationTypes` routing catalogue schema (OP-84, schema §19.1,
 * contract §7.6).
 *
 * The routing matrix is **stored as data, not code** (design §8): Novu holds no
 * routing knowledge, and `GET /api/v1/notification-types` serves these documents
 * verbatim, so the seed is the single source of truth for every channel,
 * candidate order, opt-out rule, throttle and dedupe key. The schema is the gate
 * a seed (or an admin edit, later) must pass before a document reaches the
 * database — a malformed row is rejected here rather than mis-routing a
 * production notification.
 *
 * The stored document is deliberately **non-strict**: a document read back from
 * Mongo carries the driver's `_id`, which a default (strip) object tolerates, and
 * `label`/`description` are optional projections owned by the read route (ADR-0016
 * "Label / description").
 */

/** The ten contract categories (contract §7.6). */
export const notificationCategorySchema = z.enum([
  "authentication",
  "account",
  "billing",
  "usage",
  "event",
  "collaboration",
  "pipeline",
  "matching",
  "compliance",
  "platform_ops",
]);

/** The audience tags a type may target (design §2). */
export const notificationAudienceSchema = z.enum([
  "organizer",
  "co_organizer",
  "attendee_identified",
  "attendee_anonymous",
  "platform_admin",
  "billing_contact",
]);

/** The severity vocabulary (schema §19.1): `critical` bypasses quiet hours. */
export const notificationSeveritySchema = z.enum(["critical", "important", "informational"]);

/** The three routing channel groups (design §1.1). */
export const notificationChannelSchema = z.enum(["in_app", "email", "mobile"]);

/** The concrete providers a `mobile` group may resolve to, in order (design §1.1). */
export const mobileCandidateSchema = z.enum(["whatsapp", "sms"]);

/**
 * One channel group of the routing decision (schema §19.1, design §1.1).
 *
 * `candidates` + `strategy` are only meaningful on a `mobile` group (the
 * single-member `in_app`/`email` groups have exactly one code path); they are
 * optional so a disabled group can omit them. An **enabled** `mobile` group is
 * an exception the refinement below enforces: it must declare at least one
 * `candidates` provider and `strategy: "first_eligible"`, otherwise the resolver
 * would have no route to attempt. The seed's `build()` always populates both, so
 * this is the reusable gate for an admin template/type editor.
 */
export const channelGroupSchema = z
  .object({
    group: notificationChannelSchema,
    enabled: z.boolean(),
    optOutAllowed: z.boolean(),
    candidates: z.array(mobileCandidateSchema).min(1).optional(),
    strategy: z.enum(["first_eligible"]).optional(),
  })
  .superRefine((group, ctx) => {
    if (group.group !== "mobile" || !group.enabled) return;

    if (group.candidates === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "an enabled mobile group must declare at least one candidate",
      });
    }

    if (group.strategy === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["strategy"],
        message: 'an enabled mobile group must declare strategy "first_eligible"',
      });
    }
  });

/** How overflow is handled (design §6). */
export const throttleStrategySchema = z.enum(["none", "rate_limit", "digest", "coalesce"]);

/**
 * A type's throttle policy (design §6).
 *
 * `none` means every occurrence is delivered; `rate_limit` drops over budget;
 * `digest` accumulates into a `notificationDigests` bucket; `coalesce` merges
 * occurrences within `windowHours` into the row already on the feed.
 */
export const throttleSchema = z.object({
  strategy: throttleStrategySchema,
  maxPerWindow: z.number().int().positive().optional(),
  windowHours: z.number().positive().nullable().optional(),
});

/** A dedupe rule (design §6). `windowHours: null` means "forever". */
export const dedupeSchema = z.object({
  keyTemplate: z.string().min(1).nullable(),
  windowHours: z.number().positive().nullable(),
});

/**
 * A stored `notificationTypes` document (schema §19.1).
 *
 * Every field is required except `label`/`description` (read-route projections)
 * and the mobile-only group fields; `version` is the audit signal of a routing
 * change.
 */
export const notificationTypeSchema = z.object({
  typeKey: z.string().min(1),
  category: notificationCategorySchema,
  audiences: z.array(notificationAudienceSchema).min(1),
  channelGroups: z.array(channelGroupSchema),
  transactional: z.boolean(),
  severity: notificationSeveritySchema,
  respectQuietHours: z.boolean(),
  throttle: throttleSchema,
  dedupe: dedupeSchema,
  retainBody: z.boolean(),
  actionable: z.boolean(),
  enabled: z.boolean(),
  version: z.number().int().min(1),
  label: z.string().optional(),
  description: z.string().optional(),
});

/** A validated stored notification type. */
export type NotificationType = z.infer<typeof notificationTypeSchema>;

/** A validated channel group. */
export type ChannelGroup = z.infer<typeof channelGroupSchema>;

/** A validated notification category. */
export type NotificationCategory = z.infer<typeof notificationCategorySchema>;

/** A validated notification severity. */
export type NotificationSeverity = z.infer<typeof notificationSeveritySchema>;

/** A validated audience tag. */
export type NotificationAudience = z.infer<typeof notificationAudienceSchema>;

/** A validated throttle policy. */
export type NotificationThrottle = z.infer<typeof throttleSchema>;

/** A validated dedupe rule. */
export type NotificationDedupe = z.infer<typeof dedupeSchema>;
