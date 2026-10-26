/**
 * The storage composition root (OP-114, ADR-0540 §4).
 *
 * `getObjectStorage()` maps the validated `STORAGE_PROVIDER` selection onto a
 * concrete {@link ObjectStorage}, mirroring `getPaymentProvider()` /
 * `getMessageTransport()`:
 *
 *   - `memory` — the in-process adapter an e2e (and the integration suite)
 *     drives. It must be **memoized**: the route stores through this function
 *     and a test reads the stored bytes back through the same function, so a
 *     fresh store per call would lose the route's writes (ADR-0540 §4).
 *   - `s3` — the OP-112 R2 adapter, built from the deployment's `R2_*` runtime
 *     wiring. The bucket map resolves the four logical locations
 *     (`originals`/`thumbnails`/`exports`/`branding`) to that deployment's
 *     physical buckets; a missing R2 key fails closed with a `ConfigError`
 *     naming it, exactly like a missing `CASHFREE_*` key.
 *   - any other selection — no adapter exists, so it **fails closed** with a
 *     `ConfigError` naming the offending key.
 *
 * Importing this module is side-effect free.
 */
import { memoryObjectStorage } from "@/server/adapters/memory-object-storage";
import { createR2ObjectStorage } from "@/server/adapters/r2/r2-object-storage";
import { ConfigError, getConfig, getStorageRuntimeConfig } from "@/server/config/env";
import type { ObjectStorage } from "@/server/storage/object-storage";

/** The memoized memory store, so a test reads back what the route wrote. */
let cachedMemoryStorage: ObjectStorage | undefined;

/**
 * Resolve the configured object-storage adapter.
 *
 * @returns The `ObjectStorage` selected by `STORAGE_PROVIDER`.
 * @throws {ConfigError} When the selection is `s3` without the `R2_*` wiring,
 *   or a selection with no adapter is configured. `getConfig()` already
 *   refuses `STORAGE_PROVIDER=memory` under `APP_ENV=production`.
 */
export function getObjectStorage(): ObjectStorage {
  const config = getConfig();

  if (config.storage.provider === "memory") {
    cachedMemoryStorage ??= memoryObjectStorage();
    return cachedMemoryStorage;
  }

  if (config.storage.provider === "s3") {
    const r2 = getStorageRuntimeConfig().r2;
    if (r2 !== null) {
      return createR2ObjectStorage(r2);
    }
  }

  throw new ConfigError(["STORAGE_PROVIDER"]);
}
