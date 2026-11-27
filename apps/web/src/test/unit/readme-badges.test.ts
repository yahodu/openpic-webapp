import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The README badge strip is the repository's first visual claim, and it reads as
 * one set only while every badge comes from the same host and the CI badge keeps
 * asking GitHub for the live workflow status.
 *
 * PR #985 moved all seven badges onto `img.shields.io` — one geometry, one
 * rendering path — after the `CI | passing` badge had been "simplified" into a
 * static `badge/CI-passing-green` that could not go red. Nothing pinned either
 * property, so both regressions could return quietly: a new badge from another
 * host, or a CI badge that states a status instead of measuring one (finding F3
 * of the review of PR #985).
 *
 * This is a characterization pin over the real `README.md`, not a fixture, so it
 * is green on the current trunk and reds only when the strip drifts. It reads
 * source text and never the network: the `unit` project stays hermetic.
 *
 * Record: ADR-0993 (`docs/adr/ADR-0993-op101-readme-badge-pins.md`).
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
 * Extract the target URL of every markdown image in a fragment.
 *
 * Only the `![alt](url)` form counts; an HTML `<img>` would be invisible here,
 * which is why the header block is asserted non-empty before this runs.
 *
 * @param markdown - Markdown fragment to scan.
 * @returns The image target URLs, in document order.
 */
function badgeUrlsOf(markdown: string): string[] {
  return [...markdown.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map(([, url = ""]) => url);
}

/** Host every badge in the strip must come from. */
const BADGE_HOST = "img.shields.io";

/** Path of the live GitHub Actions workflow-status endpoint the CI badge reads. */
const CI_WORKFLOW_STATUS_PATH = "/github/actions/workflow/status/yahodu/openpic-webapp/ci.yml";

const README = readRepositoryFile("../../../../../README.md");
const BADGE_URLS = badgeUrlsOf(headerBlockOf(README));

describe("README badge strip", () => {
  it("finds the badge images the centred header block declares", () => {
    expect(BADGE_URLS.length).toBeGreaterThan(0);
  });

  it("serves every badge image from img.shields.io", () => {
    const foreignBadges = BADGE_URLS.filter((url) => new URL(url).host !== BADGE_HOST);

    expect(foreignBadges).toEqual([]);
  });

  it("keeps the CI badge on the live GitHub Actions workflow status endpoint", () => {
    const liveStatusBadges = BADGE_URLS.filter((url) => {
      const { host, pathname } = new URL(url);

      return host === BADGE_HOST && pathname === CI_WORKFLOW_STATUS_PATH;
    });

    expect(liveStatusBadges.length).toBeGreaterThan(0);
  });

  it("carries no leftover shieldcn.dev badge host", () => {
    expect(README).not.toContain("shieldcn.dev");
  });
});
