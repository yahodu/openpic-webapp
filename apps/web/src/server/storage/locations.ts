import { ConfigError } from "@/server/config/env";

/**
 * The logical storage locations (OP-112, schema §11.2, ADR-0520 §3).
 *
 * A stored document names a **logical** location and nothing else; the
 * physical bucket, region and credentials are resolved at runtime from
 * config. Moving R2 buckets or swapping R2 for S3 is a config change plus a
 * copy job — not a rewrite of the media documents — and the bucket name is
 * what §0.15 keeps out of every response.
 */
export type StorageLocationKey = "originals" | "thumbnails" | "exports" | "branding";

/** The closed §11.2 vocabulary, in contract order. */
const STORAGE_LOCATIONS: readonly StorageLocationKey[] = [
  "originals",
  "thumbnails",
  "exports",
  "branding",
];

/**
 * Narrow an arbitrary string to the contract vocabulary.
 *
 * Values read back from a document are `string`, not the closed union, so
 * every boundary that accepts a location runs this guard before resolving it
 * to a bucket.
 *
 * @param value - A location as stored or as supplied by a caller.
 * @returns `true` exactly for `originals`/`thumbnails`/`exports`/`branding`.
 */
export function isStorageLocationKey(value: string): value is StorageLocationKey {
  return (STORAGE_LOCATIONS as readonly string[]).includes(value);
}

/**
 * Resolve a logical location to its physical bucket through an injected map.
 *
 * The map is a deployment detail (the fixture's `originals → "bkt-a1"` is
 * deliberately *not* `openpic-originals`, so "the logical key never reaches
 * the URL" stays a real assertion). A location outside the vocabulary, or a
 * known location the deployment's map does not carry, is a configuration
 * fault — refused loudly instead of resolved to `undefined` and used as a
 * bucket name.
 *
 * @param locationKey - A `StorageLocationKey` (or a string read back that
 * should have been one).
 * @param buckets - The injected logical→physical map.
 * @returns The physical bucket name.
 * @throws {ConfigError} Naming the offending location, for an unknown key or
 * a known key the map does not carry. Never returns `undefined`.
 */
export function bucketForLocation(
  locationKey: string,
  buckets: Readonly<Record<string, string>>
): string {
  if (!isStorageLocationKey(locationKey)) {
    throw new ConfigError([`storage.location.${locationKey}`]);
  }
  const bucket = buckets[locationKey];
  if (bucket === undefined) {
    throw new ConfigError([`storage.bucket.${locationKey}`]);
  }
  return bucket;
}
