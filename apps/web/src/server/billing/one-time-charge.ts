import { ObjectId, type Db, type Document } from "mongodb";
import { z } from "zod";

import { COLLECTIONS } from "@/server/db/collections";
import type {
  FailureCategory,
  ProviderRef,
  ProviderRefKind,
} from "@/server/payments/payment-provider";
import { platformRepo } from "@/server/repos";

/**
 * The one-time-charge ledger intent (OP-110, contract §3.3/§3.6, schema §14.4;
 * ADR-0480 §3–§4).
 *
 * A retry and an add-on purchase are both **one-time charges confirmed by a
 * webhook**, so both need the same correlation key: a §14.4 `billingTransactions`
 * row written at `status: "pending"` **before** the provider is called, carrying
 * the provider `externalRefs` the confirmation event will match on. That is the
 * OP-107 insert-then-call shape applied to the ledger, and it is what lets the
 * projection find the intent when the confirmation arrives.
 *
 * An add-on purchase additionally **snapshots its grant** on that row, so a
 * catalogue edit between purchase and confirmation cannot change what an
 * already-paid purchase grants (ADR-0480 §4).
 */

/** A provider reference as stored on a document (§11.1). */
export const providerRefSchema = z.object({
  provider: z.enum(["cashfree", "memory"]),
  env: z.enum(["sandbox", "production"]),
  kind: z.enum(["subscription", "payment", "refund"]),
  id: z.string().min(1),
});

/** The stored `externalRefs` array, validated. */
export const providerRefsSchema = z.array(providerRefSchema).default([]);

/**
 * Find the provider reference of one kind on a stored document.
 *
 * @param refs - The validated `externalRefs` array.
 * @param kind - The reference kind to look for.
 * @returns The first matching ref, or `null` when the document carries none.
 */
export function providerRefOf(
  refs: readonly ProviderRef[],
  kind: ProviderRefKind
): ProviderRef | null {
  return refs.find((ref) => ref.kind === kind) ?? null;
}

/** The grant an add-on purchase snapshots on its pending ledger row. */
export interface AddonGrantSnapshot {
  /** The catalogue identity the purchase names. */
  readonly addonKey: string;
  /** The entitlement the purchase tops up. */
  readonly entitlementKey: string;
  /** The total delta granted: `quantity × addon.grantDelta`. */
  readonly delta: number;
  /** How many catalogue units were bought. */
  readonly quantity: number;
}

/** What {@link insertPendingCharge} writes. */
export interface PendingChargeInput {
  /** The workspace the charge belongs to (the string hex `tenantId`). */
  readonly tenantId: string;
  /** The subscription the charge is made against. */
  readonly subscriptionId: ObjectId;
  /** The amount to charge, in minor units. */
  readonly amountMinor: number;
  /** The ISO currency. */
  readonly currency: string;
  /** Our key for this intent, stable across retries of the same request. */
  readonly idempotencyKey: string;
  /** The instant the intent is written at. */
  readonly now: Date;
  /** The grant an add-on purchase snapshots, when this charge buys one. */
  readonly addon?: AddonGrantSnapshot;
}

/**
 * Write the `pending` ledger intent for a one-time charge (§14.4).
 *
 * The provider refs are **not** known yet — they are the vendor's answer — so
 * the row is written first and {@link recordChargeRefs} stamps them once the
 * charge has been accepted.
 *
 * @param db - The database handle.
 * @param input - The intent's identity, amount and snapshot.
 * @returns The new row's `_id`.
 */
export async function insertPendingCharge(db: Db, input: PendingChargeInput): Promise<ObjectId> {
  const _id = new ObjectId();
  const document: Document = {
    _id,
    tenantId: input.tenantId,
    subscriptionId: input.subscriptionId,
    kind: "charge",
    status: "pending",
    amountMinor: input.amountMinor,
    currency: input.currency,
    failure: null,
    idempotencyKey: input.idempotencyKey,
    externalRefs: [],
    occurredAt: input.now,
    settledAt: null,
    periodCovered: null,
    invoiceNumber: null,
    rawPayloadRef: null,
    createdAt: input.now,
    ...(input.addon === undefined ? {} : { addon: input.addon }),
  };
  await platformRepo(db).collection(COLLECTIONS.billingTransactions).insertOne(document);
  return _id;
}

/**
 * Park an intent the provider refused at `failed`, so it never dangles.
 *
 * @param db - The database handle.
 * @param id - The pending row's `_id`.
 * @param category - The §14.4 failure category the refusal is recorded under.
 * @param now - The instant the failure is recorded at.
 */
export async function failPendingCharge(
  db: Db,
  id: ObjectId,
  category: FailureCategory,
  now: Date
): Promise<void> {
  await platformRepo(db)
    .collection(COLLECTIONS.billingTransactions)
    .updateOne(
      { _id: id, status: "pending" },
      {
        $set: {
          status: "failed",
          failure: { category },
          settledAt: now,
          updatedAt: now,
        },
      }
    );
}

/**
 * Stamp the provider refs the accepted charge returned onto the intent.
 *
 * @param db - The database handle.
 * @param id - The pending row's `_id`.
 * @param refs - The refs the provider answered with.
 * @param now - The instant the refs are recorded at.
 */
export async function recordChargeRefs(
  db: Db,
  id: ObjectId,
  refs: readonly ProviderRef[],
  now: Date
): Promise<void> {
  await platformRepo(db)
    .collection(COLLECTIONS.billingTransactions)
    .updateOne({ _id: id }, { $set: { externalRefs: [...refs], updatedAt: now } });
}
