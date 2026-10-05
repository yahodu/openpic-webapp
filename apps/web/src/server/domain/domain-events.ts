import type { ClientSession, Db, Document, ObjectId } from "mongodb";
import { ObjectId as ObjectIdValue } from "mongodb";
import { z } from "zod";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { getLogger } from "@/server/logging";
import { getEnabledNotificationTypeKeys } from "@/server/notifications/notification-type-cache";
import { NOTIFICATION_TYPE_KEYS } from "@/server/notifications/notification-types.values";
import { platformRepo } from "@/server/repos";
import { systemClock, type Clock } from "@/server/runtime/clock";
import { addDays, addMilliseconds } from "@/server/runtime/time";
import { getPlatformSettings } from "@/server/settings/platform-settings";

/**
 * Domain-event outbox — the single write point for the fan-out (OP-88, schema
 * §18.3, contract §7.7, ADR-0029).
 *
 * Business code calls {@link emitDomainEvent} once per domain change; the
 * notification fan-out, the analytics rollup and the queue publisher are
 * independent consumers that each flip their own `dispatch.*` flag on the row
 * later, so none of them can block another. This module is the only door to
 * that write, which is what keeps a contact-bearing payload out of the
 * append-only log and guarantees the event joins the caller's transaction.
 *
 * - {@link emitDomainEvent} validates, gates the `eventKey`, deep-scans the
 *   payload, derives `expireAt` from `platformSettings`, inserts once (deduping
 *   on an optional `dedupeKey`) and logs `domain_event.emitted`.
 * - {@link claimPendingEvents} atomically claims up to a batch of rows for one
 *   consumer, reclaiming claims stale for more than five minutes.
 * - {@link markDone} / {@link markFailed} complete or retry a claim.
 */

/** The registered analytics-only event keys (no notification type) — contract §7.7. */
export const ANALYTICS_ONLY_EVENT_KEYS: readonly string[] = ["event.viewed"];

/** The payload keys that must never reach the outbox (ADR-0029 §3). */
const FORBIDDEN_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  "email",
  "phone",
  "token",
  "otp",
  "embedding",
  "vector",
  "password",
]);

/** A consumer of the outbox; each owns one `dispatch.*` flag. */
export type DomainEventConsumer = "notifications" | "analytics" | "queue";

/** The lifecycle of one consumer's dispatch flag for one event. */
export type DomainEventDispatchStatus =
  "pending" | "in_progress" | "done" | "skipped" | "not_applicable";

/** The per-consumer dispatch flags stored on the outbox row. */
export interface DomainEventDispatch {
  readonly notifications: DomainEventDispatchStatus;
  readonly analytics: DomainEventDispatchStatus;
  readonly queue: DomainEventDispatchStatus;
}

/** A reference to the actor or subject of an event — an identifier pair only. */
export interface DomainEventRef {
  readonly kind: string;
  readonly id: string;
}

/**
 * The shape {@link emitDomainEvent} accepts.
 *
 * `eventKey`, `actorRef.kind` and `subjectRef.kind` are plain `string`s gated
 * at runtime (Zod + the catalogue), never a closed enum: the catalogue is data
 * and the boundary must be able to reject an unknown key (ADR-0029 §1).
 */
export interface DomainEventInput {
  readonly eventKey: string;
  readonly tenantId: string;
  readonly actorRef: DomainEventRef;
  readonly subjectRef: DomainEventRef;
  readonly payload: Record<string, unknown>;
  readonly dedupeKey?: string;
}

/** A persistent outbox row. */
export interface DomainEventDocument {
  readonly _id: ObjectId;
  readonly eventKey: string;
  readonly tenantId: string;
  readonly actorRef: DomainEventRef;
  readonly subjectRef: DomainEventRef;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
  readonly expireAt: Date;
  readonly dispatch: DomainEventDispatch;
  readonly dedupeKey?: string;
  readonly claimedAt?: Date;
  readonly claimedBy?: string;
}

/** The result of an emit: `deduped` on a `dedupeKey` collision, else the new id. */
export interface EmitDomainEventResult {
  readonly deduped: boolean;
  readonly id: string | null;
}

/** Seams for {@link emitDomainEvent}. */
export interface EmitDomainEventOptions {
  /** The database handle; defaults to the shared client. */
  readonly db?: Db;
  /** The clock that stamps `occurredAt`; defaults to the system clock. */
  readonly clock?: Clock;
  /** The caller's transaction; the insert joins it when supplied. */
  readonly session?: ClientSession;
}

/** Seams for {@link claimPendingEvents}. */
export interface ClaimPendingEventsOptions {
  /** The database handle; defaults to the shared client. */
  readonly db?: Db;
  /** The clock that stamps `claimedAt` and measures the stale lease. */
  readonly clock?: Clock;
  /** An optional identifier recorded on the claim as `claimedBy`. */
  readonly claimerId?: string;
}

/** Seams for {@link markDone} / {@link markFailed}. */
export interface CompleteDomainEventOptions {
  /** The database handle; defaults to the shared client. */
  readonly db?: Db;
}

/** A document-event failure with the machine-readable `code` callers branch on. */
export class DomainEventError extends Error {
  /** The refusal code, e.g. `unknown_event_key` or `forbidden_payload_field`. */
  readonly code: string;

  /**
   * @param code - The machine-readable refusal code.
   * @param message - A human-readable explanation (never carries payload data).
   */
  constructor(code: string, message: string) {
    super(message);
    this.name = "DomainEventError";
    this.code = code;
  }
}

/** The runtime input contract; the plain-string fields are validated here. */
const domainEventInputSchema = z.object({
  eventKey: z.string().min(1),
  tenantId: z.string().min(1),
  actorRef: z.object({ kind: z.string().min(1), id: z.string().min(1) }),
  subjectRef: z.object({ kind: z.string().min(1), id: z.string().min(1) }),
  payload: z.record(z.string(), z.unknown()),
  dedupeKey: z.string().min(1).optional(),
});

/** MongoDB's duplicate-key server error code. */
const DUPLICATE_KEY = 11000;

/** How long a claim may sit `in_progress` before another consumer may reclaim it. */
const STALE_CLAIM_MS = 5 * 60_000;

/** True when an unknown `eventKey` is allowed: catalogue ∪ analytics-only. */
function isRegisteredEventKey(eventKey: string): boolean {
  return NOTIFICATION_TYPE_KEYS.includes(eventKey) || ANALYTICS_ONLY_EVENT_KEYS.includes(eventKey);
}

/** True for a plain (non-array) object, the shapes the payload scan recurses into. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Find the first forbidden key anywhere in a payload, at any depth.
 *
 * The match is **exact**, not a substring: `phoneNumber` is a resolvable
 * identifier, `phone` is contact data (ADR-0029 §3).
 */
function findForbiddenPayloadKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findForbiddenPayloadKey(item);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }

  if (isPlainRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_PAYLOAD_KEYS.has(key)) {
        return key;
      }
      const found = findForbiddenPayloadKey(child);
      if (found !== null) {
        return found;
      }
    }
  }

  return null;
}

/** True when an error is MongoDB's duplicate-key (E11000) refusal. */
function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === DUPLICATE_KEY
  );
}

/** Read the outbox handle (platform-scope: consumers drain it across tenants). */
function domainEventsCollection(db: Db) {
  return platformRepo(db).collection(COLLECTIONS.domainEvents);
}

/** The `notifications` flag: `pending` only when an enabled type exists. */
async function resolveNotificationsFlag(
  db: Db,
  clock: Clock,
  eventKey: string
): Promise<DomainEventDispatchStatus> {
  const enabledTypeKeys = await getEnabledNotificationTypeKeys({ db, clock });
  return enabledTypeKeys.has(eventKey) ? "pending" : "skipped";
}

/** Narrow a driver result to a stored outbox row, failing loudly on a bad shape. */
function toDomainEventDocument(raw: Document): DomainEventDocument {
  if (!(raw._id instanceof ObjectIdValue)) {
    throw new Error("domain_events document is missing an ObjectId _id");
  }
  return raw as unknown as DomainEventDocument;
}

/**
 * Record one domain event in the outbox.
 *
 * Validates the input, gates the `eventKey` (catalogue ∪ analytics-only),
 * rejects a payload that nests a contact/secret/vector key, stamps `occurredAt`
 * from the clock and `expireAt` from `platformSettings.retention.domainEventDays`,
 * then inserts once. A repeated `dedupeKey` is caught by the unique partial
 * index and returned as `{ deduped: true, id: null }`. When `options.session`
 * is supplied the insert joins the caller's transaction, so an aborted domain
 * change leaves no event.
 *
 * @param input - The event to record.
 * @param options - Database/clock/transaction seams.
 * @returns The new event id, or `{ deduped: true, id: null }` on a collision.
 * @throws DomainEventError `unknown_event_key` / `forbidden_payload_field` /
 *   `invalid_domain_event`.
 */
export async function emitDomainEvent(
  input: DomainEventInput,
  options: EmitDomainEventOptions = {}
): Promise<EmitDomainEventResult> {
  const parsed = domainEventInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainEventError(
      "invalid_domain_event",
      `domain event failed validation: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`
    );
  }
  const event = parsed.data;

  if (!isRegisteredEventKey(event.eventKey)) {
    throw new DomainEventError(
      "unknown_event_key",
      `eventKey "${event.eventKey}" is neither a notification typeKey nor an analytics-only key`
    );
  }

  const forbidden = findForbiddenPayloadKey(event.payload);
  if (forbidden !== null) {
    throw new DomainEventError(
      "forbidden_payload_field",
      `payload must not carry the "${forbidden}" key at any depth`
    );
  }

  const db = options.db ?? getDb();
  const clock = options.clock ?? systemClock;
  const occurredAt = clock.now();
  const settings = await getPlatformSettings({ db, clock });
  const expireAt = addDays(occurredAt, settings.retention.domainEventDays);
  const notifications = await resolveNotificationsFlag(db, clock, event.eventKey);

  const doc: Document = {
    eventKey: event.eventKey,
    tenantId: event.tenantId,
    actorRef: event.actorRef,
    subjectRef: event.subjectRef,
    payload: event.payload,
    occurredAt,
    expireAt,
    dispatch: {
      notifications,
      analytics: "pending",
      queue: "not_applicable",
    },
    ...(event.dedupeKey === undefined ? {} : { dedupeKey: event.dedupeKey }),
  };

  let insertedId: ObjectId;
  try {
    const result = await domainEventsCollection(db).insertOne(
      doc,
      options.session === undefined ? {} : { session: options.session }
    );
    insertedId = result.insertedId;
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return { deduped: true, id: null };
    }
    throw error;
  }

  getLogger().info("domain_event.emitted", {
    event: "domain_event.emitted",
    eventKey: event.eventKey,
    tenantId: event.tenantId,
    subjectRef: { kind: event.subjectRef.kind, id: event.subjectRef.id },
  });

  return { deduped: false, id: String(insertedId) };
}

/**
 * Atomically claim up to `batch` events for one consumer.
 *
 * Each document is claimed with a single atomic `pending -> in_progress`
 * transition (or a reclaim of an `in_progress` claim older than five minutes),
 * so two concurrent consumers can never claim the same event. Returns `[]` when
 * nothing is claimable.
 *
 * @param consumer - The dispatch flag to claim.
 * @param batch - The maximum number of events to claim.
 * @param options - Database/clock/claimer seams.
 * @returns The claimed rows, in claim order.
 */
export async function claimPendingEvents(
  consumer: DomainEventConsumer,
  batch: number,
  options: ClaimPendingEventsOptions = {}
): Promise<readonly DomainEventDocument[]> {
  const db = options.db ?? getDb();
  const clock = options.clock ?? systemClock;
  const now = clock.now();
  const staleBefore = addMilliseconds(now, -STALE_CLAIM_MS);
  const statusPath = `dispatch.${consumer}`;

  const filter: Document = {
    $or: [
      { [statusPath]: "pending" },
      {
        [statusPath]: "in_progress",
        $or: [{ claimedAt: { $lt: staleBefore } }, { claimedAt: { $exists: false } }],
      },
    ],
  };
  const update: Document = {
    $set: {
      [statusPath]: "in_progress",
      claimedAt: now,
      ...(options.claimerId === undefined ? {} : { claimedBy: options.claimerId }),
    },
  };

  const claimed: DomainEventDocument[] = [];
  for (let index = 0; index < batch; index += 1) {
    const raw: unknown = await domainEventsCollection(db).findOneAndUpdate(filter, update, {
      returnDocument: "after",
      sort: { occurredAt: 1 },
    });
    if (raw === null || raw === undefined) {
      break;
    }
    claimed.push(toDomainEventDocument(raw));
  }
  return claimed;
}

/** Coerce an event id (ObjectId or hex string) into the driver's `_id` value. */
function toObjectId(eventId: ObjectId | string): ObjectId {
  return typeof eventId === "string" ? new ObjectIdValue(eventId) : eventId;
}

/** Mark a claimed event `done` for one consumer. */
async function complete(
  eventId: ObjectId | string,
  consumer: DomainEventConsumer,
  status: DomainEventDispatchStatus,
  options: CompleteDomainEventOptions
): Promise<void> {
  const db = options.db ?? getDb();
  await domainEventsCollection(db).updateOne(
    { _id: toObjectId(eventId) },
    { $set: { [`dispatch.${consumer}`]: status } }
  );
}

/**
 * Mark a claimed event done for its consumer.
 *
 * @param eventId - The outbox row id.
 * @param consumer - The consumer that finished.
 * @param options - The database seam.
 */
export async function markDone(
  eventId: ObjectId | string,
  consumer: DomainEventConsumer,
  options: CompleteDomainEventOptions = {}
): Promise<void> {
  await complete(eventId, consumer, "done", options);
}

/**
 * Return a failed claim to `pending` so the consumer retries (at-least-once).
 *
 * @param eventId - The outbox row id.
 * @param consumer - The consumer that failed.
 * @param options - The database seam.
 */
export async function markFailed(
  eventId: ObjectId | string,
  consumer: DomainEventConsumer,
  options: CompleteDomainEventOptions = {}
): Promise<void> {
  await complete(eventId, consumer, "pending", options);
}
