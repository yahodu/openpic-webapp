/**
 * `renderTemplate` — the strict, escaping copy renderer (design §19.2, §8;
 * ADR-0078).
 *
 * Templates are first-party copy keyed by `(typeKey, channel, locale)` and
 * rendered **at write time** (design §19.4), so a broken template must fail
 * loudly rather than ship an email that says "Hi {{firstName}}". The renderer:
 *
 *   - HTML-escapes `{{value}}` interpolation in **both** `subject` and `body`;
 *   - throws when a `variables[]`-declared value is missing at render time;
 *   - throws when a supplied value was never declared by the template;
 *   - rejects a triple-stash `{{{value}}}` / `{{&value}}` — the unescaped-output
 *     escape hatch — since no layout-partial whitelist exists yet;
 *   - selects the exact locale, else the `en-IN` fallback, else throws.
 *
 * It does no I/O; the caller owns template storage.
 */

import type { NotificationTemplate } from "@/server/notifications/notification-templates";

/** The locale every catalogue is expected to carry (U21). */
export const FALLBACK_LOCALE = "en-IN";

/** The values a template may interpolate. */
export type RenderVars = Readonly<Record<string, string | number>>;

/** A rendered template and the locale actually used. */
export interface RenderedTemplate {
  readonly subject: string;
  readonly body: string;
  readonly locale: string;
}

/** Raised when copy cannot be produced safely (missing/undeclared/unescaped). */
export class TemplateRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateRenderError";
  }
}

/** Matches a Handlebars-style `{{name}}` / `{{ a.b }}` placeholder. */
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\s*\}\}/g;

/** The characters Handlebars escapes by default, plus the entity map. */
const ESCAPE_MAP: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
  "`": "&#x60;",
  "=": "&#x3D;",
};

/** HTML-escape a rendered value so it cannot inject markup. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`=]/g, (character) => ESCAPE_MAP[character] ?? character);
}

/** Reject unescaped-output syntax outright (no partial whitelist exists yet). */
function assertEscaped(source: string, locale: string): void {
  if (source.includes("{{{") || source.includes("{{&")) {
    throw new TemplateRenderError(
      `Template for locale "${locale}" uses unescaped output ({{{ }}} / {{& }}), which is not allowed.`
    );
  }
}

/** Look up a (possibly dotted) variable path without touching the prototype chain. */
function lookup(vars: RenderVars, path: string): string | number | undefined {
  if (Object.prototype.hasOwnProperty.call(vars, path)) return vars[path];

  let current: unknown = vars;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }

  return typeof current === "string" || typeof current === "number" ? current : undefined;
}

/** Interpolate one template string, escaping every value. */
function renderString(
  source: string,
  declared: ReadonlySet<string>,
  vars: RenderVars,
  locale: string
): string {
  return source.replace(PLACEHOLDER, (_match, name: string) => {
    if (!declared.has(name)) {
      throw new TemplateRenderError(
        `Template for locale "${locale}" uses undeclared variable "${name}".`
      );
    }

    const value = lookup(vars, name);
    if (value === undefined) {
      throw new TemplateRenderError(
        `Missing value for declared variable "${name}" at render time.`
      );
    }

    return escapeHtml(String(value));
  });
}

/**
 * Render the candidate templates for one `(typeKey, channel)`.
 *
 * @param templates - The candidate templates; a single template is a one-element
 *   list. The first exact-`locale` match wins, else the `en-IN` template.
 * @param vars - The values to interpolate; every supplied key must be declared.
 * @param locale - The requested locale.
 * @returns The rendered `subject`/`body` and the locale actually used.
 * @throws {TemplateRenderError} When no template matches, a value is missing or
 *   undeclared, or the template uses unescaped output.
 */
export function renderTemplate(
  templates: readonly NotificationTemplate[],
  vars: RenderVars,
  locale: string
): RenderedTemplate {
  const template =
    templates.find((candidate) => candidate.locale === locale) ??
    templates.find((candidate) => candidate.locale === FALLBACK_LOCALE);

  if (template === undefined) {
    throw new TemplateRenderError(
      `No template for locale "${locale}" and no "${FALLBACK_LOCALE}" fallback.`
    );
  }

  const declared = new Set(template.variables);

  for (const key of Object.keys(vars)) {
    if (!declared.has(key)) {
      throw new TemplateRenderError(
        `Supplied variable "${key}" is not declared by the "${template.locale}" template.`
      );
    }
  }

  assertEscaped(template.subjectTemplate, template.locale);
  assertEscaped(template.bodyTemplate, template.locale);

  return {
    subject: renderString(template.subjectTemplate, declared, vars, template.locale),
    body: renderString(template.bodyTemplate, declared, vars, template.locale),
    locale: template.locale,
  };
}
