import { describe, expect, it } from "vitest";

import { sniffBrandingFormat } from "@/server/media/branding-type";
import { sanitizeSvg } from "@/server/media/sanitize-svg";

/**
 * SVG sanitizer for branding uploads (OP-114, API contract §2.1).
 *
 * Branding assets may be SVG, and an SVG is markup — a hostile file can carry
 * `<script>`, inline event handlers (`onload`, …) and `javascript:` URIs that
 * would execute in a browser that renders the logo. The upload endpoint must
 * store a **sanitized** copy (the route integration suite fetches the stored
 * bytes and asserts the payloads are gone). These unit pins fix the sanitizer
 * surface the route consumes.
 *
 * U2 — the SVG sanitizer removes `script`, `onload` and `javascript:` hrefs.
 */

describe("sanitizeSvg", () => {
  it("removes a <script> element together with its contents", () => {
    const input =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>document.body.innerHTML = "pwned"</script><rect width="2" height="2" /></svg>';

    const output = sanitizeSvg(input);

    expect(output.toLowerCase()).not.toContain("script");
    expect(output).not.toContain("pwned");
    expect(output.toLowerCase()).toContain("rect");
  });

  it("strips inline event-handler attributes such as onload", () => {
    const input =
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><g onmouseover="alert(2)" /><circle onclick="alert(3)" /></svg>';

    const output = sanitizeSvg(input);

    expect(output.toLowerCase()).not.toContain("onload");
    expect(output.toLowerCase()).not.toContain("onmouseover");
    expect(output.toLowerCase()).not.toContain("onclick");
    expect(output.toLowerCase()).toContain("circle");
  });

  it("neutralizes javascript: hrefs, including xlink:href", () => {
    const input =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
      '<a href="javascript:alert(1)"><text>click</text></a>' +
      '<use xlink:href="javascript:alert(2)" /></svg>';

    const output = sanitizeSvg(input);

    expect(output.toLowerCase()).not.toContain("javascript:");
    expect(output).not.toContain("alert(1)");
    expect(output).not.toContain("alert(2)");
  });

  it("removes a <foreignObject> element", () => {
    const input =
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div onclick="alert(1)">x</div></foreignObject><rect /></svg>';

    const output = sanitizeSvg(input);

    expect(output.toLowerCase()).not.toContain("foreignobject");
    expect(output.toLowerCase()).not.toContain("onclick");
    expect(output.toLowerCase()).toContain("rect");
  });

  it("keeps benign content and harmless https links", () => {
    const input =
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="2" height="2" /><a href="https://example.com/brand"><text>logo</text></a></svg>';

    const output = sanitizeSvg(input);

    expect(output.toLowerCase()).toContain("<svg");
    expect(output.toLowerCase()).toContain("rect");
    expect(output).toContain("https://example.com/brand");
  });
});

describe("sanitizeSvg with a leading <?xml declaration", () => {
  // Round-1 review pin: `sniffBrandingFormat` accepts a `<?xml` declaration
  // before the root, and `sanitizeSvg` runs over the whole text — but nothing
  // pinned that the sanitized result retains the leading declaration
  // byte-identical. A regression that stripped (or mangled) the declaration
  // would pass every earlier assertion; this block pins the declaration as
  // part of the retained document.
  const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';
  const XML_PREFIXED_SVG = `${XML_DECLARATION}\n<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>document.body.innerHTML = "pwned"</script><rect width="2" height="2" /></svg>`;

  it("detects an <?xml-prefixed SVG as svg (detection covers the declaration)", () => {
    expect(sniffBrandingFormat(new TextEncoder().encode(XML_PREFIXED_SVG))).toBe("svg");
  });

  it("retains the leading <?xml declaration byte-identical through sanitization", () => {
    const output = sanitizeSvg(XML_PREFIXED_SVG);

    expect(output.startsWith(XML_DECLARATION)).toBe(true);
    expect(output.indexOf(XML_DECLARATION)).toBe(0);
  });

  it("still removes the script payload from an <?xml-prefixed SVG", () => {
    const output = sanitizeSvg(XML_PREFIXED_SVG);

    expect(output.toLowerCase()).not.toContain("script");
    expect(output).not.toContain("pwned");
    expect(output).toContain('<rect width="2" height="2" />');
  });
});
