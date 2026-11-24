import { ObjectId } from "mongodb";
import type { ClientSession } from "mongodb";
import { describe, expect, it } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { findDomainEventByDedupeKey } from "@/server/domain/domain-events";

import { makeFakeMongo } from "../../test/helpers/fake-mongo";

/**
 * Unit contract — `findDomainEventByDedupeKey`, the read seam beside the
 * outbox writer (review F4).
 *
 * A producer inside a transaction cannot rely on the unique partial index to
 * dedupe: a duplicate-key failure aborts the whole transaction, and
 * `emitDomainEvent`'s own `{ deduped: true }` catch is only settled outside a
 * transaction. So the producer asks this seam first. The seam must stay a
 * read — it takes the `dedupeKey`, reads the caller's `db`/`session` (so the
 * read sees the transaction's own writes) and returns the row id or `null`.
 */

/** The stored outbox collection (schema §18.3). */
const DOMAIN_EVENTS = COLLECTIONS.domainEvents;

/** A dedupe key shaped like the downgrade route's. */
const DEDUPE_KEY = "billing.plan.downgrade_scheduled:sub:pro:2026-04-01T00:00:00.000Z";

describe("findDomainEventByDedupeKey", () => {
  it("returns the stored row id for a dedupeKey inside the caller's session", async () => {
    const fake = makeFakeMongo();
    const _id = new ObjectId();
    fake.seed(DOMAIN_EVENTS, [{ _id, dedupeKey: DEDUPE_KEY }]);
    const session = {} as unknown as ClientSession;

    const found = await findDomainEventByDedupeKey(DEDUPE_KEY, { db: fake.db, session });

    expect(found).toBe(_id.toHexString());
    const call = fake.lastCall("findOne");
    expect(call?.collection).toBe(DOMAIN_EVENTS);
    expect(call?.args[0]).toEqual({ dedupeKey: DEDUPE_KEY });
    expect(call?.args[1]).toEqual({ session });
  });

  it("returns null when the outbox holds no row for the dedupeKey", async () => {
    const fake = makeFakeMongo();

    const found = await findDomainEventByDedupeKey(DEDUPE_KEY, { db: fake.db });

    expect(found).toBeNull();
    expect(fake.lastCall("findOne")?.args[1]).toEqual({});
  });
});
