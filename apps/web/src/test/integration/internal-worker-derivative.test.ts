/**
 * Integration / contract — the thumbnail processor's derivative report (OP-135).
 *
 * `POST /internal/media/derivative-complete` is the processor's only write: I3/I7
 * record a thumbnail and a preview, and F2 pins that the key stored for a variant
 * is derived from the **asset's own** content hash and format, never from the
 * body's. `objectKeyRef` is an opaque handle and never key material (§0.15).
 *
 * The file is one of the four the OP-135 spec was split into (ADR-0843): the
 * harness it imports holds the preamble, the seeds and the credential builder that
 * used to open `internal-worker-endpoints.test.ts`. The case text, titles,
 * assertions and fixtures are that file's, unchanged — including the F2/F3/F4/F6
 * section docblock below, which stayed whole where F2 opens it and is continued by
 * `internal-worker-report-limits.test.ts`.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";

import {
  DERIVATIVE_PATH,
  signedPost,
  derivativeCompleteHandler,
  app,
  world,
  seedAsset,
  assetRow,
  type SeededAsset,
} from "../helpers/internal-worker-harness.js";
import { errorBody } from "../helpers/selfie-flow";

/* ──────────── I3, I7: the thumbnail processor's derivative report ───────── */

describe("when the thumbnail processor reports a generated derivative", () => {
  it("I3: records the thumbnail and advances the asset to derivatives_ready", async () => {
    const seeded = await world("op135-deriv-thumb");
    const asset = await seedAsset(seeded.tenantKey, "op135-deriv-thumb");

    const response = await derivativeCompleteHandler(
      signedPost(DERIVATIVE_PATH, {
        assetId: asset.assetId.toHexString(),
        derivative: "thumbnail",
        // §10.3.2: an opaque handle, never the object key.
        objectKeyRef: "hnd_9f2c1d4b7a6e5f80",
        bytes: 48_120,
        width: 600,
        height: 900,
        format: "webp",
        processorVersion: 3,
        watermarkVersion: 2,
        contentHash: asset.contentHash,
      })
    );

    expect(response.status).toBe(200);

    const stored = await assetRow(asset.assetId);
    expect(stored?.status).toBe("derivatives_ready");
    expect(stored?.derivatives).toMatchObject({
      thumbnail: {
        bytes: 48_120,
        width: 600,
        height: 900,
        format: "webp",
        processorVersion: 3,
        watermarkVersion: 2,
      },
    });
    const thumbnail = (stored?.derivatives as { thumbnail?: Record<string, unknown> } | undefined)
      ?.thumbnail;
    expect(thumbnail?.generatedAt).toBeInstanceOf(Date);
    expect(typeof thumbnail?.objectKey).toBe("string");
    // The original descriptor is not clobbered by the derivative.
    expect((stored?.storage as { objectKey?: unknown } | undefined)?.objectKey).toBe(
      asset.storageObjectKey
    );
    // No raw object key crosses the wire back to the processor (§0.15).
    expect(await response.text()).not.toContain(String(thumbnail?.objectKey));
  });

  it("I7: records a preview derivative without disturbing the thumbnail", async () => {
    const seeded = await world("op135-deriv-preview");
    const asset = await seedAsset(seeded.tenantKey, "op135-deriv-preview");
    const thumbnail = {
      locationKey: "thumbnails",
      objectKey: `thumbnails/${asset.contentHash}.webp`,
      bytes: 48_120,
      width: 600,
      height: 900,
      format: "webp",
      processorVersion: 3,
      watermarkVersion: 2,
      generatedAt: new Date("2026-09-25T09:30:00.000Z"),
    };
    await app.db
      .collection(COLLECTIONS.mediaAssets)
      .updateOne(
        { _id: asset.assetId },
        { $set: { derivatives: { thumbnail }, status: "derivatives_ready" } }
      );

    const response = await derivativeCompleteHandler(
      signedPost(DERIVATIVE_PATH, {
        assetId: asset.assetId.toHexString(),
        derivative: "preview",
        objectKeyRef: "hnd_1a2b3c4d5e6f7081",
        bytes: 152_480,
        width: 1_200,
        height: 1_800,
        format: "webp",
        processorVersion: 3,
        watermarkVersion: 2,
        contentHash: asset.contentHash,
      })
    );

    expect(response.status).toBe(200);

    const stored = await assetRow(asset.assetId);
    expect(stored?.status).toBe("derivatives_ready");
    expect(stored?.derivatives).toMatchObject({
      thumbnail,
      preview: {
        bytes: 152_480,
        width: 1_200,
        height: 1_800,
        format: "webp",
        processorVersion: 3,
        watermarkVersion: 2,
      },
    });
  });

  it("refuses a body that carries a raw object key instead of the opaque reference", async () => {
    const seeded = await world("op135-deriv-rawkey");
    const asset = await seedAsset(seeded.tenantKey, "op135-deriv-rawkey");

    const response = await derivativeCompleteHandler(
      signedPost(DERIVATIVE_PATH, {
        assetId: asset.assetId.toHexString(),
        derivative: "thumbnail",
        // A raw key where the contract requires a handle (§10.3.2, §0.15).
        objectKey: `thumbnails/${asset.contentHash}.webp`,
        bytes: 48_120,
        width: 600,
        height: 900,
        format: "webp",
        processorVersion: 3,
        watermarkVersion: 2,
        contentHash: asset.contentHash,
      })
    );

    expect(response.status).toBe(422);
    expect((await errorBody(response)).code).toBe("validation_failed");

    const stored = await assetRow(asset.assetId);
    expect(stored?.status).toBe("stored");
    expect(stored?.derivatives).toEqual({});
  });
});

/* ═════ F2, F3, F4, F6: the values the boundary must not take on trust ═════ */

/**
 * Findings F2, F3, F4 and F6 of the review of the OP-135 GREEN (ADR-0833 §4's
 * record is the sign-off these extend; ADR-0834 is this card's record).
 *
 * Each case states the **observable** a caller can see, never how the route
 * gets there, so the GREEN may restructure freely:
 *
 * - **F2 — the derivative's key is the asset's own.** The stored
 *   `derivatives.<variant>.objectKey` is `<variant>s/<asset.contentHash>.<format>`
 *   and a body whose `contentHash`/`format` the asset does not own is refused
 *   with `422` **before** the write. `objectKeyRef` is an opaque correlation
 *   handle and never key material; the raw-`objectKey` refusal above already
 *   pins the other half of §0.15, so it is referenced here rather than repeated.
 *   Because a legitimate body must carry the asset's own hash, "the body's
 *   hash" and "the asset's hash" are the same string — the discrimination in
 *   this section lives in the refusal rows, and the key-shape rows are
 *   regression locks (ADR-0834 §3 records that honestly).
 * - **F3 — the report batch is capped** at §10.3.2's 100 items and refused by
 *   body validation (`422`) before the first read, exactly as
 *   `/internal/domain-events` caps its own batch at the same number. The cap is
 *   inclusive: a report of exactly 100 items must apply all 100.
 * - **F4 — the lease decides at *write* time.** Two reports for one item that
 *   both read the lease must not both apply, and the loser must not overwrite
 *   the winner's verdict. The selfie arm writes two rows and they are one unit:
 *   a failing profile write leaves the selfie row unwritten.
 * - **F6 — the event instant is bounded.** An `occurredAt` more than 24 h
 *   *ahead* of `systemClock` is refused in that item's `rejected[]` only — the
 *   rest of the batch still commits, exactly as `unknown_event_key` behaves —
 *   because that is the direction in which the caller's own value can push
 *   `expireAt` past the platform's retention. An instant inside the window is
 *   still stamped from the worker's value, which is contract (§10.3.2). The
 *   window is deliberately **one-sided**: an instant in the past is a
 *   legitimate worker backlog (the frozen batch cases post a fixed
 *   `2026-09-25` instant), so a symmetric ±24 h rule is not what the pin can
 *   adopt — ADR-0834 §6 measures why.
 */

/** A well-formed sha256 digest that is simply not any seeded asset's. */
const FOREIGN_DIGEST = createHash("sha256").update("op135-f2-foreign-derivative").digest("hex");

/* ─────── F2: the derivative's stored key belongs to the asset ───────────── */

/** One derivative refusal: a hash/format pair the asset does not own. */
interface DerivativeRefusal {
  /** The case-local tag, so no two rows share a tenant, asset or message. */
  readonly tag: string;
  /** What the row's body gets wrong, as the case name reads it. */
  readonly label: string;
  /** The `contentHash` the body carries, derived from the seeded asset. */
  readonly contentHash: (asset: SeededAsset) => string;
  /** The `format` the body carries. */
  readonly format: string;
}

const DERIVATIVE_REFUSALS: readonly DerivativeRefusal[] = [
  {
    tag: "op135-f2-traversal",
    label: "a traversal-shaped hash and format",
    contentHash: (_asset) => "../../etc/passwd",
    format: "webp/../../evil",
  },
  {
    tag: "op135-f2-foreign-digest",
    label: "a well-formed digest that is not this asset's",
    contentHash: (_asset) => FOREIGN_DIGEST,
    format: "webp",
  },
  {
    tag: "op135-f2-bad-format",
    label: "a format the pipeline never writes",
    contentHash: (asset) => asset.contentHash,
    format: "exe",
  },
];

describe("when the thumbnail processor reports a derivative the asset does not own", () => {
  it.each(DERIVATIVE_REFUSALS)(
    "F2: refuses $label with 422 and leaves the stored derivatives untouched",
    async (fixture) => {
      const seeded = await world(fixture.tag);
      const asset = await seedAsset(seeded.tenantKey, fixture.tag);

      const response = await derivativeCompleteHandler(
        signedPost(DERIVATIVE_PATH, {
          assetId: asset.assetId.toHexString(),
          derivative: "thumbnail",
          objectKeyRef: "hnd_6b1e4c9a2f7d3085",
          bytes: 48_120,
          width: 600,
          height: 900,
          format: fixture.format,
          processorVersion: 3,
          watermarkVersion: 2,
          contentHash: fixture.contentHash(asset),
        })
      );

      expect(response.status).toBe(422);
      expect((await errorBody(response)).code).toBe("validation_failed");

      // The refusal is before the write: the asset is exactly as it was seeded.
      const stored = await assetRow(asset.assetId);
      expect(stored?.derivatives).toEqual({});
      expect(stored?.status).toBe("stored");
    }
  );
});

describe("when the thumbnail processor reports a derivative the asset owns", () => {
  it("F2: stores the key derived from the asset's own content hash and format", async () => {
    const seeded = await world("op135-f2-key");
    const asset = await seedAsset(seeded.tenantKey, "op135-f2-key");

    const response = await derivativeCompleteHandler(
      signedPost(DERIVATIVE_PATH, {
        assetId: asset.assetId.toHexString(),
        derivative: "thumbnail",
        objectKeyRef: "hnd_6b1e4c9a2f7d3085",
        bytes: 48_120,
        width: 600,
        height: 900,
        format: "webp",
        processorVersion: 3,
        watermarkVersion: 2,
        contentHash: asset.contentHash,
      })
    );

    expect(response.status).toBe(200);

    const thumbnail = (await assetRow(asset.assetId))?.derivatives as
      { thumbnail?: { objectKey?: unknown } } | undefined;
    // The whole key, not a substring: a derivation that drops the variant
    // prefix or the format is a different key the processor cannot resolve.
    expect(thumbnail?.thumbnail?.objectKey).toBe(`thumbnails/${asset.contentHash}.webp`);
  });

  it("F2: never puts the opaque handle in the stored key", async () => {
    const seeded = await world("op135-f2-handle");
    const asset = await seedAsset(seeded.tenantKey, "op135-f2-handle");
    const handle = "hnd_1a2b3c4d5e6f7081";

    const response = await derivativeCompleteHandler(
      signedPost(DERIVATIVE_PATH, {
        assetId: asset.assetId.toHexString(),
        derivative: "preview",
        objectKeyRef: handle,
        bytes: 152_480,
        width: 1_200,
        height: 1_800,
        format: "webp",
        processorVersion: 3,
        watermarkVersion: 2,
        contentHash: asset.contentHash,
      })
    );

    expect(response.status).toBe(200);

    const stored = (await assetRow(asset.assetId))?.derivatives as
      { preview?: { objectKey?: unknown } } | undefined;
    const objectKey = String(stored?.preview?.objectKey);
    // §0.15: the handle the processor sent is not key material.
    expect(objectKey).toBe(`previews/${asset.contentHash}.webp`);
    expect(objectKey).not.toContain(handle);
  });
});
