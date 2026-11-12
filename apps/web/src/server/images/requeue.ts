import type { Db, ObjectId } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { enqueueWork } from "@/server/queue/enqueue-work";
import { getWorkQueue } from "@/server/queue/get-work-queue";
import { tenantRepo } from "@/server/repos";

import { resetProcessingForReprocess, type ProcessingState } from "./reprocess";

/** The `event_images` fields a requeue reads. */
export interface RequeueImageRow {
  readonly _id: ObjectId;
  readonly processing?: ProcessingState;
}

/** Everything one requeue pass needs. */
export interface RequeueImagesInput {
  readonly db: Db;
  /** The event's tenant (never the caller's own workspace). */
  readonly tenantKey: string;
  readonly eventId: ObjectId;
  readonly rows: readonly RequeueImageRow[];
  /** The request instant; this module never reads the clock itself. */
  readonly now: Date;
  /** The face space the pipeline runs in (`platformSettings.face.activeSpaceKey`). */
  readonly spaceKey: string;
  readonly requestId: string;
}

/**
 * Reset each row to `queued` and re-enqueue it (OP-127, contract §4.4).
 *
 * The durable write precedes the enqueue so a broker failure leaves a `queued`
 * row with no `queueRef` — the sweep's job — never a lost image (§18.1). A
 * failed enqueue is a `warn` inside {@link enqueueWork}, not a failed request.
 *
 * @param input - The rows already admitted and loaded by the caller.
 */
export async function requeueImages(input: RequeueImagesInput): Promise<void> {
  const collection = tenantRepo(input.tenantKey, input.db).collection(COLLECTIONS.eventImages);

  for (const row of input.rows) {
    const processing = resetProcessingForReprocess(row.processing, input.now);
    await collection.updateOne({ _id: row._id }, { $set: { processing } });
    await enqueueWork({
      db: input.db,
      queue: getWorkQueue(),
      collection: COLLECTIONS.eventImages,
      work: {
        kind: "event_image",
        id: row._id.toHexString(),
        tenantId: input.tenantKey,
        eventId: input.eventId.toHexString(),
        spaceKey: input.spaceKey,
        traceId: input.requestId,
        priority: processing.priority === "high" ? "high" : "normal",
      },
    });
  }
}
