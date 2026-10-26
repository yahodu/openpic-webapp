/**
 * SVG sanitizer for branding uploads (OP-114, API contract §2.1).
 *
 * An SVG is markup, so a hostile file can carry `<script>` elements, inline
 * event handlers (`onload`, `onclick`, …), `javascript:` URIs and
 * `<foreignObject>` payloads (arbitrary HTML) that would execute when a browser
 * renders the logo. The upload endpoint stores only the **sanitized** copy —
 * the necessary-and-sufficient transformation for the four payload classes the
 * contract names, applied by simple markup rewriting:
 *
 *   1. `<script>` elements are removed together with their contents;
 *   2. `<foreignObject>` elements are removed together with their contents;
 *   3. `on*` event-handler attributes are stripped;
 *   4. `href` / `xlink:href` attributes whose value is a `javascript:` URI are
 *      dropped (the attribute, not the element).
 *
 * Everything else — benign elements, attributes and harmless `https` links —
 * passes through byte-identically. The transformation is case-insensitive for
 * the element/attribute names and the URI scheme, matching how a browser would
 * interpret them.
 *
 * This is deliberately a **conservative marker-based** sanitizer rather than a
 * DOM round-trip: it must not crash on ill-formed XML (the route may choose to
 * sanitize or reject; these rewrites never throw), and it keeps the stored
 * object as close to the original as the contract allows.
 */

/**
 * A quoted or unquoted attribute value, for matching and inspection.
 * Captured so a `javascript:` check can look inside the quotes.
 */

/** Remove `<script …>…</script>` and self-closing `<script … />` blocks. */
const SCRIPT_ELEMENT = /<script\b[^>]*>[\s\S]*?<\/script\s*>|<script\b[^>]*\/>/gi;

/** Remove `<foreignObject …>…</foreignObject>` and self-closing blocks. */
const FOREIGN_OBJECT_ELEMENT =
  /<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject\s*>|<foreignObject\b[^>]*\/>/gi;

/** Strip `on*` event-handler attributes (`onload`, `onclick`, `onmouseover`, …). */
const EVENT_HANDLER_ATTRIBUTE = /\s+on[a-z][a-z0-9_:.-]*\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;

/** A link attribute (`href` or `xlink:href`) whose value to inspect. */
const LINK_ATTRIBUTE = /\s+(?:xlink:)?href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;

/** The `javascript:` URI scheme, matched case-insensitively. */
const JAVASCRIPT_URI_SCHEME = /^\s*javascript:/i;

/**
 * Sanitize an SVG string for safe storage.
 *
 * @param xml - The original uploaded SVG text.
 * @returns The sanitized copy: scripts, foreign objects, event handlers and
 *   `javascript:` links removed, everything else preserved.
 */
export function sanitizeSvg(xml: string): string {
  const withoutScripts = xml.replace(SCRIPT_ELEMENT, "");
  const withoutForeignObjects = withoutScripts.replace(FOREIGN_OBJECT_ELEMENT, "");
  const withoutHandlers = withoutForeignObjects.replace(EVENT_HANDLER_ATTRIBUTE, "");
  return withoutHandlers.replace(LINK_ATTRIBUTE, (match, rawValue: string) =>
    JAVASCRIPT_URI_SCHEME.test(rawValue.replace(/^["']|["']$/g, "")) ? "" : match
  );
}
