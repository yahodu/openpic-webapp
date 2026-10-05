import { z } from "zod";

/**
 * The `notificationTypes` routing catalogue schema (schema §19.1, design §1/§4).
 *
 * `notificationTypes` is the §4 routing matrix **stored as data**: each document
 * is the single copy of "which channel groups apply to this notification type",
 * so the routing resolver reads these rows instead of hard-coding policy and the
 * message transport (Novu) holds no routing knowledge (§8). The schema is the
 * gate a seed or an admin edit must pass before a document reaches the
 * database — a malformed type is rejected here rather than mis-routing a
 * production notification.
 *
 * Exports:
 *
 *   - {@link channelGroupSchema} — one routing group (`in_app` | `email` |
 *     `mobile`) with its enable/opt-out flags and, for a multi-candidate group,
 *     the ordered transport candidates and strategy (§1.1);
 *   - {@link throttleSchema} — the §6 throttling strategy for the type;
 *   - {@link dedupeSchema} — the §6 dedupe key template and window;
 *   - {@link notificationTypeSchema} — a stored type document (non-strict, so
 *     the driver's `_id` is tolerated);
 *   - the inferred types {@link NotificationType}, {@link ChannelGroup},
 *     {@link NotificationCategory}, {@link NotificationSeverity} and
 *     {@link NotificationAudience}.
 *
 * @see ADR-0016 — the routing matrix as data.
 */

/** The three routing channel groups (design §1, §1.1). */
export const channelGroupNameSchema = z.enum(["in_app", "email", "mobile"]);

/** A concrete transport candidate for the multi-member `mobile` group (§1.1). */
export const mobileCandidateSchema = z.enum(["whatsapp", "sms"]);

/** How a group with several candidates picks one (design §1.1). */
export const channelStrategySchema = z.enum(["first_eligible"]);

/**
 * One routing channel group (schema §19.1, design §1.1).
 *
 * `candidates` and `strategy` are only meaningful for a multi-member group (the
 * `mobile` group resolves `whatsapp` then `sms`), so they are optional on the
 * single-member `in_app`/`email` groups.
 */
export const channelGroupSchema = z.object({
  group: channelGroupNameSchema,
  enabled: z.boolean(),
  optOutAllowed: z.boolean(),
  candidates: z.array(mobileCandidateSchema).optional(),
  strategy: channelStrategySchema.optional(),
});

/** The §6 throttling strategy applied to a notification type. */
export const throttleSchema = z.object({
  strategy: z.enum(["none", "rate_limit", "digest"]),
});

/**
 * The §6 dedupe rule for a notification type.
 *
 * `keyTemplate` is interpolated and stored on the dispatch; `windowHours: null`
 * means the dedupe window never expires (dedupe forever).
 */
export const dedupeSchema = z.object({
  keyTemplate: z.string().nullable(),
  windowHours: z.number().int().nullable(),
});

/** The ten notification categories (schema §19.1, contract §7.6). */
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

/** Severity of a notification type (schema §19.1); `critical` bypasses quiet hours. */
export const notificationSeveritySchema = z.enum(["critical", "important", "informational"]);

/** The audience tags a type may be routed to (design §2). */
export const notificationAudienceSchema = z.enum([
  "organizer",
  "co_organizer",
  "attendee_identified",
  "attendee_anonymous",
  "platform_admin",
  "billing_contact",
]);

/**
 * A stored `notificationTypes` document (schema §19.1).
 *
 * Non-strict by design: a document read back from Mongo carries the driver's
 * `_id`, which a default (strip) object tolerates. `label` and `description`
 * are optional — they are served by `GET /api/v1/notification-types`, whose
 * projection story owns their requiredness (ADR-0016).
 */
export const notificationTypeSchema = z.object({
  typeKey: z.string().min(1),
  category: notificationCategorySchema,
  audiences: z.array(notificationAudienceSchema),
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
  updatedAt: z.date().optional(),
  updatedByUserId: z.string().optional(),
});

/** A validated routing channel group. */
export type ChannelGroup = z.infer<typeof channelGroupSchema>;

/** A validated notification category. */
export type NotificationCategory = z.infer<typeof notificationCategorySchema>;

/** A validated notification severity. */
export type NotificationSeverity = z.infer<typeof notificationSeveritySchema>;

/** A validated notification audience tag. */
export type NotificationAudience = z.infer<typeof notificationAudienceSchema>;

/** A validated stored `notificationTypes` document. */
export type NotificationType = z.infer<typeof notificationTypeSchema>;
