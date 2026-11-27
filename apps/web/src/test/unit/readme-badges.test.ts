import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The README badge strip is the repository's first visual claim, and it reads as
 * one set only while every badge comes from the same host and the CI badge keeps
 * asking GitHub for the live workflow status.
 *
 * PR #985 moved all seven badges onto `img.shields.io` — one geometry, one
 * rendering path — from six `shieldcn.dev` badges plus a
 * `github.com/…/badge.svg` CI badge that rendered at a different height and
 * could only report the default branch. Nothing pinned the result, so both
 * regressions could return quietly: a new badge from another host, or a CI badge
 * rewritten as a static `badge/CI-passing-brightgreen` that states a status
 * instead of measuring one (finding F3 of the review of PR #985).
 *
 * The four strip cases read the centred header block and only the inline
 * `![alt](url)` form, so the same defect escapes that scope in three shapes: an
 * HTML `<img src="…">` inside the block, an inline markdown badge immediately
 * after `</div>`, and a reference-style `![Deploy][deploy]` written against its
 * own `[deploy]: <url>` definition. All three were measured green on the trunk.
 * The whole-file census below closes that gap: it reads **every** image
 * reference in the file — `![alt](url)`, `![alt][ref]`, `![alt][]`, a bare
 * `![alt]`, and `<img src="…">` — resolves reference labels against the file's
 * own `[ref]: url` definitions, and asserts that no badge-shaped image anywhere
 * in `README.md` comes from another host.
 *
 * This is a characterization pin over the real `README.md`, not a fixture, so it
 * is green on the current trunk and reds only when the strip drifts. It reads
 * source text and never the network: the `unit` project stays hermetic.
 *
 * Record: ADR-0993 (`docs/adr/ADR-0993-op101-readme-badge-pins.md`) pins the
 * strip; the record of the whole-file census lists this spec among its
 * consumers.
 */

/**
 * Read one repository file as UTF-8 text.
 *
 * The path is resolved relative to this spec, so the suite asserts against the
 * real tree (`adr-numbering.test.ts` is the precedent) instead of a fixture.
 *
 * @param relativePath - Path from this spec's directory to the file to read.
 * @returns The file's contents.
 */
function readRepositoryFile(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

/**
 * Slice the centred header block out of the README.
 *
 * The badge strip lives between the first `<div align="center">` and its closing
 * `</div>`, so scoping the extraction there keeps it precise: a screenshot or a
 * diagram added further down the document is not a badge. A missing opener, a
 * missing closer or an empty block throws — a silently empty block would make
 * every host assertion below vacuous.
 *
 * @param readme - Contents of `README.md`.
 * @returns The markdown between the centred block's opener and closer.
 */
function headerBlockOf(readme: string): string {
  const opener = '<div align="center">';
  const start = readme.indexOf(opener);
  if (start === -1) {
    throw new Error(`README.md no longer opens a \`${opener}\` block`);
  }

  const end = readme.indexOf("</div>", start + opener.length);
  if (end === -1) {
    throw new Error("README.md's centred header block has no closing `</div>`");
  }

  const block = readme.slice(start + opener.length, end);
  if (block.trim() === "") {
    throw new Error("README.md's centred header block is empty");
  }

  return block;
}

/**
 * Extract the target URL of every inline markdown image in a fragment.
 *
 * Only the `![alt](url)` form counts; an HTML `<img>`, a reference-style
 * `![alt][ref]` or a badge written outside the fragment is invisible here, which
 * is why the whole-file census below exists and why the extraction above throws
 * on an empty header block instead of returning no hosts at all.
 *
 * @param markdown - Markdown fragment to scan.
 * @returns The image target URLs, in document order.
 */
function badgeUrlsOf(markdown: string): string[] {
  return [...markdown.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map(([, url = ""]) => url);
}

/**
 * The markdown (and HTML) image forms the whole-file census reads.
 *
 * `inline` is `![alt](url)`; `reference` is `![alt][label]` resolved against a
 * `[label]: url` definition; `collapsed-reference` is `![alt][]`, whose label is
 * its own alt text; `shortcut-reference` is a bare `![alt]`; `html` is an
 * `<img src="…">` tag.
 */
type ImageForm = "collapsed-reference" | "html" | "inline" | "reference" | "shortcut-reference";

/** One image reference found in the README source text. */
interface ImageReference {
  /** The form the reference is written in, quoted in failure messages. */
  readonly form: ImageForm;
  /** The URL the reference resolves to, before any badge classification. */
  readonly url: string;
}

/**
 * One image form and the pattern that finds it.
 *
 * The patterns are rebuilt per call so no `lastIndex` state survives between
 * two `matchAll` passes over the same table.
 */
interface ImagePattern {
  readonly form: ImageForm;
  readonly pattern: RegExp;
}

/**
 * Normalise a reference label for lookup.
 *
 * CommonMark matches `![alt][Label]` against `[label]: url` case-insensitively
 * and ignores surrounding and repeated whitespace, so the definition map is
 * keyed the same way.
 *
 * @param label - Raw label text, from an image reference or a definition line.
 * @returns The lookup key.
 */
function normaliseLabel(label: string): string {
  return label.trim().replace(/\s+/gu, " ").toLowerCase();
}

/**
 * Drop fenced code blocks from the source text.
 *
 * An image inside a fence renders as literal text, not as an image, so it is not
 * a badge. Dropping the fences also keeps a future markdown example from reding
 * the census. An unbalanced fence swallows the rest of the file, which makes the
 * census empty — that fails the host assertion loudly instead of passing.
 *
 * @param markdown - Contents of `README.md`.
 * @returns The same text with every fenced block removed.
 */
function withoutFencedCodeBlocks(markdown: string): string {
  const kept: string[] = [];
  let inFence = false;

  for (const line of markdown.split("\n")) {
    if (/^\s{0,3}(?:```|~~~)/u.test(line)) {
      inFence = !inFence;
      continue;
    }

    if (!inFence) {
      kept.push(line);
    }
  }

  return kept.join("\n");
}

/**
 * Collect the file's reference-style image definitions.
 *
 * A definition is a line of the shape `[label]: <url>` (up to three leading
 * spaces, an optional `<…>` around the URL, an optional title after it). The
 * map is what lets a `![Deploy][deploy]` reference — the shape a foreign badge
 * hides in today — resolve to the URL it actually loads.
 *
 * @param markdown - Source text with fenced blocks already removed.
 * @returns The label-to-URL map.
 */
function referenceDefinitionsOf(markdown: string): ReadonlyMap<string, string> {
  const definitions = new Map<string, string>();

  for (const line of markdown.split("\n")) {
    const match = /^ {0,3}\[([^\]]+)\]:\s*(\S+)/u.exec(line);
    const label = match?.at(1);
    const target = match?.at(2);
    if (label === undefined || target === undefined) {
      continue;
    }

    definitions.set(normaliseLabel(label), target.replace(/^<(.*)>$/u, "$1"));
  }

  return definitions;
}

/**
 * The image patterns, one entry per form.
 *
 * `inline` accepts an optional `<…>` around the target and an optional title.
 * The bracketed forms capture the label; the collapsed form captures the alt
 * text, which CommonMark uses as the label. The shortcut form excludes a `]`
 * followed by `(` or `[` so it cannot re-read an inline or full reference.
 *
 * @returns A fresh table, safe to reuse across calls.
 */
function imagePatterns(): readonly ImagePattern[] {
  return [
    { form: "inline", pattern: /!\[[^\]]*\]\(\s*([^)]+?)\)/gu },
    { form: "reference", pattern: /!\[[^\]]*\]\[([^\]]+)\]/gu },
    { form: "collapsed-reference", pattern: /!\[([^\]]*)\]\[\]/gu },
    { form: "shortcut-reference", pattern: /!\[([^\]]+)\](?![ \t]*[[(])/gu },
    { form: "html", pattern: /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/giu },
  ];
}

/**
 * Resolve one reference-style image label to its target URL.
 *
 * An undefined label throws: silently dropping the image is exactly how a
 * foreign badge written in this form would escape the census, and a census that
 * is quietly short is worse than none.
 *
 * @param definitions - The label-to-URL map of the file.
 * @param label - The label the image reference names.
 * @returns The URL the label resolves to.
 */
function resolveReference(definitions: ReadonlyMap<string, string>, label: string): string {
  const url = definitions.get(normaliseLabel(label));
  if (url === undefined) {
    throw new Error(
      `README.md uses the reference-style image \`![…][${label}]\` but defines no \`[${label}]: <url>\` target — an unresolved image would leave the census silently short`
    );
  }

  return url;
}

/**
 * Reduce the raw inside of an inline image target to its URL.
 *
 * The target may be wrapped in `<…>` and may carry a title after the URL, so
 * the URL is the first whitespace-delimited token with the angle brackets
 * stripped. A `)` cannot appear in it, which is what bounds the capture.
 *
 * @param target - The text between `](` and `)`, as captured.
 * @returns The URL the image loads.
 */
function urlFromInlineTarget(target: string): string {
  const firstToken = target.trim().split(/\s+/u).at(0) ?? "";

  return firstToken.replace(/^<(.*)>$/u, "$1");
}

/**
 * Extract every image reference in the whole file, in document order.
 *
 * This is the census the strip-scoped extraction above cannot be: it spans the
 * entire document and every form an image can be written in, so a badge moved
 * out of the centred block, wrapped in an HTML tag or resolved through a
 * reference definition is still counted.
 *
 * @param readme - Contents of `README.md`.
 * @returns One entry per image reference, in document order.
 */
function imageReferencesOf(readme: string): ImageReference[] {
  const markdown = withoutFencedCodeBlocks(readme);
  const definitions = referenceDefinitionsOf(markdown);
  const found: (ImageReference & { readonly index: number })[] = [];

  for (const { form, pattern } of imagePatterns()) {
    for (const match of markdown.matchAll(pattern)) {
      const target = match.at(1);
      if (target === undefined) {
        continue;
      }

      const url =
        form === "inline"
          ? urlFromInlineTarget(target)
          : form === "html"
            ? target
            : resolveReference(definitions, target);
      found.push({ form, url, index: match.index });
    }
  }

  return found
    .sort((left, right) => left.index - right.index)
    .map(({ form, url }) => ({ form, url }));
}

/** Host every badge in the strip must come from. */
const BADGE_HOST = "img.shields.io";

/** Path of the live GitHub Actions workflow-status endpoint the CI badge reads. */
const CI_WORKFLOW_STATUS_PATH = "/github/actions/workflow/status/yahodu/openpic-webapp/ci.yml";

/**
 * Pathname shapes that mark an image as a badge rather than as content.
 *
 * A badge is served from a badge path (`…/badge/…`, `…/shields/…`) or rendered
 * as an SVG, and the live workflow-status endpoint above counts too because its
 * path ends in `.yml`. Anything else — a screenshot, a diagram, a logo — is not
 * a badge and is deliberately out of the host assertion.
 */
const BADGE_PATHNAME_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)(?:badge|shields)(?:\/|$)/u,
  /\.svg$/u,
];

/**
 * Image URLs that are deliberately not badges, and may live on another host.
 *
 * Empty today. This is the escape hatch the census needs: when the README gains
 * a screenshot or a diagram from a docs CDN, add its **exact URL** here with the
 * reason, instead of narrowing `BADGE_PATHNAME_PATTERNS` and losing the sweep
 * for every badge at the same time.
 */
const NON_BADGE_IMAGE_ALLOWLIST: readonly string[] = [];

/**
 * Decide whether an image URL is a badge.
 *
 * @param url - Parsed image URL.
 * @returns `true` when the URL points at a badge endpoint.
 */
function isBadgeImage(url: URL): boolean {
  return (
    url.pathname === CI_WORKFLOW_STATUS_PATH ||
    BADGE_PATHNAME_PATTERNS.some((pattern) => pattern.test(url.pathname))
  );
}

/**
 * Keep the badge-shaped images of a census.
 *
 * A repository-relative image is served from this repository, so it cannot put
 * a second host in the strip; the allowlist removes the documented exceptions.
 *
 * @param images - The whole-file image census.
 * @returns The badge-shaped entries, in document order.
 */
function badgeImagesOf(images: readonly ImageReference[]): ImageReference[] {
  return images.filter(({ url }) => {
    if (!/^https?:\/\//iu.test(url)) {
      return false;
    }

    if (NON_BADGE_IMAGE_ALLOWLIST.includes(url)) {
      return false;
    }

    return isBadgeImage(new URL(url));
  });
}

const README = readRepositoryFile("../../../../../README.md");
const BADGE_URLS = badgeUrlsOf(headerBlockOf(README));
const IMAGE_CENSUS = imageReferencesOf(README);
const BADGE_CENSUS = badgeImagesOf(IMAGE_CENSUS);

describe("README badge strip", () => {
  it("finds the badge images the centred header block declares", () => {
    expect(BADGE_URLS.length).toBeGreaterThan(0);
  });

  it("serves every badge image from img.shields.io", () => {
    const hosts = [...new Set(BADGE_URLS.map((url) => new URL(url).host))];

    expect(hosts).toEqual([BADGE_HOST]);
  });

  it("keeps the CI badge on the live GitHub Actions workflow status endpoint", () => {
    const liveStatusBadges = BADGE_URLS.filter((url) => {
      const { host, pathname } = new URL(url);

      return host === BADGE_HOST && pathname === CI_WORKFLOW_STATUS_PATH;
    });

    expect(liveStatusBadges, `README badge URLs: ${BADGE_URLS.join(", ")}`).not.toHaveLength(0);
  });

  it("carries no leftover shieldcn.dev badge host", () => {
    expect(README).not.toContain("shieldcn.dev");
  });
});

/** One image form paired with a source snippet that uses it. */
interface CensusFixture {
  /** Form the snippet is written in. */
  readonly form: ImageForm;
  /** Markdown or HTML carrying exactly one image reference. */
  readonly markdown: string;
  /** URL the reference resolves to. */
  readonly url: string;
}

const CENSUS_FIXTURES: readonly CensusFixture[] = [
  {
    form: "inline",
    markdown: "![CI](https://img.shields.io/badge/CI-passing.svg)",
    url: "https://img.shields.io/badge/CI-passing.svg",
  },
  {
    form: "inline",
    markdown: '![Deploy](<https://example.com/badge/deploy.svg> "Deploy badge")',
    url: "https://example.com/badge/deploy.svg",
  },
  {
    form: "reference",
    markdown: "![Deploy][deploy]\n\n[deploy]: https://example.com/badge/deploy.svg",
    url: "https://example.com/badge/deploy.svg",
  },
  {
    form: "collapsed-reference",
    markdown: "![Deploy][]\n\n[Deploy]: https://example.com/badge/deploy.svg",
    url: "https://example.com/badge/deploy.svg",
  },
  {
    form: "shortcut-reference",
    markdown: "![Deploy]\n\n[deploy]: https://example.com/badge/deploy.svg",
    url: "https://example.com/badge/deploy.svg",
  },
  {
    form: "html",
    markdown: '<img src="https://example.com/badge/deploy.svg" alt="Deploy" />',
    url: "https://example.com/badge/deploy.svg",
  },
];

describe("README whole-file image census", () => {
  it.each(CENSUS_FIXTURES)(
    "reads the $form form of an image reference to $url",
    ({ form, markdown, url }) => {
      expect(imageReferencesOf(markdown)).toEqual([{ form, url }]);
    }
  );

  it("refuses a reference-style image whose label is never defined", () => {
    expect(() => imageReferencesOf("![Deploy][deploy]")).toThrow(/\[deploy\]/u);
  });

  it("ignores image syntax inside a fenced code block", () => {
    const markdown = ["```markdown", "![Deploy](https://example.com/badge/deploy.svg)", "```"].join(
      "\n"
    );

    expect(imageReferencesOf(markdown)).toEqual([]);
  });

  it("serves every badge-shaped image anywhere in the file from img.shields.io", () => {
    const hosts = [...new Set(BADGE_CENSUS.map(({ url }) => new URL(url).host))].sort();
    const census = IMAGE_CENSUS.map(({ form, url }) => `${form} ${url}`).join(", ");

    expect(hosts, `README image references: ${census}`).toEqual([BADGE_HOST]);
  });

  it("sees every image the centred header block declares", () => {
    const censusUrls = new Set(IMAGE_CENSUS.map(({ url }) => url));

    expect(BADGE_URLS.filter((url) => !censusUrls.has(url))).toEqual([]);
  });
});
