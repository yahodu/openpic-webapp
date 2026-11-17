import { memoryWorkQueue } from "@/server/adapters/memory-queue";
import { createUpstashQueue } from "@/server/adapters/upstash-queue";
import { getQueueRuntimeConfig } from "@/server/config/env";
import { getLogger } from "@/server/logging";
import type { WorkQueue } from "@/server/queue/work-queue";

/**
 * The queue composition root (OP-124, ADR-0721 D5).
 *
 * `getWorkQueue()` maps the validated `QUEUE_PROVIDER` selection onto a
 * concrete {@link WorkQueue}, mirroring `getObjectStorage()` and
 * `getPaymentProvider()`: `memory` is the test/e2e adapter, any other selection
 * is the Upstash REST adapter built from `getQueueRuntimeConfig()` (which fails
 * closed when its credentials are missing).
 *
 * It is **memoized** for the same reason the object store is: a route enqueues
 * through this function and a spec (or the sweep) reads the same broker back
 * through it, so a fresh adapter per call would lose the pointer.
 */

let cachedQueue: WorkQueue | undefined;

/**
 * Resolve the configured `WorkQueue`.
 *
 * @returns The memoized queue adapter for the selected provider.
 * @throws {ConfigError} When a non-memory provider has no Upstash wiring.
 */
export function getWorkQueue(): WorkQueue {
  if (cachedQueue !== undefined) {
    return cachedQueue;
  }

  const config = getQueueRuntimeConfig();
  cachedQueue =
    "upstashUrl" in config
      ? createUpstashQueue({
          url: config.upstashUrl,
          token: config.upstashToken,
          logger: getLogger(),
        })
      : memoryWorkQueue();
  return cachedQueue;
}
