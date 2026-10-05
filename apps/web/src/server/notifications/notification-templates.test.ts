import { describe, expect, it } from "vitest";

import { SEED_NOTIFICATION_TYPES } from "@/server/notifications/notification-types.values";
import {
  notificationTemplateSchema,
  type NotificationTemplate,
} from "@/server/notifications/notification-templates";
import { SEED_NOTIFICATION_TEMPLATES } from "@/server/notifications/notification-templates.values";

import { makeNotificationTemplate } from "../../test/factories/notification";

/**
 * Unit contract — the `notificationTemplates` catalogue (schema §19.2, contract
 * §7.6).
 *
 * Templates are first-party copy keyed by `(typeKey, channel, locale)`. The
 * `variables[]` array exists so a missing or unused placeholder is caught here
 * — against the seed — rather than shipping an email that says "Hi
 * {{firstName}}". Every enabled routing group must resolve to an active `en-IN`
 * template, and no template may interpolate a raw credential (only the
 * purpose-built link variables the notification service hands it).
 *
 * Contract expected of the implementation:
 *
 *   @/server/notifications/notification-templates
 *     notificationTemplateSchema : Zod schema of a stored template; its
 *                                  refinement rejects a template whose declared
 *                                  `variables[]` do not equal the placeholders
 *                                  actually used (both missing and unused fail)
 *     type NotificationTemplate
 *   @/server/notifications/notification-templates.values
 *     SEED_NOTIFICATION_TEMPLATES : readonly NotificationTemplate[]
 *
 * `channel` on a template names the routing **group** the copy serves
 * (`in_app` | `email` | `mobile`), matching `channelGroups[].group`; the
 * WhatsApp-vs-SMS split is a `channelGroups[].candidates` concern, not a
 * template concern named here. See ADR-0016.
 */

/** The template channel is the routing group. */
const LOCALE = "en-IN";

/** Sensitive placeholder names that must never appear in first-party copy. */
const FORBIDDEN_VARIABLE = /token|secret|password|passwd|api[_-]?key|signature|\bsig\b|bearer/i;

/** Every template rendered to a single searchable string. */
function renderable(template: NotificationTemplate): string {
  return `${template.subjectTemplate}\n${template.bodyTemplate}`;
}

describe("template variable contract (U7, AC3)", () => {
  it("U7: rejects a template that uses a placeholder it did not declare", () => {
    const template = makeNotificationTemplate({
      subjectTemplate: "{{count}} photos of you",
      bodyTemplate: "See them at {{galleryUrl}}.",
      variables: ["count"],
    });

    const result = notificationTemplateSchema.safeParse(template);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain("variables");
    }
  });

  it("U7: rejects a template that declares a variable it never uses", () => {
    const template = makeNotificationTemplate({
      subjectTemplate: "{{count}} photos of you",
      bodyTemplate: "See them at {{galleryUrl}}.",
      variables: ["count", "galleryUrl", "eventName"],
    });

    const result = notificationTemplateSchema.safeParse(template);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain("variables");
    }
  });

  it("U7: accepts a template whose declared variables equal those used", () => {
    const template = makeNotificationTemplate();

    expect(notificationTemplateSchema.safeParse(template).success).toBe(true);
  });

  it("U7: every seeded template declares exactly the variables it uses", () => {
    for (const template of SEED_NOTIFICATION_TEMPLATES) {
      const result = notificationTemplateSchema.safeParse(template);

      expect(
        result.success,
        `${template.typeKey}:${template.channel}:${result.error?.message ?? ""}`
      ).toBe(true);
    }
  });
});

describe("template coverage (AC2)", () => {
  it("AC2: every enabled routing group has an active en-IN template", () => {
    for (const type of SEED_NOTIFICATION_TYPES) {
      for (const group of type.channelGroups) {
        if (!group.enabled) continue;

        const match = SEED_NOTIFICATION_TEMPLATES.find(
          (template) =>
            template.typeKey === type.typeKey &&
            template.channel === group.group &&
            template.locale === LOCALE &&
            template.active
        );

        expect(match, `${type.typeKey}:${group.group}`).toBeDefined();
      }
    }
  });

  it("AC2: no active template exists for a disabled routing group", () => {
    for (const type of SEED_NOTIFICATION_TYPES) {
      for (const group of type.channelGroups) {
        if (group.enabled) continue;

        const match = SEED_NOTIFICATION_TEMPLATES.find(
          (template) =>
            template.typeKey === type.typeKey &&
            template.channel === group.group &&
            template.locale === LOCALE &&
            template.active
        );

        expect(match, `${type.typeKey}:${group.group}`).toBeUndefined();
      }
    }
  });

  it("AC2: the seed ships exactly one active template per enabled (typeKey, group)", () => {
    const expected = SEED_NOTIFICATION_TYPES.flatMap((type) =>
      type.channelGroups
        .filter((group) => group.enabled)
        .map((group) => `${type.typeKey}:${group.group}`)
    ).sort();

    const actual = SEED_NOTIFICATION_TEMPLATES.filter((template) => template.active)
      .map((template) => `${template.typeKey}:${template.channel}`)
      .sort();

    expect(actual).toEqual(expected);
  });

  it("AC1: every template's typeKey is a contract notification type", () => {
    const known = new Set(SEED_NOTIFICATION_TYPES.map((type) => type.typeKey));

    for (const template of SEED_NOTIFICATION_TEMPLATES) {
      expect(known.has(template.typeKey), template.typeKey).toBe(true);
    }
  });
});

describe("downgrade reassurance copy (U8)", () => {
  it("U8: every billing.subscription.downgraded template says nothing has been deleted", () => {
    const downgraded = SEED_NOTIFICATION_TEMPLATES.filter(
      (template) => template.typeKey === "billing.subscription.downgraded"
    );

    expect(downgraded.length).toBeGreaterThan(0);

    for (const template of downgraded) {
      expect(
        renderable(template).toLowerCase(),
        `${template.typeKey}:${template.channel}`
      ).toContain("nothing has been deleted");
    }
  });
});

describe("no raw secrets in first-party copy (E2E)", () => {
  it("E2E: no template interpolates a raw credential placeholder", () => {
    for (const template of SEED_NOTIFICATION_TEMPLATES) {
      const leaked = template.variables.filter((variable) => FORBIDDEN_VARIABLE.test(variable));

      expect(leaked, `${template.typeKey}:${template.channel}`).toEqual([]);
    }
  });

  it("E2E: every link/URL variable is a purpose-built name ending in Url or Link", () => {
    for (const template of SEED_NOTIFICATION_TEMPLATES) {
      const linkLike = template.variables.filter((variable) => /url|link/i.test(variable));

      for (const variable of linkLike) {
        expect(variable, `${template.typeKey}:${template.channel}`).toMatch(/(Url|Link)$/);
      }
    }
  });
});
