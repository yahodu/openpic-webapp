import { describe, expect, it } from "vitest";

import type { NotificationTemplate } from "@/server/notifications/notification-templates";
import { makeNotificationTemplate } from "../../test/factories/notification";

import { renderTemplate, TemplateRenderError } from "@/server/notifications/render-template";

/**
 * `renderTemplate` — the strict, escaping copy renderer (design §19.2, §8;
 * ADR-0078).
 *
 * Copy is first-party and rendered **at write time** (design §19.4), so a broken
 * template must fail loudly in CI rather than ship an email that says
 * "Hi {{firstName}}". This spec pins the observable contract:
 *
 *   - `{{value}}` interpolation is **HTML-escaped** (Handlebars default);
 *   - a `variables[]`-declared value that is missing at render time throws
 *     `TemplateRenderError`;
 *   - a supplied value the template never declared throws `TemplateRenderError`;
 *   - a triple-stash `{{{value}}}` — the unescaped-output escape hatch — is
 *     rejected rather than emitted;
 *   - locale selection falls back to `en-IN` when the requested locale has no
 *     template.
 *
 * The function is passed the candidate templates for one `(typeKey, channel)`
 * and returns `{ subject, body, locale }`; it does no I/O.
 */

/**
 * Render a single-locale template set (the common case).
 *
 * @param template - The template to render.
 * @param vars - The values to interpolate.
 * @param locale - The requested locale.
 * @returns The rendered subject/body and the locale actually used.
 */
function renderOne(
  template: NotificationTemplate,
  vars: Record<string, string | number>,
  locale: string
) {
  return renderTemplate([template], vars, locale);
}

describe("renderTemplate — HTML escaping", () => {
  it("U18: escapes interpolated values so an injected script tag cannot execute", () => {
    const template = makeNotificationTemplate({
      typeKey: "attendee.matches.ready",
      channel: "email",
      locale: "en-IN",
      subjectTemplate: "New photos from {{eventName}}",
      bodyTemplate: "<p>Hi {{displayName}}, your gallery is ready.</p>",
      variables: ["eventName", "displayName"],
    });

    const rendered = renderOne(
      template,
      { eventName: "<script>alert('xss')</script>", displayName: "Rahul & Priya" },
      "en-IN"
    );

    expect(rendered.body).not.toContain("<script>");
    expect(rendered.body).toContain("&lt;script&gt;");
    expect(rendered.body).toContain("Rahul &amp; Priya");
  });

  it("U23: rejects a triple-stash placeholder instead of emitting unescaped HTML", () => {
    const template = makeNotificationTemplate({
      subjectTemplate: "Hi {{firstName}}",
      bodyTemplate: "{{{rawHtml}}}",
      variables: ["firstName", "rawHtml"],
    });

    expect(() => renderOne(template, { firstName: "Rahul", rawHtml: "<b>x</b>" }, "en-IN")).toThrow(
      TemplateRenderError
    );
  });
});

describe("renderTemplate — strict variable validation", () => {
  it("U19: throws TemplateRenderError when a declared variable has no value", () => {
    const template = makeNotificationTemplate({
      subjectTemplate: "Hi {{firstName}}",
      bodyTemplate: "Your photos are ready.",
      variables: ["firstName"],
    });

    expect(() => renderOne(template, {}, "en-IN")).toThrow(TemplateRenderError);
    expect(() => renderOne(template, {}, "en-IN")).toThrow(/firstName/);
  });

  it("U20: rejects a supplied value that the template never declared", () => {
    const template = makeNotificationTemplate({
      subjectTemplate: "Hi {{firstName}}",
      bodyTemplate: "Your photos are ready.",
      variables: ["firstName"],
    });

    expect(() =>
      renderOne(template, { firstName: "Rahul", secretToken: "should-not-be-usable" }, "en-IN")
    ).toThrow(TemplateRenderError);
  });
});

describe("renderTemplate — locale selection", () => {
  it("U21: falls back to the en-IN template when the requested locale is absent", () => {
    const template = makeNotificationTemplate({
      locale: "en-IN",
      subjectTemplate: "Hi {{firstName}}",
      bodyTemplate: "Your photos are ready, {{firstName}}.",
      variables: ["firstName"],
    });

    const rendered = renderOne(template, { firstName: "Rahul" }, "fr-FR");

    expect(rendered.locale).toBe("en-IN");
    expect(rendered.body).toBe("Your photos are ready, Rahul.");
  });
});
