import type { Db, ObjectId } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { resolveEventActorRole } from "@/server/events/access";
import { appError } from "@/server/http/errors";
import type { Logger } from "@/server/logging";
import { tenantRepo } from "@/server/repos";

import { requeueImages, type RequeueImageRow } from "./requeue";

/**
 * Everything one bulk retry of an event's failed images needs.
 *
 * `tenantId` is the **event's** workspace as an `ObjectId`, not the route
 * context's hex string: this is the seam a §7.3 delegate calls, and the hex
 * conversion is the only thing the service makes of it. `now` and `spaceKey`
 * are inputs so the service never reads a clock and a caller can pin the
 * stamped instant, exactly as {@link requeueImages} already does.
 */
export interface RetryFailedEventImagesInput {
  readonly db: Db;
  /** The event's workspace — the tenant every read is scoped to. */
  readonly tenantId: ObjectId;
  readonly eventId: ObjectId;
  /** The caller's Better Auth id (hex). */
  readonly actorUserId: string;
  /** The face space the pipeline runs in (`platformSettings.face.activeSpaceKey`). */
  readonly spaceKey: string;
  readonly requestId: string;
  readonly now: Date;
  /** Carries the request's logger so a refused enqueue still warns (§18.1). */
  readonly logger?: Logger;
}

/**
 * Retry an event's failed images as a **service** (OP-140 precondition, contract
 * §4.4, §7.3 row `upload_batch × retry_failed`; ADR-0777 D1/D2).
 *
 * The admission rule is re-checked here, not only in the route's middleware: a
 * §7.3 delegate has no `Request` to run a stage against. It is the same rule —
 * the tenant-scoped `events` read (existence **and** workspace check, so another
 * workspace's event is the uniform `404`, §0.4) and then
 * {@link resolveEventActorRole}'s ladder — so a refusal is the middleware's
 * `404 not_found`, written as one here rather than re-implemented.
 *
 * The reset and the enqueue are {@link requeueImages}' so the `updateOne` /
 * `enqueueWork` pair has one owner and one reset contract (§18.2).
 *
 * @param input - The event, its workspace, the admitted caller and the request instant.
 * @returns `{ requeuedCount }`, the number of rows reset and re-enqueued.
 * @throws AppError `not_found` when the event is not in this workspace or the
 *   caller has no relationship to it; nothing is written in that case.
 */
export async function retryFailedEventImages(
  input: RetryFailedEventImagesInput
): Promise<{ readonly requeuedCount: number }> {
  const tenantKey = input.tenantId.toHexString();
  const scoped = tenantRepo(tenantKey, input.db);

  const event = await scoped.collection(COLLECTIONS.events).findOne({ _id: input.eventId });
  if (event === null) {
    input.logger?.warn("tenant access denied", {
      event: "tenancy.access_denied",
      reason: "event_not_found",
    });
    throw appError("not_found");
  }

  if (
    (await resolveEventActorRole(input.db, input.eventId, tenantKey, input.actorUserId)) === null
  ) {
    input.logger?.warn("tenant access denied", {
      event: "tenancy.access_denied",
      reason: "not_an_event_actor",
    });
    throw appError("not_found");
  }

  const rows = (await scoped
    .collection(COLLECTIONS.eventImages)
    .find({ eventId: input.eventId, deletedAt: null, "processing.status": "failed" })
    .toArray()) as unknown as RequeueImageRow[];

  await requeueImages({
    db: input.db,
    tenantKey,
    eventId: input.eventId,
    rows,
    now: input.now,
    spaceKey: input.spaceKey,
    requestId: input.requestId,
    ...(input.logger !== undefined ? { logger: input.logger } : {}),
  });

  return { requeuedCount: rows.length };
}
