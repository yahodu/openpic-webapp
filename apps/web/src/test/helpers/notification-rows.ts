import { ObjectId, type Db } from "mongodb";

/**
 * `notifications` feed-row fixtures (OP-97, schema §19.4).
 *
 * The feed suites seed the collection directly rather than driving the fan-out:
 * the read path under test must behave correctly for whatever is stored, and a
 * fan-out run would couple every filter assertion to routing, template and
 * preference machinery. Every row is schema-shaped (see the `FeedRow` written
 * by `@/server/notifications/fan-out`) so the read path sees exactly what
 * production stores.
 */

/** The `notifications` collection (schema §12/§19.4). */
export const NOTIFICATIONS_COLLECTION = "notifications";

/** One renderable in-app action as stored (schema §19.4). */
export interface StoredFeedAction {
  readonly key: string;
  readonly label: string;
  readonly style: string;
  readonly state: "available" | "unavailable";
}

/** One stored in-app action target (schema §19.4, §7). */
export interface StoredActionTarget {
  readonly kind: string;
  readonly id: string;
  readonly state: string;
}

/** Fields a feed-row fixture may override; the rest take deterministic defaults. */
export interface FeedRowInput {
  readonly userId: ObjectId;
  readonly typeKey: string;
  readonly severity?: string;
  readonly title?: string;
  readonly body?: string;
  readonly data?: Record<string, unknown>;
  readonly groupKey?: string | null;
  readonly groupCount?: number;
  readonly actionTarget?: StoredActionTarget | null;
  readonly actions?: readonly StoredFeedAction[];
  readonly readAt?: Date | null;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
  readonly expireAt?: Date;
  readonly eventId?: ObjectId | null;
  readonly tenantId?: string | null;
}

/** The fixed instant every seeded row defaults to, so assertions are exact. */
export const ROW_CREATED_AT = new Date("2026-03-01T00:00:00.000Z");

/** Ninety days after {@link ROW_CREATED_AT} — the schema §19.4 TTL horizon. */
export const ROW_EXPIRES_AT = new Date("2026-05-30T00:00:00.000Z");

/**
 * Insert one stored feed row and return its id.
 *
 * @param database - The database under test.
 * @param input - The fields to state; everything else is deterministic.
 * @returns The inserted `_id`.
 */
export async function insertFeedRow(database: Db, input: FeedRowInput): Promise<ObjectId> {
  const _id = new ObjectId();
  const createdAt = input.createdAt ?? ROW_CREATED_AT;

  await database.collection(NOTIFICATIONS_COLLECTION).insertOne({
    _id,
    userId: input.userId,
    tenantId: input.tenantId ?? null,
    eventId: input.eventId ?? null,
    typeKey: input.typeKey,
    severity: input.severity ?? "informational",
    titleKey: input.typeKey,
    title: input.title ?? "Seeded notification",
    body: input.body ?? "Seeded body",
    data: input.data ?? {},
    groupKey: input.groupKey ?? null,
    groupCount: input.groupCount ?? 1,
    actionTarget: input.actionTarget ?? null,
    actions: input.actions ?? [],
    readAt: input.readAt ?? null,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    expireAt: input.expireAt ?? new Date(createdAt.getTime() + 90 * 24 * 60 * 60 * 1000),
  });

  return _id;
}
