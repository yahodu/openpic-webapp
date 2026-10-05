/**
 * Notification type / routing fixtures (schema §19.1–§19.2).
 *
 * The `notificationTypes` catalogue is seed data transcribed from the §4 matrix,
 * so every spec that exercises one type needs a complete, schema-shaped document
 * to state only the field under test. These builders are deliberately **plain
 * objects that are not parsed**: the whole point of U7 is to hand a *malformed*
 * template to the Zod schema, and a factory that parsed its own output could not
 * produce one.
 */
import type { ChannelGroup, NotificationType } from "@/server/notifications/notification-types";
import type { NotificationTemplate } from "@/server/notifications/notification-templates";

/** The three routing channel groups (design §1, §1.1). */
type GroupName = "in_app" | "email" | "mobile";

/** Per-group overrides accepted by {@link makeChannelGroups}. */
export interface ChannelGroupOverrides {
  readonly in_app?: Partial<ChannelGroup>;
  readonly email?: Partial<ChannelGroup>;
  readonly mobile?: Partial<ChannelGroup>;
}

/**
 * Build the standard three-group routing block: `in_app`/`email` as
 * single-member groups, `mobile` carrying the ordered WhatsApp→SMS candidates.
 *
 * @param overrides - Per-group fields to replace or disable.
 * @returns A channel-group array in `in_app`, `email`, `mobile` order.
 */
export function makeChannelGroups(overrides: ChannelGroupOverrides = {}): ChannelGroup[] {
  const inApp: ChannelGroup = {
    enabled: true,
    optOutAllowed: false,
    ...overrides.in_app,
    group: "in_app" satisfies GroupName,
  };
  const email: ChannelGroup = {
    enabled: true,
    optOutAllowed: false,
    ...overrides.email,
    group: "email" satisfies GroupName,
  };
  const mobile: ChannelGroup = {
    enabled: true,
    optOutAllowed: false,
    candidates: ["whatsapp", "sms"],
    strategy: "first_eligible",
    ...overrides.mobile,
    group: "mobile" satisfies GroupName,
  };

  return [inApp, email, mobile];
}

/**
 * Build a complete `notificationTypes` document.
 *
 * @param overrides - Fields to replace on the baseline.
 * @returns A valid notification type.
 */
export function makeNotificationType(overrides: Partial<NotificationType> = {}): NotificationType {
  const typeKey = overrides.typeKey ?? "attendee.matches.ready";
  return {
    typeKey,
    category: "matching",
    audiences: ["attendee_identified"],
    channelGroups: makeChannelGroups(),
    transactional: false,
    severity: "informational",
    respectQuietHours: true,
    throttle: { strategy: "none" },
    dedupe: { keyTemplate: null, windowHours: null },
    retainBody: true,
    actionable: false,
    enabled: true,
    version: 1,
    ...overrides,
  };
}

/**
 * Build a complete `notificationTemplates` document.
 *
 * @param overrides - Fields to replace on the baseline.
 * @returns A valid template.
 */
export function makeNotificationTemplate(
  overrides: Partial<NotificationTemplate> = {}
): NotificationTemplate {
  return {
    typeKey: "attendee.matches.ready",
    channel: "email",
    locale: "en-IN",
    subjectTemplate: "{{count}} photos of you",
    bodyTemplate: "{{count}} photos of you from {{eventName}}. See them at {{galleryUrl}}.",
    variables: ["count", "eventName", "galleryUrl"],
    providerRefs: { whatsappTemplateName: null },
    version: 1,
    active: true,
    ...overrides,
  };
}
