import { describe, expect, it } from "vitest";

import { ConfigError } from "@/server/config/env";
import { bucketForLocation, isStorageLocationKey } from "@/server/storage/locations";

import { TEST_STORAGE_BUCKETS } from "../factories/storage";

/**
 * U3 — the `locationKey` → bucket map (OP-112; schema §11.2, contract §0.15).
 *
 * A stored document names a **logical** location (`originals`, `thumbnails`,
 * `exports`, `branding`) and nothing else; the physical bucket, region and
 * credentials are resolved at runtime from config. Moving R2 buckets or swapping
 * R2 for S3 is then a config change plus a copy job — not a rewrite of the
 * millions of `mediaAssets` documents — and the bucket name is what §0.15 keeps
 * out of every response.
 *
 * Values read back from a document are `string`, not the closed union, so the
 * map is the runtime guard: an unknown location, or a known one the deployment's
 * map does not carry, is refused rather than resolved to `undefined` and used as
 * a bucket name.
 */
describe("locationKey map", () => {
  it.each([
    ["originals", "bkt-a1"],
    ["thumbnails", "bkt-b2"],
    ["exports", "bkt-c3"],
    ["branding", "bkt-d4"],
  ] as const)("U3: resolves the %s location to its bucket", (locationKey, bucket) => {
    expect(bucketForLocation(locationKey, TEST_STORAGE_BUCKETS)).toBe(bucket);
  });

  it.each([
    ["a location outside the vocabulary", "videos"],
    ["a near-miss of a known location", "original"],
    ["an empty location", ""],
  ] as const)("U3: rejects %s", (_label, locationKey) => {
    expect(() => bucketForLocation(locationKey, TEST_STORAGE_BUCKETS)).toThrow(ConfigError);
  });

  it("U3: names the location that could not be resolved", () => {
    expect(() => bucketForLocation("videos", TEST_STORAGE_BUCKETS)).toThrow(/videos/);
  });

  it("U3: rejects a known location the deployment's map does not carry", () => {
    // A bucket map missing an entry is a configuration fault, not a silent
    // `undefined` — the mistake must never reach the wire.
    expect(() => bucketForLocation("originals", {})).toThrow(ConfigError);
  });

  it("U3: the type guard admits exactly the contract vocabulary", () => {
    expect(isStorageLocationKey("originals")).toBe(true);
    expect(isStorageLocationKey("branding")).toBe(true);
    expect(isStorageLocationKey("videos")).toBe(false);
    expect(isStorageLocationKey("Originals")).toBe(false);
  });
});
