/**
 * `enqueueWork` — the non-fatal enqueue (OP-122, schema §18.1/§18.2).
 *
 * Two rules live here. The envelope is built **here** from the work item, so no
 * caller can smuggle a payload onto the broker (§10.4). And a failed enqueue is
 * never a failed user request: the item stays `queued` with no `queueRef`, the
 * sweep re-enqueues it, and the failure is a `warn` (§18.1).
 */
import { ObjectId, type Db } from "mongodb";

import type { CollectionName } from "../db/collections";
import type { Logger } from "../logging";
import { systemClock, type Clock } from "../runtime/clock";
import {
  defaultPriorityFor,
  queueKeyFor,
  type QueueEnvelope,
  type QueueKind,
  type QueuePriority,
} from "./envelope";
import type { WorkQueue } from "./work-queue";

/** The log event a failed enqueue leaves behind. */
export const ENQUEUE_FAILED_EVENT = "queue.enqueue_failed";

/** The pointer fields a work item hands to the queue. */
export interface WorkItemPointer {
  readonly kind: QueueKind;
  /** The work item id — the `profileId` for `match_incremental` (§10.4). */
  readonly id: string;
  readonly tenantId: string;
  readonly eventId: string;
  readonly spaceKey: string;
  /** The request id the work is correlated on. */
  readonly traceId: string;
  /** Defaults to {@link defaultPriorityFor} of the kind. */
  readonly priority?: QueuePriority;
  /** Defaults to `0`. */
  readonly attempt?: number;
}

/** Options for {@link enqueueWork}. */
export interface EnqueueWorkOptions {
  readonly db: Db;
  readonly queue: WorkQueue;
  /** The collection holding the work item. */
  readonly collection: CollectionName;
  readonly work: WorkItemPointer;
  readonly logger?: Logger;
  readonly clock?: Clock;
}

/**
 * Enqueue a work item and record the broker id on it.
 *
 * @param options - The database, queue, collection and the work pointer.
 * @returns `{ enqueued: false }` when the broker refused; never throws.
 */
export async function enqueueWork(options: EnqueueWorkOptions): Promise<{ enqueued: boolean }> {
  const { work } = options;
  const priority = work.priority ?? defaultPriorityFor(work.kind);
  const queueKey = queueKeyFor(priority);
  const envelope: QueueEnvelope = {
    v: 1,
    kind: work.kind,
    id: work.id,
    tenantId: work.tenantId,
    eventId: work.eventId,
    priority,
    spaceKey: work.spaceKey,
    enqueuedAt: (options.clock ?? systemClock).now().toISOString(),
    attempt: work.attempt ?? 0,
    traceId: work.traceId,
  };

  try {
    const { messageId } = await options.queue.enqueue(envelope, queueKey);
    await options.db.collection(options.collection).updateOne(
      { _id: new ObjectId(work.id) },
      {
        $set: {
          "processing.queueRef": { queueKey, provider: options.queue.provider, messageId },
        },
      }
    );
    return { enqueued: true };
  } catch (error) {
    options.logger?.warn("Queue enqueue failed; the work item stays queued for the sweep.", {
      event: ENQUEUE_FAILED_EVENT,
      queueKey,
      kind: work.kind,
      err: error,
    });
    return { enqueued: false };
  }
}
