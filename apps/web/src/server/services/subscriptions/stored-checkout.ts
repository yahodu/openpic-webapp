import type { Db, ObjectId } from "mongodb";
import { z } from "zod";

import { COLLECTIONS } from "@/server/db/collections";
import { platformRepo } from "@/server/repos";

/**
 * The stored hosted link of one subscription (OP-140 precondition, contract
 * §7.3 `subscription` × `complete_mandate`; ADR-0403).
 *
 * Both mint paths write `subscriptions.checkout = { url, expiresAt }`; this read
 * answers that block back for the row a caller names by its own `_id`, so the
 * OP-140 delegate can return the stored `checkout.url` instead of guessing a
 * link. The read is **id-keyed and unscoped by design**: it is an answer for a
 * row the caller already holds, never an authorisation-free lookup — a caller
 * must establish that it may act on the row before asking.
 */

/** The stored block a minted subscription carries. */
export interface StoredCheckout {
  readonly url: string;
  readonly expiresAt: Date;
}

/** Who to read the block for. */
export interface ReadStoredCheckoutInput {
  readonly db: Db;
  readonly subscriptionId: ObjectId;
}

/** The stored `checkout` block (schema §14.3), read off the row that carries it. */
const storedCheckoutRowSchema = z.object({
  checkout: z.object({ url: z.string(), expiresAt: z.date() }),
});

/**
 * Read one subscription's stored hosted link.
 *
 * @param input - The database handle and the row's own `ObjectId`.
 * @returns The stored `{ url, expiresAt }`, or `null` when that row stores no
 *   block, no row carries the `_id`, or the stored block is malformed.
 */
export async function readStoredCheckout(
  input: ReadStoredCheckoutInput
): Promise<StoredCheckout | null> {
  const parsed = storedCheckoutRowSchema.safeParse(
    await platformRepo(input.db)
      .collection(COLLECTIONS.subscriptions)
      .findOne({ _id: input.subscriptionId })
  );
  return parsed.success ? parsed.data.checkout : null;
}
