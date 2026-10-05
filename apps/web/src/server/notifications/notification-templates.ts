import { z } from "zod";

import { notificationChannelSchema } from "./notification-types";

/**
 * The `notificationTemplates` catalogue schema (OP-84, schema §19.2, contract
 * §7.6).
 *
 * Templates are first-party copy keyed by `(typeKey, channel, locale)`, where
 * `channel` names the routing **group** the copy serves (`in_app` | `email` |
 * `mobile`) — the WhatsApp-vs-SMS split is a `channelGroups[].candidates`
 * concern, not a per-template one (ADR-0016 "channel on a template names the
 * routing group"). For `in_app`, `subjectTemplate` carries the feed **title**
 * and `bodyTemplate` the feed **body**.
 *
 * `variables[]` exists so a missing or unused placeholder is caught here — at
 * the seed and at any future admin template editor — rather than shipping an
 * email that says "Hi {{firstName}}". The refinement rejects, at the
 * `variables` issue path, **both** directions of drift:
 *
 *   - a placeholder used in `subjectTemplate`/`bodyTemplate` but not declared;
 *   - a variable declared but never used.
 */

/** Matches a Handlebars-style `{{name}}` placeholder, tolerating inner spaces. */
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\s*\}\}/g;

/** The declared `variables` a template must be consistent with. */
function placeholdersUsed(subjectTemplate: string, bodyTemplate: string): Set<string> {
  const used = new Set<string>();
  const source = `${subjectTemplate}\n${bodyTemplate}`;

  for (const match of source.matchAll(PLACEHOLDER)) {
    if (match[1] !== undefined) {
      used.add(match[1]);
    }
  }

  return used;
}

/** A stored `notificationTemplates` document (schema §19.2). */
export const notificationTemplateSchema = z
  .object({
    typeKey: z.string().min(1),
    channel: notificationChannelSchema,
    locale: z.string().min(1),
    subjectTemplate: z.string(),
    bodyTemplate: z.string(),
    variables: z.array(z.string()),
    providerRefs: z.object({ whatsappTemplateName: z.string().nullable() }),
    version: z.number().int().min(1),
    active: z.boolean(),
  })
  .superRefine((template, ctx) => {
    const used = placeholdersUsed(template.subjectTemplate, template.bodyTemplate);
    const declared = new Set(template.variables);

    const missing = [...used].filter((variable) => !declared.has(variable));
    const unused = [...declared].filter((variable) => !used.has(variable));

    if (missing.length > 0 || unused.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["variables"],
        message:
          `declared variables must equal the placeholders used ` +
          `(missing: ${missing.join(", ") || "none"}; unused: ${unused.join(", ") || "none"})`,
      });
    }
  });

/** A validated stored notification template. */
export type NotificationTemplate = z.infer<typeof notificationTemplateSchema>;
