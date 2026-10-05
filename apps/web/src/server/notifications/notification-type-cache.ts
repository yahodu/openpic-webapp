import type { Db } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { platformRepo } from "@/server/repos";
import { systemClock, type Clock } from "@/server/runtime/clock";

/**
 * The `notification_types` enabled-set read cache (OP-88 follow-up, finding 1 /
 * decision D1).
 *
 * The outbox writer needs to know which `typeKey`s are enabled on every emit.
 * A per-emit `findOne` turns that hot write path into one extra round-trip per
 * event, so this accessor replaces it with a clock-once TTL cache mirroring
 * {@link getPlatformSettings} (`@/server/settings/platform-settings`).
 *
 *   - one bounded `find({}, { projection: { typeKey: 1, enabled: 1 } })` per TTL
 *     window against `COLLECTIONS.notificationTypes`, deriving the enabled set
 *     in code (`enabled === true`);
 *   - the injected {@link Clock} is read exactly once per call, so the TTL is
 *     deterministic under `fixedClock(start, stepMs)` (ADR-0007);
 *   - a hit returns while `nowMs < expiresAt` (strict `<`); at/after expiry the
 *     next call re-reads;
 *   - {@link invalidateNotificationTypeCache} forces the next call to re-read.
 *
 * The cache is process-wide, so callers that must observe an operator's change
 * inside the window call the invalidator explicitly.
 */

/** Recommended cache lifetime; overridable per call (30 000 ms). */
export const NOTIFICATION_TYPE_CACHE_TTL_MS = 30_000;

/** A cached enabled set and the instant its TTL elapses. */
interface EnabledTypeKeysCacheEntry {
  readonly keys: ReadonlySet<string>;
  readonly expiresAt: number;
}

/** The process-wide read cache. Cleared by {@link invalidateNotificationTypeCache}. */
let cache: EnabledTypeKeysCacheEntry | null = null;

/** Optional seams for {@link getEnabledNotificationTypeKeys}. */
export interface GetEnabledNotificationTypeKeysOptions {
  /** The database handle; defaults to the shared client. */
  readonly db?: Db;
  /** The clock used for the TTL; defaults to the system clock. */
  readonly clock?: Clock;
  /** The cache lifetime in milliseconds; defaults to 30 000. */
  readonly ttlMs?: number;
}

/** Read the whole catalogue once and derive the enabled `typeKey` set. */
async function loadEnabledTypeKeys(db: Db | undefined): Promise<ReadonlySet<string>> {
  const rows = await platformRepo(db)
    .collection(COLLECTIONS.notificationTypes)
    .find({}, { projection: { typeKey: 1, enabled: 1 } })
    .toArray();

  const keys = new Set<string>();
  for (const row of rows) {
    const { typeKey, enabled } = row as { typeKey?: unknown; enabled?: unknown };
    if (enabled === true && typeof typeKey === "string") {
      keys.add(typeKey);
    }
  }
  return keys;
}

/**
 * Read the set of enabled notification `typeKey`s, cached for `ttlMs`.
 *
 * The injected clock is read exactly once per call, so the cache expiry is
 * deterministic. A hit returns the same set reference; once the TTL lapses (or
 * after {@link invalidateNotificationTypeCache}) the very next call re-reads
 * the database.
 *
 * @param options - The database/clock/TTL seams.
 * @returns The enabled `typeKey`s as a read-only set.
 */
export async function getEnabledNotificationTypeKeys(
  options: GetEnabledNotificationTypeKeysOptions = {}
): Promise<ReadonlySet<string>> {
  const clock = options.clock ?? systemClock;
  const ttlMs = options.ttlMs ?? NOTIFICATION_TYPE_CACHE_TTL_MS;
  const nowMs = clock.now().getTime();

  const cached = cache;
  if (cached !== null && nowMs < cached.expiresAt) {
    return cached.keys;
  }

  const keys = await loadEnabledTypeKeys(options.db);
  cache = { keys, expiresAt: nowMs + ttlMs };

  return keys;
}

/**
 * Drop the cached enabled set so the very next
 * {@link getEnabledNotificationTypeKeys} reads the database. The single
 * sanctioned way to observe a notification-type change within the TTL.
 */
export function invalidateNotificationTypeCache(): void {
  cache = null;
}
