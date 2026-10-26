/**
 * SVG sanitizer for branding uploads (OP-114, API contract §2.1).
 *
 * An SVG is markup, so a hostile file can carry `<script>` elements, inline
 * event handlers (`onload`, `onclick`, …), `javascript:` URIs and
 * `<foreignObject>` payloads (arbitrary HTML) that would execute when a browser
 * renders the logo. The upload endpoint stores only the **sanitized** copy —
 * the necessary-and-sufficient transformation for the four payload classes the
 * contract names:
 *
 *   1. `<script>` elements are removed together with their contents
 *      (nested occurrences included);
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
 * The sanitizer is a **tokenizer**, not a regex pass: each `<…>` construct is
 * classified (start tag, end tag, comment, CDATA, processing instruction or
 * declaration), element and attribute names are lexed with quote-aware value
 * scanning, and the output is rebuilt from the original slices. Regex-based
 * markup rewriting is deliberately avoided — a regular expression cannot
 * reliably find a `</script>` end tag (whitespace, casing and nesting all
 * break it) and such matches have historically been the source of sanitizer
 * bypasses. The tokenizer never throws, so the route may sanitize or reject a
 * broken document without a crash; what it cannot parse is handled literally
 * outside the removed subtrees.
 */

/** Element local names whose entire subtree is removed (case-insensitive). */
const SUPPRESSED_ELEMENTS = new Set(["script", "foreignobject"]);

/** `href` attribute names whose value is checked for a `javascript:` URI. */
const LINK_ATTRIBUTE_NAMES = new Set(["href", "xlink:href"]);

/** The URI scheme that is stripped from link attributes (case-insensitive). */
const BLOCKED_URI_SCHEME = "javascript:";

/** A parse base for relative link values; only the `protocol` is read. */
const LINK_BASE_URL = "https://openpic.in/";

/** The five XML predefined character references, decoded in a single pass. */
const XML_NAMED_REFERENCES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

/** Match one character reference: `&#dd;`, `&#xhh;` or an XML named entity. */
const CHARACTER_REFERENCE = /&(?:#(\d+)|#x([0-9a-f]+)|amp|lt|gt|quot|apos);/gi;

/**
 * Decode the character references of an attribute value the way the SVG
 * parser will when a browser renders the stored document.
 *
 * The sanitizer inspects the raw uploaded text, but a browser decodes
 * `&#x73;` → `s` and `&amp;` → `&` while parsing an attribute, so a
 * `href="java&#x73;cript:alert(1)"` would become `javascript:` at render
 * time. The scheme check must therefore look at the decoded value. The
 * replacement is single-pass (references are never re-scanned), mirroring
 * the XML decoder: `&amp;#106;` becomes the literal text `&#106;`.
 *
 * @param value - The raw attribute value, quotes already stripped.
 * @returns The decoded value a browser would see.
 */
function decodeCharacterReferences(value: string): string {
  return value.replace(
    CHARACTER_REFERENCE,
    (match, decimal: string | undefined, hex: string | undefined) => {
      if (decimal !== undefined) {
        return String.fromCodePoint(Number.parseInt(decimal, 10));
      }
      if (hex !== undefined) {
        return String.fromCodePoint(Number.parseInt(hex, 16));
      }
      return XML_NAMED_REFERENCES[match] ?? match;
    }
  );
}

/**
 * Whether a link attribute value carries the blocked URI scheme.
 *
 * The check parses the **decoded** value with the WHATWG URL parser, which
 * is exactly how a browser decides the scheme of an `href`: character
 * references resolve first, ASCII tab/LF/CR inside the scheme are folded
 * away (`java\nscript:` still reads `javascript:`), and the scheme is
 * case-folded. A relative or unparseable value resolves to the base's
 * `https:` protocol and is never reported blocked.
 *
 * @param value - The raw attribute value.
 * @returns Whether a browser would see the `javascript:` scheme.
 */
function hasBlockedUriScheme(value: string): boolean {
  try {
    return new URL(decodeCharacterReferences(value), LINK_BASE_URL).protocol === BLOCKED_URI_SCHEME;
  } catch {
    // An unparseable value is not a javascript: URI. (The WHATWG parser
    // only throws for some internals-invalid inputs; treating them as safe
    // matches a browser refusing to navigate to them.)
    return false;
  }
}

/** Lowercase the local (post-colon) part of a name, trimming nothing else. */
function localName(name: string): string {
  const lastColon = name.lastIndexOf(":");
  return (lastColon === -1 ? name : name.slice(lastColon + 1)).toLowerCase();
}

/** Whether an attribute name is an `on*` event handler (case-insensitive). */
function isEventHandlerName(name: string): boolean {
  const local = localName(name);
  return (
    local.length > 2 &&
    local.startsWith("on") &&
    local.charCodeAt(2) >= 97 &&
    local.charCodeAt(2) <= 122
  );
}

/** Whether an element should be removed with its whole subtree. */
function isSuppressedElement(name: string): boolean {
  return SUPPRESSED_ELEMENTS.has(localName(name));
}

/** The `>`/`/>` that closes a tag, found without mistaking a quoted `>`. */
interface TagClose {
  /** Index of the closing `>` in `xml`. */
  readonly bracket: number;
  /** Whether the tag is self-closing (`/>`). */
  readonly selfClosing: boolean;
}

/**
 * Find the index of the `>` that ends the tag starting at `open` (the `<`).
 *
 * @param xml - The whole document.
 * @param open - Index of the tag's `<`.
 * @returns The closing bracket index and the self-closing flag.
 */
function findTagClose(xml: string, open: number): TagClose {
  let quote: string | null = null;
  for (let i = open + 1; i < xml.length; i += 1) {
    const ch = xml[i];
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") {
      let j = i - 1;
      while (
        j > open &&
        (xml[j] === " " || xml[j] === "\t" || xml[j] === "\n" || xml[j] === "\r")
      ) {
        j -= 1;
      }
      return { bracket: i, selfClosing: xml[j] === "/" };
    }
  }
  return { bracket: xml.length - 1, selfClosing: false };
}

/** An attribute lexed from a start tag, with its slice in the original text. */
interface LexedAttribute {
  /** Index of the first non-whitespace character of the attribute name. */
  readonly start: number;
  /** Index just past the attribute's final quote (or unquoted value). */
  readonly end: number;
  /** The lowercased attribute name. */
  readonly name: string;
  /** The raw attribute value, quotes stripped, unquoted. */
  readonly value: string;
}

/**
 * Lex the attributes of a tag body.
 *
 * The body is `xml` between the element name and the closing `>`; `nameEnd`
 * is the index just past the element name. Offsets are absolute into `xml`.
 *
 * @param xml - The whole document.
 * @param bodyEnd - Index of the tag's closing `>`.
 * @param nameEnd - Index just past the element name.
 * @returns The lexed attributes in document order.
 */
function lexAttributes(xml: string, bodyEnd: number, nameEnd: number): LexedAttribute[] {
  const attributes: LexedAttribute[] = [];
  let i = nameEnd;
  while (i < bodyEnd) {
    while (
      i < bodyEnd &&
      (xml[i] === " " || xml[i] === "\t" || xml[i] === "\n" || xml[i] === "\r" || xml[i] === "/")
    ) {
      i += 1;
    }
    if (i >= bodyEnd) {
      break;
    }
    const start = i;
    while (
      i < bodyEnd &&
      xml[i] !== "=" &&
      xml[i] !== " " &&
      xml[i] !== "\t" &&
      xml[i] !== "\n" &&
      xml[i] !== "\r" &&
      xml[i] !== "/" &&
      xml[i] !== ">"
    ) {
      i += 1;
    }
    const name = xml.slice(start, i);
    let value = "";
    if (xml[i] === "=") {
      i += 1;
      while (
        i < bodyEnd &&
        (xml[i] === " " || xml[i] === "\t" || xml[i] === "\n" || xml[i] === "\r")
      ) {
        i += 1;
      }
      const quote = xml[i];
      if (quote === '"' || quote === "'") {
        i += 1;
        const valueStart = i;
        while (i < bodyEnd && xml[i] !== quote) {
          i += 1;
        }
        value = xml.slice(valueStart, i);
        if (i < bodyEnd) {
          i += 1;
        }
      } else {
        const valueStart = i;
        while (
          i < bodyEnd &&
          xml[i] !== " " &&
          xml[i] !== "\t" &&
          xml[i] !== "\n" &&
          xml[i] !== "\r" &&
          xml[i] !== ">"
        ) {
          i += 1;
        }
        value = xml.slice(valueStart, i);
      }
    }
    attributes.push({ start, end: i, name: name.toLowerCase(), value });
  }
  return attributes;
}

/**
 * Sanitize an SVG string for safe storage.
 *
 * Removes `<script>` and `<foreignObject>` subtrees (nested included), strips
 * `on*` event-handler attributes, and drops `href`/`xlink:href` attributes
 * whose URI scheme is `javascript:`. Everything else is preserved
 * byte-identically. Never throws.
 *
 * @param xml - The original uploaded SVG text.
 * @returns The sanitized copy.
 */
export function sanitizeSvg(xml: string): string {
  let output = "";
  let pos = 0;
  /** Open element names; the last entry is the innermost. */
  const openElements: string[] = [];
  /** Number of currently open suppressed elements (their contents are dropped). */
  let suppressedDepth = 0;

  const suppressed = (): boolean => suppressedDepth > 0;

  for (;;) {
    const open = xml.indexOf("<", pos);
    if (open === -1) {
      if (!suppressed()) {
        output += xml.slice(pos);
      }
      break;
    }
    if (!suppressed()) {
      output += xml.slice(pos, open);
    }

    const next = xml[open + 1] ?? "";
    const isComment = next === "!" && xml.startsWith("<!--", open);
    const isCdata = next === "!" && xml.startsWith("<![CDATA[", open);

    if (isComment) {
      const close = xml.indexOf("-->", open + 4);
      const end = close === -1 ? xml.length : close + 3;
      if (!suppressed()) {
        output += xml.slice(open, end);
      }
      pos = end;
      continue;
    }

    if (isCdata) {
      const close = xml.indexOf("]]>", open + 9);
      const end = close === -1 ? xml.length : close + 3;
      if (!suppressed()) {
        output += xml.slice(open, end);
      }
      pos = end;
      continue;
    }

    // Processing instructions (`<?…?>`) and declarations (`<!DOCTYPE …>`).
    if (next === "?" || next === "!") {
      const tagClose = findTagClose(xml, open);
      const end = tagClose.bracket + 1;
      if (!suppressed()) {
        output += xml.slice(open, end);
      }
      pos = end;
      continue;
    }

    const tagClose = findTagClose(xml, open);
    const close = tagClose.bracket;
    const isEndTag = next === "/";

    // The element name: from after `<` (or `</`) to whitespace or `/`/`>`.
    const nameStart = open + (isEndTag ? 2 : 1);
    let nameEnd = nameStart;
    while (
      nameEnd < close &&
      xml[nameEnd] !== " " &&
      xml[nameEnd] !== "\t" &&
      xml[nameEnd] !== "\n" &&
      xml[nameEnd] !== "\r" &&
      xml[nameEnd] !== "/" &&
      xml[nameEnd] !== ">"
    ) {
      nameEnd += 1;
    }
    const name = xml.slice(nameStart, nameEnd);

    if (isEndTag) {
      // Pop matching open elements; the end tag of a suppressed element is
      // dropped with its subtree regardless of where its match was found.
      let matched = -1;
      for (let i = openElements.length - 1; i >= 0; i -= 1) {
        if (localName(openElements[i] ?? "") === localName(name)) {
          matched = i;
          break;
        }
      }
      if (matched === -1) {
        if (!suppressed()) {
          output += xml.slice(open, close + 1);
        }
        pos = close + 1;
        continue;
      }
      let poppedSuppressed = 0;
      for (let i = openElements.length - 1; i >= matched; i -= 1) {
        if (isSuppressedElement(openElements[i] ?? "")) {
          poppedSuppressed += 1;
        }
      }
      openElements.length = matched;
      suppressedDepth -= poppedSuppressed;
      if (suppressedDepth < 0) {
        suppressedDepth = 0;
      }
      if (!isSuppressedElement(name) && !suppressed()) {
        output += xml.slice(open, close + 1);
      }
      pos = close + 1;
      continue;
    }

    // A start tag. Self-closing tags open nothing; suppressed tags open a
    // subtree that is not emitted at all.
    const selfClosing = tagClose.selfClosing;
    if (isSuppressedElement(name)) {
      if (!selfClosing) {
        openElements.push(name);
        suppressedDepth += 1;
      }
      pos = close + 1;
      continue;
    }

    if (suppressed()) {
      // Inside a removed subtree: only track the open elements of retained
      // tags so a later end tag pops the right depth.
      if (!selfClosing) {
        openElements.push(name);
      }
      pos = close + 1;
      continue;
    }

    // A retained start tag: rebuild it from the original slices, dropping
    // `on*` handlers and `javascript:` links.
    const attributes = lexAttributes(xml, close, nameEnd);
    let tag = xml.slice(open, nameEnd);
    let cursor = nameEnd;
    for (const attribute of attributes) {
      const isLink = LINK_ATTRIBUTE_NAMES.has(attribute.name);
      const blockedScheme = hasBlockedUriScheme(attribute.value);
      if (isLink && blockedScheme) {
        cursor = attribute.end;
        continue;
      }
      if (isEventHandlerName(attribute.name)) {
        cursor = attribute.end;
        continue;
      }
      tag += xml.slice(cursor, attribute.start);
      tag += xml.slice(attribute.start, attribute.end);
      cursor = attribute.end;
    }
    tag += xml.slice(cursor, close + 1);
    output += tag;
    if (!selfClosing) {
      openElements.push(name);
    }
    pos = close + 1;
  }

  return output;
}
