import type { ChannelGroup } from "./notification-types";
import { type NotificationTemplate, notificationTemplateSchema } from "./notification-templates";
import { SEED_NOTIFICATION_TYPES } from "./notification-types.values";

/**
 * The seeded `notificationTemplates` catalogue (OP-84, schema §19.2, contract
 * §7.6).
 *
 * One active `en-IN` template per **enabled** routing group, derived from
 * {@link SEED_NOTIFICATION_TYPES} so a template can never drift from the
 * channel it serves: enabling an email group in the matrix and forgetting its
 * copy fails AC2. A template's `channel` is the routing *group*
 * (`in_app` | `email` | `mobile`), per ADR-0016 — the WhatsApp-vs-SMS split is a
 * `channelGroups[].candidates` concern.
 *
 * ## Copy is a placeholder
 *
 * The card's acceptance criteria pin template **structure** (one per enabled
 * group, declared variables equal to those used, the downgrade reassurance, no
 * raw credential placeholder). It does not pin the marketing copy itself, which
 * is product-owned. The bodies below are **TODO(product)** scaffolding: a
 * humanised label plus a channel-appropriate call to action, with every
 * `variables[]` entry parsed from the placeholders actually used so the schema
 * refinement holds by construction. Replace with real copy before launch.
 */

/** The single locale shipped in v1. */
const LOCALE = "en-IN";

/** The downgrade type whose copy must reassure the user (U8). */
const DOWNGRADED_TYPE_KEY = "billing.subscription.downgraded";

/** The reassurance sentence every `billing.subscription.downgraded` template must carry (U8). */
const DOWNGRADE_REASSURANCE = "Nothing has been deleted.";

/** Matches a `{{name}}` placeholder. */
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * The `auth.otp.*` types whose copy must carry the one-time code (OP-95).
 *
 * The code is a template **variable** (`{{code}}`), never a persisted field: the
 * synchronous sender renders it at send time and the dispatch ledger keeps
 * metadata only (`retainBody: false`). This is the only place an auth secret is
 * intentionally interpolated into first-party copy, and it is exactly what
 * OP-95 ADR-0096 assumption 2 requires.
 */
const OTP_CODE_TYPE_KEYS: ReadonlySet<string> = new Set([
  "auth.otp.email.requested",
  "auth.otp.mobile.requested",
]);

/** Humanise a `typeKey` into a readable label (`auth.otp.email.requested` → `Auth Otp Email Requested`). */
function labelFor(typeKey: string): string {
  return typeKey
    .split(".")
    .join(" ")
    .replace(/_/g, " ")
    .replace(/\b[a-z]/g, (character) => character.toUpperCase());
}

/** The placeholders actually used across a subject and body, in first-seen order. */
function variablesOf(subjectTemplate: string, bodyTemplate: string): string[] {
  const used = new Set<string>();

  for (const match of `${subjectTemplate}\n${bodyTemplate}`.matchAll(PLACEHOLDER)) {
    if (match[1] !== undefined) {
      used.add(match[1]);
    }
  }

  return [...used];
}

/** Build the copy for one `(typeKey, group)` pair (TODO(product): real copy). */
function copyFor(
  typeKey: string,
  group: ChannelGroup["group"]
): { readonly subjectTemplate: string; readonly bodyTemplate: string } {
  const label = labelFor(typeKey);

  if (OTP_CODE_TYPE_KEYS.has(typeKey)) {
    const bodyTemplate =
      group === "email"
        ? "Your OpenPic verification code is {{code}}. It expires in a few minutes. View the details at {{actionUrl}}."
        : "Your OpenPic verification code is {{code}}. It expires in a few minutes.";
    return { subjectTemplate: "Your OpenPic verification code", bodyTemplate };
  }

  const base =
    group === "email"
      ? {
          subjectTemplate: `${label} — OpenPic`,
          bodyTemplate: `${label}. View the details at {{actionUrl}}.`,
        }
      : {
          subjectTemplate: label,
          bodyTemplate: `${label}. Open OpenPic to see the details.`,
        };

  return typeKey === DOWNGRADED_TYPE_KEY
    ? { ...base, bodyTemplate: `${base.bodyTemplate} ${DOWNGRADE_REASSURANCE}` }
    : base;
}

/** Build one validated template document (parsed through the schema, so variable drift is impossible). */
function makeTemplate(typeKey: string, group: ChannelGroup["group"]): NotificationTemplate {
  const { subjectTemplate, bodyTemplate } = copyFor(typeKey, group);

  return notificationTemplateSchema.parse({
    typeKey,
    channel: group,
    locale: LOCALE,
    subjectTemplate,
    bodyTemplate,
    variables: variablesOf(subjectTemplate, bodyTemplate),
    providerRefs: { whatsappTemplateName: null },
    version: 1,
    active: true,
  });
}

/**
 * One active `en-IN` template per enabled `(typeKey, group)`, in catalogue order.
 *
 * Disabled groups deliberately have **no** template (AC2 "no active template
 * exists for a disabled routing group").
 */
export const SEED_NOTIFICATION_TEMPLATES: readonly NotificationTemplate[] =
  SEED_NOTIFICATION_TYPES.flatMap((type) =>
    type.channelGroups
      .filter((group) => group.enabled)
      .map((group) => makeTemplate(type.typeKey, group.group))
  );
