/**
 * The §10.4 queue message envelope (OP-122, ADR-0680/0681).
 *
 * The message is a **pointer**: every field is an identifier, a scalar or the
 * enqueue timestamp, and all state is re-read from MongoDB at claim time. The
 * schema is therefore strict — an extra field is a contract violation, not a
 * tolerated annotation, because a message carrying an image URL or an embedding
 * would go stale in the queue and hand media coordinates to the broker.
 *
 * The same ten keys serve all three work types; `match_incremental` points `id`
 * at the profile instead of adding a `profileId` key.
 */
import { z } from "zod";

/** The three documented work types of §10.4. */
export const QUEUE_KINDS = ["event_image", "selfie", "match_incremental"] as const;

/** A §10.4 work type. */
export type QueueKind = (typeof QUEUE_KINDS)[number];

/** A priority step of the two logical queues. */
export type QueuePriority = "high" | "normal";

/** A physical queue key, `q:`-prefixed (§10.4). */
export type QueueKey = "q:selfie" | "q:image";

/** The wire shape of a MongoDB id inside the envelope. */
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/;

/**
 * The §10.4 envelope: exactly ten pointer fields, nothing else.
 *
 * @example
 * queueEnvelopeSchema.parse({ v: 1, kind: "selfie", ... });
 */
export const queueEnvelopeSchema = z.strictObject({
  v: z.literal(1),
  kind: z.enum(QUEUE_KINDS),
  id: z.string().regex(OBJECT_ID_HEX),
  tenantId: z.string().regex(OBJECT_ID_HEX),
  eventId: z.string().regex(OBJECT_ID_HEX),
  priority: z.enum(["high", "normal"]),
  spaceKey: z.string().min(1),
  enqueuedAt: z.iso.datetime(),
  attempt: z.number().int().min(0),
  traceId: z.string().min(1),
});

/** A validated §10.4 envelope. */
export type QueueEnvelope = z.infer<typeof queueEnvelopeSchema>;

/**
 * Resolve the physical queue a priority is drained from (§18.1): the physical
 * queue *is* the priority, so `q:selfie` is drained strictly before `q:image`.
 *
 * @param priority - The priority step.
 * @returns The `q:`-prefixed queue key.
 */
export function queueKeyFor(priority: QueuePriority): QueueKey {
  return priority === "high" ? "q:selfie" : "q:image";
}

/**
 * Resolve the priority a work type defaults to (§18.1).
 *
 * @param kind - The §10.4 work type.
 * @returns `high` for the two attendee-facing kinds, `normal` for a batch.
 */
export function defaultPriorityFor(kind: QueueKind): QueuePriority {
  return kind === "event_image" ? "normal" : "high";
}
