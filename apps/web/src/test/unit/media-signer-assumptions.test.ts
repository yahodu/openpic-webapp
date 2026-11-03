import { describe, expect, it } from "vitest";

import { createMediaSigner } from "@/server/media/signer";
import { fixedClock } from "@/server/runtime/clock";

import {
  TEST_MEDIA_CONTENT_HASH,
  TEST_MEDIA_SIGNING_SECRET_CURRENT,
  makeSignMediaInput,
} from "../factories/media";

/**
 * OP-113 round-1 follow-up (ADR-0585) — the signer's **recorded assumptions
 * stay assumptions**.
 *
 * ADR-0582 §"Assumptions and open questions" records two properties as prose
 * only. They become behaviour pins here so that neither can drift silently:
 *
 * - **`export` signs to `/o/`.** API Contract §5.7's data plane has exactly
 *   `{t|o}` and no `/e/` segment, so the export derivative shares the
 *   originals segment.
 * - **`contentHash` / `ext` are not validated by the signer.** The 64-hex
 *   shape and the extension allowlist are the OP-112 key builder's concern
 *   (`buildObjectKey`); the signer binds whatever path it is given, verbatim.
 *
 * Both are characterisation pins of behaviour that exists on the trunk: a lane
 * that wants validation must add it *and* replace these pins, and a lane that
 * wants a distinct `/e/` segment must add new pins — neither can assume the
 * signer already does it.
 *
 * The existing 25 OP-113 assertions in `media-signer.test.ts` are left
 * byte-identical; this file is additive.
 */

const T0 = new Date("2026-10-26T00:00:00.000Z");

describe("the signer's documented assumptions stay assumptions (OP-113 follow-up, ADR-0585)", () => {
  it("signs an export to the /o/ originals segment — there is no /e/", () => {
    // Arrange
    const signer = createMediaSigner({
      currentSecret: TEST_MEDIA_SIGNING_SECRET_CURRENT,
      clock: fixedClock(T0),
    });

    // Act
    const signed = signer.sign(makeSignMediaInput({ kind: "export" }), 300);

    // Assert — exactly the originals segment, and the URL round-trips there.
    const { pathname } = new URL(signed.url);
    expect(pathname).toBe(`/o/${TEST_MEDIA_CONTENT_HASH}.jpg`);
    expect(pathname).not.toMatch(/^\/e\//);
    expect(signer.verify(signed.url)).toBe(true);
  });

  it.each([
    ["a non-hex contentHash", "not-a-hex-hash", "jpg"],
    ["an uppercase contentHash", "A".repeat(64), "jpg"],
    ["a 63-character contentHash", "a".repeat(63), "jpg"],
    ["a 65-character contentHash", "a".repeat(65), "jpg"],
    ["a non-allowlisted ext (svg)", TEST_MEDIA_CONTENT_HASH, "svg"],
    ["a non-allowlisted ext (tiff)", TEST_MEDIA_CONTENT_HASH, "tiff"],
    ["a non-allowlisted ext (exe)", TEST_MEDIA_CONTENT_HASH, "exe"],
    ["an uppercase ext (PNG)", TEST_MEDIA_CONTENT_HASH, "PNG"],
    ["a dotted ext (tar.gz)", TEST_MEDIA_CONTENT_HASH, "tar.gz"],
  ] as const)(
    "signs %s as given — the signer neither refuses nor normalises",
    (_label, contentHash, ext) => {
      // Arrange
      const signer = createMediaSigner({
        currentSecret: TEST_MEDIA_SIGNING_SECRET_CURRENT,
        clock: fixedClock(T0),
      });

      // Act — the shape the OP-112 key builder owns is not validated here.
      const signed = signer.sign({ kind: "original", contentHash, ext }, 300);

      // Assert — bound into the path verbatim, and the signature holds.
      const { pathname } = new URL(signed.url);
      expect(pathname).toBe(`/o/${contentHash}.${ext}`);
      expect(signer.verify(signed.url)).toBe(true);
    }
  );
});
