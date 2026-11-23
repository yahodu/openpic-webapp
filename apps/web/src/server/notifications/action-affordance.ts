import { type ClientSession, type Db } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { platformRepo } from "@/server/repos";

/**
 * Close every denormalised affordance that points at one transitioned target
 * (OP-140, contract §2.3 rule 3 and §7.3).
 *
 * This is the "closed in every channel" write: after any successful
 * transition, every feed row of the caller that offers an action on that
 * `(kind, id)` pair serves it as `unavailable`, so a device that polls next
 * sees the same decision applied. The write is denormalised convenience only —
 * it is never authoritative, and the target's own document stays the source of
 * truth, so a stale `available` never short-circuits a decision either.
 *
 * The helper is kind-generic because §7.3's promise is general; the channel is
 * written only when the caller knows one.
 *
 * @param db - The database handle.
 * @param target - The transitioned target's kind and id.
 * @param now - The instant of the transition.
 * @param options.via - The decision channel, when the transition knows one.
 * @param options.session - The caller's transaction; the write joins it.
 */
export async function closeActionAffordance(
  db: Db,
  target: { readonly kind: string; readonly id: string },
  now: Date,
  options?: { readonly via?: string; readonly session?: ClientSession }
): Promise<void> {
  const via = options?.via;
  const session = options?.session;

  await platformRepo(db)
    .collection(COLLECTIONS.notifications)
    .updateMany(
      { "actionTarget.kind": target.kind, "actionTarget.id": target.id },
      {
        $set: {
          "actions.$[].state": "unavailable",
          "actionTarget.state": "resolved",
          actionResolvedAt: now,
          ...(via === undefined ? {} : { actionResolvedVia: via }),
          updatedAt: now,
        },
      },
      session === undefined ? {} : { session }
    );
}
