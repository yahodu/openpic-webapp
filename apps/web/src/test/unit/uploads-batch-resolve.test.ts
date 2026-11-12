import { describe, expect, it } from "vitest";

import {
  MAX_BATCH_FILES,
  isValidBatchId,
  quotaSufficiency,
  resolutionFor,
  type BatchFileClaim,
  type ResolutionInput,
  type UploadPolicy,
} from "@/server/uploads/batch-resolve";

/**
 * Unit contract — the pure logic behind the upload pre-check (OP-123 U1–U4,
 * contract §5.1 / §5.2, schema §16.1–§16.3; ADR-0700).
 *
 * `POST …/events/{eventId}/uploads/batch-resolve` answers, per hash, one of four
 * states — `completed` (skip the transfer), `in_progress` (resume the parts R2
 * already holds), `not_found` (fresh upload) and `rejected` (never attempt).
 * The decision itself is a pure function so it can be driven without a database,
 * a clock or a bucket, and so the route is left with nothing but reads:
 *
 * - **U1 — the resolution reducer.** {@link resolutionFor} folds one hash's
 *   stored observations (the tenant-scoped `media_assets` row, the
 *   user-scoped `upload_sessions` row, the `event_images` link and the live
 *   `ListParts` answer) into exactly one wire state. Precedence is pinned
 *   because two of them can coexist: a stored asset **wins** (the bytes are
 *   already accepted, so no claim about the file's declared type can invalidate
 *   them), then a claim refusal, then a resumable multipart session, then a
 *   fresh upload whose `mode` follows the 8 MB threshold.
 * - **U2 — the quota sufficiency calculation.** {@link quotaSufficiency} is the
 *   *advisory* arithmetic behind `quota.storage`/`quota.images`: it answers
 *   whether the batch's request fits the remaining allowance. It never refuses
 *   anything — the enforcement point stays `consumeEntitlement` at completion
 *   time (ADR-0340) — so `sufficient: false` is information for the client, not
 *   an error.
 * - **U3 — `batchId` validation.** The batch id is client-generated and groups
 *   the drag-and-drop; the contract admits a UUIDv4 or an ObjectId-shaped
 *   24-hex string, and anything else is a field-level `422`.
 * - **U4 — the extension / declared-MIME agreement.** The pre-check has no bytes
 *   yet, so it can only compare the two claims the client sends. The table is
 *   the upload guards' own (ADR-0009), which is why a `.NEF` declared
 *   `image/tiff` is accepted: RAW containers legitimately share the TIFF MIME.
 *
 * ## Assumptions (ADR-0700 §Assumptions)
 *
 * - A1 — the rejection `reason`/`message` pair is user-facing, so this spec pins
 *   the exact strings; the four reasons are `unsupported_mime_type`,
 *   `unsupported_extension`, `extension_mime_mismatch` and `file_too_large`,
 *   with the contract's own `unsupported_mime_type` shape extended rather than
 *   invented.
 * - A2 — a claim with **no** `fileName` skips the extension comparison (the
 *   MIME allow-list still applies); the extension is display/audit metadata and
 *   never identity (§5.1).
 * - A3 — a `pending`/`in_progress` session in `single` mode carries no resumable
 *   state (no parts, no presigned URL), so it resolves as `not_found`: a fresh
 *   single PUT is the only correct client action.
 * - A4 — a `multipart` session with no provider id in `externalRefs` cannot be
 *   resumed (there is no `uploadId` to pass to `ListParts`), so it also resolves
 *   as `not_found`.
 * - A5 — the object key a resumed multipart upload addresses is derived from
 *   the content hash plus the declared type's canonical extension
 *   (`image/jpeg` → `jpg`), which is the key `buildObjectKey` already mints.
 */

/** The §5.1 per-file ceiling the policy carries (100 MB). */
const MAX_FILE_BYTES = 104_857_600;

/** The §5.1 platform-settings upload policy these cases reason about. */
const POLICY: UploadPolicy = {
  multipartThresholdBytes: 8_388_608,
  maxFileBytes: MAX_FILE_BYTES,
  supportedMimeTypes: [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
    "image/avif",
    "image/tiff",
  ],
};

/** A canonical lowercase SHA-256 — the only content-hash shape the key builder admits. */
const HASH = "3f2c1d8899aa55bb66cc77dd88ee99ff00112233445566778899aabbccddeeff";

/** The stored asset a completed hash resolves to. */
const ASSET_ID = "6704bb0000000000000000a1";

/** The join row that marks a completed asset as already attached to the event. */
const EVENT_IMAGE_ID = "6704aa0000000000000000b2";

/** The R2 multipart id a resumable session carries in `externalRefs`. */
const MULTIPART_ID = "2~abc-op123";

/** One 8 MB part — the `partSizeBytes` the batch resolver is configured with. */
const PART_SIZE = 8_388_608;

/**
 * Build a valid per-file claim.
 *
 * @param overrides - Fields to replace on the baseline.
 * @returns The client's claim about one file.
 */
function claim(overrides: Partial<BatchFileClaim> = {}): BatchFileClaim {
  return {
    hash: HASH,
    size: 2_140_000,
    fileName: "DSC_0421.JPG",
    mimeType: "image/jpeg",
    ...overrides,
  };
}

/**
 * Build one hash's stored observations.
 *
 * @param overrides - Fields to replace on the baseline.
 * @returns The resolver input.
 */
function input(overrides: Partial<ResolutionInput> = {}): ResolutionInput {
  return {
    claim: claim(),
    policy: POLICY,
    asset: null,
    eventImageId: null,
    session: null,
    parts: null,
    ...overrides,
  };
}

describe("U1 — the resolution state reducer", () => {
  it("resolves completed for a stored, linked asset and reports the join row", () => {
    // Arrange
    const observations = input({
      asset: { id: ASSET_ID, bytes: 8_421_310 },
      eventImageId: EVENT_IMAGE_ID,
    });

    // Act
    const resolution = resolutionFor(observations);

    // Assert — the whole wire object, so a field rename cannot pass silently.
    expect(resolution).toEqual({
      state: "completed",
      assetId: ASSET_ID,
      eventImageId: EVENT_IMAGE_ID,
      linked: true,
      bytes: 8_421_310,
    });
  });

  it("resolves completed with linked false when the tenant asset is not attached to this event", () => {
    // Arrange — tenant-wide dedupe found the asset, but no `event_images` row.
    const observations = input({ asset: { id: ASSET_ID, bytes: 8_421_310 } });

    // Act
    const resolution = resolutionFor(observations);

    // Assert — the client must call the link-only variant, so the state stays
    // `completed` and the link flag is the only difference.
    expect(resolution).toEqual({
      state: "completed",
      assetId: ASSET_ID,
      eventImageId: null,
      linked: false,
      bytes: 8_421_310,
    });
  });

  it("resolves completed even when the claim's declared type is unsupported, because stored bytes win", () => {
    // Arrange — an asset exists for the hash, but the client re-declares it as
    // a type outside the allow-list. Refusing would be wrong: nothing needs
    // uploading, and the stored object was already validated from its bytes.
    const observations = input({
      claim: claim({ fileName: "DSC_0421.BMP", mimeType: "image/bmp" }),
      asset: { id: ASSET_ID, bytes: 8_421_310 },
    });

    // Act
    const resolution = resolutionFor(observations);

    // Assert
    expect(resolution.state).toBe("completed");
  });

  it("resolves in_progress from the live parts list for a resumable multipart session", () => {
    // Arrange — the parts exist only in the storage answer (there is no part
    // collection to fall out of sync, schema §16.2).
    const observations = input({
      claim: claim({ size: 41_943_040 }),
      session: { mode: "multipart", uploadId: MULTIPART_ID },
      parts: [
        { PartNumber: 1, Size: PART_SIZE },
        { PartNumber: 3, Size: 1_048_576 },
      ],
    });

    // Act
    const resolution = resolutionFor(observations);

    // Assert
    expect(resolution).toEqual({
      state: "in_progress",
      uploadId: MULTIPART_ID,
      mode: "multipart",
      uploadedPartNumbers: [1, 3],
      uploadedBytes: 9_437_184,
    });
  });

  it("resolves in_progress with no parts when the storage answer lists none yet", () => {
    // Arrange — the multipart upload was created but no byte has landed.
    const observations = input({
      claim: claim({ size: 41_943_040 }),
      session: { mode: "multipart", uploadId: MULTIPART_ID },
      parts: [],
    });

    // Act
    const resolution = resolutionFor(observations);

    // Assert
    expect(resolution).toEqual({
      state: "in_progress",
      uploadId: MULTIPART_ID,
      mode: "multipart",
      uploadedPartNumbers: [],
      uploadedBytes: 0,
    });
  });

  it("resolves not_found in single mode for a fresh file below the multipart threshold", () => {
    // Arrange — no asset, no session: a first upload of a 2.1 MB file.

    // Act
    const resolution = resolutionFor(input());

    // Assert
    expect(resolution).toEqual({ state: "not_found", mode: "single" });
  });

  it("resolves not_found in multipart mode for a fresh file at the 8 MB threshold", () => {
    // Arrange — the threshold is inclusive: 8 388 608 bytes is multipart.

    // Act
    const resolution = resolutionFor(
      input({ claim: claim({ size: POLICY.multipartThresholdBytes }) })
    );

    // Assert
    expect(resolution).toEqual({ state: "not_found", mode: "multipart" });
  });

  it("resolves not_found in single mode for a stale single-mode session, which has nothing to resume", () => {
    // Arrange — a `pending` single-PUT session carries no parts and no URL.
    const observations = input({ session: { mode: "single", uploadId: null } });

    // Act
    const resolution = resolutionFor(observations);

    // Assert
    expect(resolution).toEqual({ state: "not_found", mode: "single" });
  });

  it("resolves not_found in multipart mode for a multipart session with no provider upload id", () => {
    // Arrange — a session row whose `externalRefs` lost the multipart id cannot
    // be resumed: there is no upload id to hand to `ListParts`.
    const observations = input({
      claim: claim({ size: 41_943_040 }),
      session: { mode: "multipart", uploadId: null },
    });

    // Act
    const resolution = resolutionFor(observations);

    // Assert
    expect(resolution).toEqual({ state: "not_found", mode: "multipart" });
  });

  it("resolves rejected with the contract's reason and message for an unsupported MIME type", () => {
    // Arrange
    const observations = input({ claim: claim({ fileName: "scan.bmp", mimeType: "image/bmp" }) });

    // Act
    const resolution = resolutionFor(observations);

    // Assert
    expect(resolution).toEqual({
      state: "rejected",
      reason: "unsupported_mime_type",
      message:
        "This file type is not supported. Upload a JPEG, PNG, WebP, AVIF, HEIC or TIFF image.",
    });
  });

  it("resolves not_found rather than rejected when a valid claim has never been seen", () => {
    // Arrange — the guard must not be vacuous: the same claim without the bad
    // type resolves as a fresh upload.
    const observations = input({ claim: claim({ fileName: "scan.png", mimeType: "image/png" }) });

    // Act
    const resolution = resolutionFor(observations);

    // Assert
    expect(resolution.state).toBe("not_found");
  });
});

describe("U2 — the quota sufficiency calculation", () => {
  it("reports sufficient when the request fits the remaining allowance", () => {
    // Act
    const verdict = quotaSufficiency({ remaining: 34_161_000_000, requested: 10_561_310 });

    // Assert — the block is the wire shape the route lifts into `quota.storage`.
    expect(verdict).toEqual({
      remaining: 34_161_000_000,
      requested: 10_561_310,
      sufficient: true,
    });
  });

  it("reports sufficient when the request exactly equals the remaining allowance", () => {
    // Act
    const verdict = quotaSufficiency({ remaining: 1_000, requested: 1_000 });

    // Assert
    expect(verdict.sufficient).toBe(true);
  });

  it("reports insufficient when the request exceeds the remaining allowance by one unit", () => {
    // Act
    const verdict = quotaSufficiency({ remaining: 999, requested: 1_000 });

    // Assert
    expect(verdict).toEqual({ remaining: 999, requested: 1_000, sufficient: false });
  });

  it("reports sufficient for an exhausted allowance when nothing is requested", () => {
    // Act
    const verdict = quotaSufficiency({ remaining: 0, requested: 0 });

    // Assert
    expect(verdict.sufficient).toBe(true);
  });

  it("reports sufficient for an unlimited allowance and keeps remaining null", () => {
    // Act
    const verdict = quotaSufficiency({ remaining: null, requested: 5 });

    // Assert — `null` is the "no limit" sentinel (§14.2), never a number.
    expect(verdict).toEqual({ remaining: null, requested: 5, sufficient: true });
  });

  it("counts a request of many files against the remaining allowance with no overflow", () => {
    // Act — the largest batch a single call can carry, in the largest file size.
    const verdict = quotaSufficiency({
      remaining: 1_073_741_824_000,
      requested: MAX_BATCH_FILES * POLICY.maxFileBytes,
    });

    // Assert
    expect(verdict.requested).toBe(52_428_800_000);
    expect(verdict.sufficient).toBe(true);
  });
});

describe("U3 — batchId validation", () => {
  it("caps one batch-resolve call at the contract's 500 hashes", () => {
    expect(MAX_BATCH_FILES).toBe(500);
  });

  const cases: { value: string; valid: boolean }[] = [
    { value: "6705cc0000000000000000aa", valid: true },
    { value: "6705CC0000000000000000AA", valid: true },
    { value: "3f2b8c1e-9d4a-4f6b-8c2d-1a2b3c4d5e6f", valid: true },
    {
      value: "3F2B8C1E-9D4A-4F6B-8C2D-1A2B3C4D5E6F",
      valid: true,
    },
    { value: "", valid: false },
    { value: "6705cc0000000000000000a", valid: false },
    { value: "6705cc0000000000000000aaa", valid: false },
    { value: "6705cc0000000000000000ag", valid: false },
    { value: "3f2b8c1e-9d4a-1f6b-8c2d-1a2b3c4d5e6f", valid: false },
    { value: "3f2b8c1e9d4a4f6b8c2d1a2b3c4d5e6f", valid: false },
    { value: "batch-1", valid: false },
    { value: "../../etc/passwd", valid: false },
  ];

  it.each(cases)("answers $valid for the batch id $value", ({ value, valid }) => {
    expect(isValidBatchId(value)).toBe(valid);
  });
});

describe("U4 — the extension / declared-MIME agreement", () => {
  it("rejects a .PNG that claims image/jpeg", () => {
    // Act — the extension comparison is case-insensitive, so this is a real
    // disagreement rather than a casing difference.
    const resolution = resolutionFor(
      input({ claim: claim({ fileName: "DSC_0421.PNG", mimeType: "image/jpeg" }) })
    );

    // Assert
    expect(resolution).toEqual({
      state: "rejected",
      reason: "extension_mime_mismatch",
      message: "The file name says one image type and the declared type says another.",
    });
  });

  it("accepts an upper-case .JPG that claims image/jpeg", () => {
    // Act
    const resolution = resolutionFor(
      input({ claim: claim({ fileName: "DSC_0421.JPG", mimeType: "image/jpeg" }) })
    );

    // Assert
    expect(resolution.state).not.toBe("rejected");
  });

  it("accepts a .NEF that claims image/tiff, because RAW containers share the TIFF MIME", () => {
    // Act — the contract's own §5.4 example sends a `.NEF` as `image/tiff`.
    const resolution = resolutionFor(
      input({
        claim: claim({ size: 41_943_040, fileName: "DSC_0422.NEF", mimeType: "image/tiff" }),
      })
    );

    // Assert
    expect(resolution.state).toBe("not_found");
  });

  it("accepts a .heic that claims image/heif, because one format admits both MIME values", () => {
    // Act
    const resolution = resolutionFor(
      input({
        claim: claim({ size: 41_943_040, fileName: "IMG_0042.HEIC", mimeType: "image/heif" }),
      })
    );

    // Assert
    expect(resolution.state).toBe("not_found");
  });

  it("rejects an extension outside the image vocabulary even when the MIME is supported", () => {
    // Act
    const resolution = resolutionFor(
      input({ claim: claim({ fileName: "DSC_0421.txt", mimeType: "image/jpeg" }) })
    );

    // Assert
    expect(resolution).toEqual({
      state: "rejected",
      reason: "unsupported_extension",
      message: "The file name has no supported image extension.",
    });
  });

  it("skips the extension comparison when the claim carries no file name", () => {
    // Act — a raw camera upload without a display name; the MIME list still applies.
    const resolution = resolutionFor(
      input({ claim: { hash: HASH, size: 2_140_000, mimeType: "image/jpeg" } })
    );

    // Assert
    expect(resolution.state).toBe("not_found");
  });

  it("rejects a file one byte over the configured maximum size", () => {
    // Arrange — the ceiling is the platform setting, not a constant in the guard.
    const observations = input({
      claim: claim({ size: MAX_FILE_BYTES + 1 }),
      policy: POLICY,
    });

    // Act
    const resolution = resolutionFor(observations);

    // Assert
    expect(resolution).toEqual({
      state: "rejected",
      reason: "file_too_large",
      message: "This file is larger than the 100 MB limit for one image.",
    });
  });
});
