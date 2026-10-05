import type { Db, Document } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { platformRepo, type RepositoryCollection } from "@/server/repos";
import { systemClock, type Clock } from "@/server/runtime/clock";

import { notificationTemplateSchema, type NotificationTemplate } from "./notification-templates";
import { SEED_NOTIFICATION_TEMPLATES } from "./notification-templates.values";
import { notificationTypeSchema, type NotificationType } from "./notification-types";
import { SEED_NOTIFICATION_TYPES } from "./notification-types.values";

/**
 * The `notificationTypes` / `notificationTemplates` seeds (OP-84, schema
 * §19.1–§19.2, contract §7.6).
 *
 * Both are **create-or-reconcile**, mirroring the `plans` seed (ADR-0014 §6,
 * ADR-0015): a missing document is inserted with the catalogue `version`; a
 * document whose routing/copy differs is rewritten and its `version` advanced by
 * **exactly one**; an idempotent re-run leaves every `version` untouched. This
 * makes `version` a faithful audit signal of "the routing matrix changed" — an
 * implementation that always wrote the catalogue version would falsely imply a
 * change on every deploy (I1).
 *
 * Each document is kept current with **one atomic aggregation-pipeline upsert**
 * (ADR-0015): the comparison and the `version` computation happen server-side in
 * the same operation, so a run cannot reconcile against a stale document.
 * Nothing is read before the write. `types?` / `templates?` are injectable so
 * I1 can simulate a matrix edit shipped in a deploy.
 *
 * Both collections are platform-scope (schema §12), so they are reached through
 * `platformRepo` — the `no-direct-collection-access` rule forbids raw
 * `db.collection(...)` outside `src/server/{db,repos}`.
 */

/** The stored fields whose change means "the routing matrix changed" (excludes `version`/`updatedAt`). */
const ROUTING_FIELDS = [
  "typeKey",
  "category",
  "audiences",
  "channelGroups",
  "transactional",
  "severity",
  "respectQuietHours",
  "throttle",
  "dedupe",
  "retainBody",
  "actionable",
  "enabled",
] as const satisfies readonly (keyof NotificationType)[];

/** The stored fields whose change means "the copy changed" (excludes `version`/`updatedAt`). */
const TEMPLATE_FIELDS = [
  "typeKey",
  "channel",
  "locale",
  "subjectTemplate",
  "bodyTemplate",
  "variables",
  "providerRefs",
  "active",
] as const satisfies readonly (keyof NotificationTemplate)[];

/** MongoDB's duplicate-key server error code. */
const DUPLICATE_KEY = 11000;

/** Optional seams for {@link seedNotificationTypes}. */
export interface SeedNotificationTypesOptions {
  /** The database handle; defaults to the shared client (OP-75). */
  readonly db?: Db;
  /** The catalogue to seed; defaults to {@link SEED_NOTIFICATION_TYPES}. Tests inject a mutated set. */
  readonly types?: readonly NotificationType[];
  /** The clock stamped into `updatedAt`; defaults to the system clock. */
  readonly clock?: Clock;
}

/** Optional seams for {@link seedNotificationTemplates}. */
export interface SeedNotificationTemplatesOptions {
  /** The database handle; defaults to the shared client (OP-75). */
  readonly db?: Db;
  /** The templates to seed; defaults to {@link SEED_NOTIFICATION_TEMPLATES}. */
  readonly templates?: readonly NotificationTemplate[];
  /** The clock stamped into `updatedAt`; defaults to the system clock. */
  readonly clock?: Clock;
}

/** True when `error` is MongoDB's duplicate-key error (the unique index rejected an insert). */
function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === DUPLICATE_KEY
  );
}

/**
 * In-process serialization of seed runs, keyed by database + collection.
 *
 * The `{typeKey:1}` / `(typeKey, channel, locale, active)` unique indexes are the
 * cross-process backstop, but a database not yet bootstrapped carries no index —
 * and MongoDB's upsert has a documented race where two writers that both miss
 * can both insert. Coalescing same-process runs makes that case deterministic;
 * cross-process races are still absorbed by the unique index (see
 * {@link upsertByFilter}).
 */
const seedQueues = new Map<string, Promise<void>>();

/**
 * Run `task` after any in-flight seed already queued for `lockKey`.
 *
 * @param lockKey - The database + collection the seed writes.
 * @param task - The work to run exclusively.
 * @returns The task's result, once every earlier queued seed has settled.
 */
function runExclusive<T>(lockKey: string, task: () => Promise<T>): Promise<T> {
  const previous = seedQueues.get(lockKey) ?? Promise.resolve();
  const result = previous.then(task, task);
  seedQueues.set(
    lockKey,
    result.then(
      () => undefined,
      () => undefined
    )
  );
  return result;
}

/**
 * Apply `fields` and compute `version` in one aggregation update.
 *
 * `version` is left untouched when the stored document already equals the
 * catalogue (an idempotent re-run), and advanced by exactly one otherwise. The
 * `$literal` keeps every catalogue value an opaque value rather than a field
 * path expression.
 *
 * @param fields - The stored fields to compare and write.
 * @param version - The catalogue's version, used only on insert.
 * @param updatedAt - The clock reading stamped into the document.
 * @returns The update pipeline for `updateOne(filter, …, { upsert: true })`.
 */
function reconcilePipeline(
  fields: readonly (keyof NotificationType | keyof NotificationTemplate)[],
  source: Record<string, unknown>,
  version: number,
  updatedAt: Date
): Document[] {
  const set: Document = { updatedAt };
  const equals: Document[] = [];

  for (const field of fields) {
    const literal = { $literal: source[field] };
    set[field] = literal;
    equals.push({ $eq: [`$${field}`, literal] });
  }

  set.version = {
    $cond: [
      { $and: equals },
      { $ifNull: ["$version", version] },
      { $add: [{ $ifNull: ["$version", { $subtract: [version, 1] }] }, 1] },
    ],
  };

  return [{ $set: set }];
}

/**
 * Upsert one document, tolerating the documented racing-upsert `E11000`.
 *
 * When two writers race the initial insert, one wins and the other's upsert
 * surfaces a duplicate-key error from the unique index. The loser re-applies the
 * same pipeline as a plain update, reconciling against the winner's document.
 *
 * @param collection - The platform-scope collection handle.
 * @param filter - The natural-key filter (`{ typeKey }` or `{ typeKey, channel, locale }`).
 * @param pipeline - The reconcile pipeline.
 */
async function upsertByFilter(
  collection: RepositoryCollection,
  filter: Document,
  pipeline: Document[]
): Promise<void> {
  try {
    await collection.updateOne(filter, pipeline, { upsert: true });
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }
    await collection.updateOne(filter, pipeline);
  }
}

/**
 * Seed the `notificationTypes` catalogue, create-or-reconcile (I1).
 *
 * @param options - The database/catalogue/clock seams.
 * @returns The validated catalogue that was seeded.
 */
export async function seedNotificationTypes(
  options: SeedNotificationTypesOptions = {}
): Promise<readonly NotificationType[]> {
  const clock = options.clock ?? systemClock;
  const catalogue = (options.types ?? SEED_NOTIFICATION_TYPES).map((type) =>
    notificationTypeSchema.parse(type)
  );
  const db = options.db ?? getDb();
  const collection = platformRepo(db).collection(COLLECTIONS.notificationTypes);
  const updatedAt = clock.now();

  return runExclusive(`${db.databaseName}\u0000${COLLECTIONS.notificationTypes}`, async () => {
    for (const type of catalogue) {
      const pipeline = reconcilePipeline(ROUTING_FIELDS, type, type.version, updatedAt);
      await upsertByFilter(collection, { typeKey: type.typeKey }, pipeline);
    }
    return catalogue;
  });
}

/**
 * Seed the `notificationTemplates` catalogue, create-or-reconcile (I1).
 *
 * Upserts by `(typeKey, channel, locale)`, with the same version-on-change
 * semantics as {@link seedNotificationTypes}.
 *
 * @param options - The database/templates/clock seams.
 * @returns The validated templates that were seeded.
 */
export async function seedNotificationTemplates(
  options: SeedNotificationTemplatesOptions = {}
): Promise<readonly NotificationTemplate[]> {
  const clock = options.clock ?? systemClock;
  const templates = (options.templates ?? SEED_NOTIFICATION_TEMPLATES).map((template) =>
    notificationTemplateSchema.parse(template)
  );
  const db = options.db ?? getDb();
  const collection = platformRepo(db).collection(COLLECTIONS.notificationTemplates);
  const updatedAt = clock.now();

  return runExclusive(`${db.databaseName}\u0000${COLLECTIONS.notificationTemplates}`, async () => {
    for (const template of templates) {
      const pipeline = reconcilePipeline(TEMPLATE_FIELDS, template, template.version, updatedAt);
      await upsertByFilter(
        collection,
        { typeKey: template.typeKey, channel: template.channel, locale: template.locale },
        pipeline
      );
    }
    return templates;
  });
}
