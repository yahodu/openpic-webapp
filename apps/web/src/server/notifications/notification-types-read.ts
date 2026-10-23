import type { Db } from "mongodb";

import { getAppEnv } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { getLogger } from "@/server/logging";
import { platformRepo } from "@/server/repos";

import { notificationTypeSchema, type NotificationType } from "./notification-types";
import { SEED_NOTIFICATION_TYPES } from "./notification-types.values";

/**
 * The enabled `notificationTypes` catalogue read (OP-98, contract §7.6).
 *
 * Both the settings read (`GET /me/notification-preferences`) and the public
 * catalogue (`GET /notification-types`) need the catalogue **as data**, so the
 * read lives once here. A disabled row is a routing fact (design §8): it is
 * never merged into a merged document and never offered by the catalogue.
 *
 * ## The sanctioned seed-catalogue fallback
 *
 * The catalogue is seeded at boot by `instrumentation.ts`, but a database that
 * has not been seeded yet has no rows at all — and a settings screen that
 * silently resolves against nothing is worse than one served from the shipped
 * routing matrix. When the collection is empty the compile-time
 * {@link SEED_NOTIFICATION_TYPES} stands in, exactly as the fan-out resolver's
 * `seededTypeRow` does (ADR-0098 §6, ADR-0102): **production must never serve
 * the seed behind an empty catalogue**, so the fallback throws there and only
 * logs at `warn` elsewhere.
 */

/** Options accepted by {@link listEnabledNotificationTypes}. */
export interface ListEnabledNotificationTypesOptions {
  /** The database handle; defaults to the shared client. */
  readonly db?: Db;
}

/**
 * Guard the sanctioned seed-catalogue fallback against silence (ADR-0102).
 *
 * @param collection - The catalogue collection the fallback stands in for.
 * @throws When the process runs in production.
 */
function guardCatalogueFallback(collection: string): void {
  if (getAppEnv() === "production") {
    throw new Error(`notification catalogue is empty in production: ${collection}`);
  }
  getLogger().warn("notification.catalogue_fallback", {
    event: "notification.catalogue_fallback",
    collection,
  });
}

/**
 * Read every enabled `notificationTypes` document, validated and catalogue-shaped.
 *
 * @param options - The database seam.
 * @returns One validated {@link NotificationType} per enabled row; the shipped
 *   seed when the stored catalogue is empty (non-production only).
 */
export async function listEnabledNotificationTypes(
  options: ListEnabledNotificationTypesOptions = {}
): Promise<NotificationType[]> {
  const rows = await platformRepo(options.db ?? getDb())
    .collection(COLLECTIONS.notificationTypes)
    .find({})
    .toArray();

  if (rows.length === 0) {
    guardCatalogueFallback(COLLECTIONS.notificationTypes);
    return SEED_NOTIFICATION_TYPES.filter((type) => type.enabled);
  }

  const types: NotificationType[] = [];
  for (const row of rows) {
    const parsed = notificationTypeSchema.safeParse(row);
    if (parsed.success && parsed.data.enabled) {
      types.push(parsed.data);
    }
  }
  return types;
}
