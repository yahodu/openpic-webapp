import { ObjectId, type ClientSession, type Db, type Document } from "mongodb";
import { z } from "zod";

import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { withTransaction } from "@/server/db/transaction";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { getLogger } from "@/server/logging";
import { getPaymentProvider } from "@/server/payments/get-payment-provider";
import type {
  FailureCategory,
  MandateStatus,
  NormalizedProviderEvent,
  SubscriptionStatus,
  TransactionKind,
  TransactionStatus,
} from "@/server/payments/payment-provider";
import { planSchema } from "@/server/plans/plans";
import { platformRepo } from "@/server/repos";
import { systemClock, type Clock } from "@/server/runtime/clock";
import { effectiveLimit, periodKey } from "@/server/services/entitlements";
import { addDays } from "@/server/runtime/time";
import { getPlatformSettings, type PlatformSettings } from "@/server/settings/platform-settings";

/**
 * The provider-webhook projection (OP-108, contract §10.1 step 6–8, schema
 * §14.3 / §14.4 / §18.4 / §23; ADR-0440, ADR-0441).
 *
 * Two halves, deliberately separated:
 *
 *  - {@link reduceProviderEvent} is the **pure** half: one normalized provider
 *    event + the subscription row it matched + the platform settings + the
 *    instant it is projected at, in; the §10.1.2 decision out — the
 *    `subscriptions` patch, the `billingTransactions` ledger draft and the
 *    domain-event keys to emit. No database, no clock, no environment.
 *  - {@link projectProviderWebhookEvent} is the **applier**: it re-reads one
 *    `providerWebhookEvents` row, re-parses the stored raw payload through the
 *    configured adapter, matches the subscription by its tagged provider ref,
 *    orders the event by the provider's own instant and then writes the ledger
 *    row, the subscription patch and the domain events in **one transaction**
 *    (§23 — money and access move together).
 *
 * Ordering is enforced **inside** that transaction, not by the read that
 * precedes it: the `subscriptions` write is conditional on
 * `lastProviderEventAt` still being absent or older than this event's instant
 * (ADR-0443). The pre-transaction read is only a cheap short-circuit — two
 * concurrent projections for one subscription both pass it, so the conditional
 * write is what actually decides which one may apply, and a zero-match write
 * aborts the transaction so the loser persists no ledger row and emits no
 * domain event.
 *
 * The applier is exported so OP-111's `webhook-projection-sweep` re-projects a
 * row the route left at `processedAt: null`; the route's post-response
 * `after()` work calls the same seam.
 */

/** A §14.3 `subscriptions.status` value, as the wire schema enumerates it. */
const SUBSCRIPTION_STATUS_VALUES = [
  "incomplete",
  "active",
  "past_due",
  "downgraded",
  "cancelled",
  "expired",
] as const;

/** A §14.3 `subscriptions.mandateStatus` value, as the wire schema enumerates it. */
const MANDATE_STATUS_VALUES = ["pending", "active", "paused", "revoked", "expired"] as const;

/** The `subscriptions.dunning` sub-document (§14.3). */
export interface ProjectionDunning {
  readonly attemptCount: number;
  readonly lastAttemptAt: Date | null;
  readonly remindersSent: readonly string[];
  readonly nextReminderAt: Date | null;
}

/**
 * The §14.3 fields `reduceProviderEvent` reads and patches.
 *
 * Declared as the fields the decision actually depends on (not the whole
 * document), so a caller may hand over a richer row — the reducer is a function
 * of these facts alone.
 */
export interface ProjectionSubscription {
  readonly status: SubscriptionStatus;
  readonly mandateStatus: MandateStatus;
  readonly subscribedPlanKey: string;
  readonly activePlanKey: string;
  readonly currentPeriodStart: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly nextChargeAt: Date | null;
  readonly gracePeriodEndsAt: Date | null;
  readonly pendingDueMinor: number;
  readonly dunning: ProjectionDunning;
}

/** What {@link reduceProviderEvent} is given. */
export interface ProjectionInput {
  /** The event the adapter normalized from the raw payload. */
  readonly event: NormalizedProviderEvent;
  /** The `subscriptions` row the event's `externalRefs` matched. */
  readonly subscription: ProjectionSubscription;
  /** The `platformSettings` singleton the tunables come from. */
  readonly settings: PlatformSettings;
  /** The instant the projection runs at (the grace deadline's base). */
  readonly now: Date;
}

/**
 * The `billingTransactions` draft the projection must insert in the same
 * transaction (§14.4).
 *
 * `failureCategory` is the §14.4 `failure.category` value at decision time; the
 * applier nests it under `failure` when it writes the row.
 */
export interface ProjectionTransaction {
  readonly kind: TransactionKind;
  readonly status: TransactionStatus;
  readonly amountMinor: number;
  readonly currency: string;
  readonly failureCategory: FailureCategory | null;
  readonly occurredAt: Date;
  /** Deterministic per event identity, so a re-projection writes the same row. */
  readonly idempotencyKey: string;
}

/** What the reducer decided. */
export interface ProjectionDecision {
  readonly outcome: "applied" | "ignored";
  /** The `$set` document for the matched row, or `null` for a no-op decision. */
  readonly subscriptionPatch: Record<string, unknown> | null;
  /** The ledger draft, or `null` for a lifecycle row. */
  readonly transaction: ProjectionTransaction | null;
  /** The §10.1.2 domain-event `typeKey`s to emit. */
  readonly emittedKeys: readonly string[];
}

/** The patch a §10.1.2 lifecycle row applies to the matched subscription. */
type StatusPatch = Record<string, unknown>;

/** The dunning state a successful charge resets to. */
const RESET_DUNNING: ProjectionDunning = {
  attemptCount: 0,
  lastAttemptAt: null,
  remindersSent: [],
  nextReminderAt: null,
};

/**
 * The billing-cycle length a period is opened/extended by, in days.
 *
 * The §10.1.2 table pins that a successful charge *extends* the stored period
 * and that an activation *opens* one; the exact cycle arithmetic is not pinned
 * (ADR-0440 §Assumptions), so one documented length keeps the period monotonic
 * and testable.
 */
const BILLING_PERIOD_DAYS = 30;

/**
 * The deadline a failed charge duns until: `failedAt + gracePeriodDays`.
 *
 * Exposed and pinned separately because "there are no hard-coded grace days" is
 * an acceptance criterion — the value is operator data (§9.10), never a
 * constant.
 *
 * @param failedAt - The instant the charge failed.
 * @param settings - The validated `platformSettings` singleton.
 * @returns The grace deadline.
 */
export function computeGraceEndsAt(failedAt: Date, settings: PlatformSettings): Date {
  return addDays(failedAt, settings.dunning.gracePeriodDays);
}

/**
 * The period end a new/extended period runs to.
 *
 * Anchored on the stored period end while it is still in the future (a renewal
 * extends the paid window rather than truncating it) and on `now` otherwise, so
 * the period can only move forward.
 */
function periodEnd(subscription: ProjectionSubscription, now: Date): Date {
  const stored = subscription.currentPeriodEnd;
  const base = stored !== null && stored.getTime() > now.getTime() ? stored : now;
  return addDays(base, BILLING_PERIOD_DAYS);
}

/**
 * The ledger's replay key: a deterministic function of the event's identity.
 *
 * The provider's own event id when it reports one, else the provider's instant
 * (which is what identities an id-less payload, exactly as the inbox's payload
 * hash does); the kind/status disambiguate two transactions carried by one
 * event.
 */
function ledgerIdempotencyKey(event: NormalizedProviderEvent): string {
  const identity = event.providerEventId ?? event.occurredAt;
  const kind = event.transaction?.kind ?? "none";
  const status = event.transaction?.status ?? "none";
  return [event.provider, event.kind, identity, kind, status].join(":");
}

/** Build the ledger draft for an event that carries a transaction. */
function transactionDraft(event: NormalizedProviderEvent): ProjectionTransaction | null {
  const transaction = event.transaction;
  if (transaction === null) {
    return null;
  }
  return {
    kind: transaction.kind,
    status: transaction.status,
    amountMinor: transaction.amountMinor,
    currency: transaction.currency,
    failureCategory: transaction.failureCategory,
    occurredAt: new Date(event.occurredAt),
    idempotencyKey: ledgerIdempotencyKey(event),
  };
}

/** The `{status, mandateStatus}` patch a lifecycle row applies, from the event's own axes. */
function statusPatch(
  event: NormalizedProviderEvent,
  subscription: ProjectionSubscription
): StatusPatch {
  return {
    status: event.status ?? subscription.status,
    mandateStatus: event.mandateStatus ?? subscription.mandateStatus,
  };
}

/**
 * Reduce one normalized provider event onto our subscription state (§10.1.2).
 *
 * @param input - The event, the matched row, the settings and the instant.
 * @returns The patch, the ledger draft and the domain-event keys to emit.
 */
export function reduceProviderEvent(input: ProjectionInput): ProjectionDecision {
  const { event, subscription, settings, now } = input;
  const transaction = transactionDraft(event);

  switch (event.kind) {
    case "ignored":
      return { outcome: "ignored", subscriptionPatch: null, transaction: null, emittedKeys: [] };

    case "mandate_pending":
      return {
        outcome: "applied",
        subscriptionPatch: statusPatch(event, subscription),
        transaction,
        emittedKeys: ["billing.mandate.pending"],
      };

    case "mandate_failed":
      // The mandate failed, the subscription stays where it is (§10.1.2): the
      // patch restates the current axes and the money is recorded as failed.
      return {
        outcome: "applied",
        subscriptionPatch: statusPatch(event, subscription),
        transaction,
        emittedKeys: ["billing.mandate.failed"],
      };

    case "subscription_activated": {
      const end = periodEnd(subscription, now);
      return {
        outcome: "applied",
        subscriptionPatch: {
          ...statusPatch(event, subscription),
          status: "active",
          mandateStatus: "active",
          currentPeriodStart: now,
          currentPeriodEnd: end,
          nextChargeAt: end,
        },
        transaction,
        emittedKeys: ["billing.subscription.activated"],
      };
    }

    case "payment_succeeded": {
      const end = periodEnd(subscription, now);
      // Reactivation is a status flip on the same record: access returns to the
      // plan they pay for, never to a hard-coded tier (§14.3). A payment that
      // returns a **non-active** row to `active` restores the limits it was
      // blocked on — §3.3's retry-from-`past_due` case is the same rule as the
      // downgraded one it was already applied to (ADR-0480 §5).
      const reactivating = subscription.status !== "active";
      return {
        outcome: "applied",
        subscriptionPatch: {
          status: "active",
          ...(reactivating ? { activePlanKey: subscription.subscribedPlanKey } : {}),
          pendingDueMinor: 0,
          gracePeriodEndsAt: null,
          currentPeriodEnd: end,
          nextChargeAt: end,
          dunning: RESET_DUNNING,
        },
        transaction,
        emittedKeys: reactivating
          ? [
              "billing.payment.succeeded",
              "billing.subscription.reactivated",
              "usage.limit.restored",
            ]
          : ["billing.payment.succeeded"],
      };
    }

    case "payment_failed": {
      const attempted = event.transaction?.amountMinor ?? subscription.pendingDueMinor;
      return {
        outcome: "applied",
        subscriptionPatch: {
          status: "past_due",
          gracePeriodEndsAt: computeGraceEndsAt(now, settings),
          pendingDueMinor: attempted,
          dunning: {
            attemptCount: subscription.dunning.attemptCount + 1,
            lastAttemptAt: now,
            remindersSent: subscription.dunning.remindersSent,
            nextReminderAt: subscription.dunning.nextReminderAt,
          },
        },
        transaction,
        emittedKeys: ["billing.payment.failed"],
      };
    }

    case "subscription_cancelled":
      return {
        outcome: "applied",
        subscriptionPatch: statusPatch(event, subscription),
        transaction,
        emittedKeys: ["billing.subscription.cancelled"],
      };

    case "refund_processed":
      // A refund moves money only: the subscription is untouched (§10.1.2).
      return {
        outcome: "applied",
        subscriptionPatch: null,
        transaction,
        emittedKeys: ["billing.refund.processed"],
      };
  }
}

/**
 * The stored `subscriptions.tenantId` shapes this build sees.
 *
 * §14.3 types it as an `ObjectId`, and the checkout path writes one — but a
 * stored row may legitimately carry the hex string (the domain-event outbox's
 * `tenantId` is a string, and the fixtures write one), so the applier accepts
 * both and never rewrites the value it matched: the ledger row has to be
 * findable by the same filter the caller used.
 */
const tenantIdSchema = z.union([z.string(), z.instanceof(ObjectId)]);

/** The stored subscription fields the applier reads (a superset of the reducer's). */
const subscriptionRowSchema = z.object({
  _id: z.instanceof(ObjectId),
  tenantId: tenantIdSchema,
  status: z.enum(SUBSCRIPTION_STATUS_VALUES),
  mandateStatus: z.enum(MANDATE_STATUS_VALUES),
  subscribedPlanKey: z.string(),
  activePlanKey: z.string(),
  currentPeriodStart: z.date().nullish(),
  currentPeriodEnd: z.date().nullish(),
  nextChargeAt: z.date().nullish(),
  gracePeriodEndsAt: z.date().nullish(),
  pendingDueMinor: z.number().nullish(),
  dunning: z
    .object({
      attemptCount: z.number(),
      lastAttemptAt: z.date().nullable(),
      remindersSent: z.array(z.string()),
      nextReminderAt: z.date().nullable(),
    })
    .nullish(),
  /**
   * The last applied provider instant — the ordering watermark (§10.1 step 6).
   * The §14.3 schema carries no such field today, so the projection persists it
   * under this leaf; only the observable outcome is contractual (ADR-0440 §6).
   */
  lastProviderEventAt: z.date().nullish(),
});

/** A validated stored subscription row. */
type StoredSubscription = z.infer<typeof subscriptionRowSchema>;

/** The fields the decision reads, projected off a stored row. */
function toProjectionSubscription(row: StoredSubscription): ProjectionSubscription {
  return {
    status: row.status,
    mandateStatus: row.mandateStatus,
    subscribedPlanKey: row.subscribedPlanKey,
    activePlanKey: row.activePlanKey,
    currentPeriodStart: row.currentPeriodStart ?? null,
    currentPeriodEnd: row.currentPeriodEnd ?? null,
    nextChargeAt: row.nextChargeAt ?? null,
    gracePeriodEndsAt: row.gracePeriodEndsAt ?? null,
    pendingDueMinor: row.pendingDueMinor ?? 0,
    dunning: row.dunning ?? RESET_DUNNING,
  };
}

/** MongoDB's duplicate-key server error code. */
const DUPLICATE_KEY = 11000;

/** True when an error is MongoDB's duplicate-key (E11000) refusal. */
export function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === DUPLICATE_KEY
  );
}

/** Coerce an event id (ObjectId or hex string) into the driver's `_id` value. */
function toObjectId(eventId: ObjectId | string): ObjectId {
  return typeof eventId === "string" ? new ObjectId(eventId) : eventId;
}

/** The raw body an inbox row's stored payload re-parses from. */
function rawBodyOf(rawPayload: unknown): string {
  return typeof rawPayload === "string" ? rawPayload : JSON.stringify(rawPayload);
}

/** The §18.4 inbox row fields the projection reads. */
const inboxRowSchema = z.object({
  _id: z.instanceof(ObjectId),
  provider: z.string(),
  rawPayload: z.unknown(),
});

/** A validated stored inbox row. */
type InboxRow = z.infer<typeof inboxRowSchema>;

/** The subscription-scoped provider ref a normalized event identifies. */
function subscriptionRefOf(
  event: NormalizedProviderEvent
): NormalizedProviderEvent["externalRefs"][number] | null {
  return event.externalRefs.find((ref) => ref.kind === "subscription") ?? null;
}

/**
 * The grant an add-on purchase snapshots on its pending ledger row (§14.4,
 * ADR-0480 §4).
 */
const addonSnapshotSchema = z.object({
  addonKey: z.string(),
  entitlementKey: z.string(),
  delta: z.number(),
  quantity: z.number(),
});

/** The §14.4 pending-intent fields the applier reads. */
const intentRowSchema = z.object({
  _id: z.instanceof(ObjectId),
  tenantId: tenantIdSchema,
  subscriptionId: z.instanceof(ObjectId),
  amountMinor: z.number(),
  currency: z.string(),
  addon: addonSnapshotSchema.optional(),
});

/** A validated pending one-time-charge intent. */
type PendingIntent = z.infer<typeof intentRowSchema>;

/** The stored `subscriptions.activePlanKey` the grant-window check resolves (§14.3). */
const planKeySchema = z
  .object({ activePlanKey: z.string().nullish() })
  .transform((row) => row.activePlanKey ?? "free");

/** The stored `usageCounters.value` the grant-window check reads (§14.2). */
const counterRowSchema = z
  .object({ value: z.number().nullish() })
  .transform((row) => row.value ?? 0);

/** The stored `entitlementGrants` fields the grant-window check reads (§14.2). */
const grantRowSchema = z.object({
  delta: z.number(),
  overrideLimit: z.number().nullable(),
  validFrom: z.date(),
  validUntil: z.date().nullable(),
});

/**
 * Find the pending one-time-charge intent a payment confirmation settles
 * (§14.4, ADR-0480 §3).
 *
 * The correlation key is the provider **payment** ref the charge was answered
 * with: the intent's row carries it as the `externalRefs` entry the purchase
 * wrote before the provider call.
 *
 * @param db - The database handle.
 * @param event - The normalized event.
 * @returns The pending intent, or `null` when this event settles no intent.
 */
async function findPendingIntent(
  db: Db,
  event: NormalizedProviderEvent
): Promise<PendingIntent | null> {
  if (event.kind !== "payment_succeeded") {
    return null;
  }
  const payment = event.externalRefs.find((ref) => ref.kind === "payment");
  if (payment === undefined) {
    return null;
  }
  const row = await platformRepo(db)
    .collection(COLLECTIONS.billingTransactions)
    .findOne({
      status: "pending",
      externalRefs: {
        $elemMatch: {
          provider: payment.provider,
          env: payment.env,
          kind: "payment",
          id: payment.id,
        },
      },
    });
  return row === null ? null : intentRowSchema.parse(row);
}

/**
 * Whether writing `delta` onto `entitlementKey` lifts a workspace back inside
 * its effective limit (§3.5, §10.1.2).
 *
 * `usage.limit.restored` is emitted only when the grant **clears a block**: the
 * workspace was over the plan limit before the grant and is inside the topped-up
 * one after it. An uncapped or ungated key has no block to clear.
 *
 * @param db - The database handle.
 * @param session - The projection's transaction.
 * @param tenantId - The workspace the grant belongs to.
 * @param subscriptionId - The row whose plan gates the key.
 * @param entitlementKey - The key being topped up.
 * @param delta - The delta the grant adds.
 * @param now - The instant the grant becomes active.
 * @returns `true` when the grant lifts a block.
 */
async function grantRestoresLimit(
  db: Db,
  session: ClientSession,
  tenantId: string,
  subscriptionId: ObjectId,
  entitlementKey: string,
  delta: number,
  now: Date
): Promise<boolean> {
  const subscriptionRow = await platformRepo(db)
    .collection(COLLECTIONS.subscriptions)
    .findOne({ _id: subscriptionId }, { session });
  const planKey = subscriptionRow == null ? "free" : planKeySchema.parse(subscriptionRow);
  const planRow = await platformRepo(db)
    .collection(COLLECTIONS.plans)
    .findOne({ key: planKey }, { session });
  const spec =
    planRow === null ? null : (planSchema.parse(planRow).entitlements[entitlementKey] ?? null);
  if (spec === null) {
    return false;
  }
  if (spec.limit === null) {
    return false;
  }

  const grants = (
    await platformRepo(db)
      .collection(COLLECTIONS.entitlementGrants)
      .find({ tenantId, entitlementKey }, { session })
      .toArray()
  ).map((row) => grantRowSchema.parse(row));
  const counter = await platformRepo(db)
    .collection(COLLECTIONS.usageCounters)
    .findOne(
      { tenantId, entitlementKey, periodKey: periodKey(spec.resetPeriod, now) },
      { session }
    );
  const used = counter == null ? 0 : counterRowSchema.parse(counter);

  const before = effectiveLimit(spec, grants, now);
  const after = effectiveLimit(
    spec,
    [...grants, { delta, overrideLimit: null, validFrom: now, validUntil: null }],
    now
  );
  return before !== null && used > before && (after === null || used <= after);
}

/**
 * Settle a pending intent inside the projection's transaction: mark the charge
 * succeeded, and — for an add-on purchase — write the **additive**
 * `entitlementGrants` row it paid for and emit its domain events (§3.6).
 *
 * The grant is a new row, never a mutation of the plan (§14.2).
 *
 * @param db - The database handle.
 * @param clock - The clock the emits are stamped with.
 * @param now - The instant the settlement runs at.
 * @param row - The inbox row the confirmation came from.
 * @param session - The projection's transaction.
 * @param intent - The intent the event correlated to.
 */
async function settleIntent(
  db: Db,
  clock: Clock,
  now: Date,
  row: InboxRow,
  session: ClientSession,
  intent: PendingIntent
): Promise<void> {
  const tenantId = String(intent.tenantId);
  const subscriptionId = intent.subscriptionId.toHexString();
  await platformRepo(db)
    .collection(COLLECTIONS.billingTransactions)
    .updateOne(
      { _id: intent._id, status: "pending" },
      { $set: { status: "succeeded", settledAt: now, rawPayloadRef: row._id, updatedAt: now } },
      { session }
    );

  const addon = intent.addon;
  if (addon === undefined) {
    return;
  }

  const restores = await grantRestoresLimit(
    db,
    session,
    tenantId,
    intent.subscriptionId,
    addon.entitlementKey,
    addon.delta,
    now
  );
  await platformRepo(db)
    .collection(COLLECTIONS.entitlementGrants)
    .insertOne(
      {
        tenantId,
        entitlementKey: addon.entitlementKey,
        delta: addon.delta,
        overrideLimit: null,
        source: { kind: "purchase", billingTransactionId: intent._id },
        validFrom: now,
        validUntil: null,
        createdAt: now,
      },
      { session }
    );

  const identity = intent._id.toHexString();
  const eventKeys = restores
    ? ["billing.addon.purchased", "usage.limit.restored"]
    : ["billing.addon.purchased"];
  for (const eventKey of eventKeys) {
    await emitDomainEvent(
      {
        eventKey,
        tenantId,
        actorRef: { kind: "system", id: "webhook" },
        subjectRef: { kind: "subscription", id: subscriptionId },
        payload: { subscriptionId, addonKey: addon.addonKey },
        dedupeKey: `${eventKey}:${identity}`,
      },
      { db, clock, session }
    );
  }
}

/** Seams for {@link projectProviderWebhookEvent}. */
export interface ProjectProviderWebhookEventOptions {
  /** The database handle; defaults to the shared client. */
  readonly db?: Db;
  /** The clock stamped into `processedAt`/`settledAt`; defaults to the system clock. */
  readonly clock?: Clock;
}

/** Why a projection was skipped, for the log line (never the payload). */
type IgnoreReason =
  | "unregistered_provider"
  | "no_subscription_ref"
  | "no_subscription_match"
  | "out_of_order"
  | "nothing_to_apply";

/**
 * Re-project one inbox row (§10.1 step 6).
 *
 * Reads the row, re-parses its stored raw payload through the configured
 * adapter and, when the event still has work to do, applies the decision in one
 * transaction: the `billingTransactions` insert, the `subscriptions` update and
 * the domain events. A failure leaves `processedAt: null` with
 * `processResult: "error"` and a `processError`, so the sweep retries it; the
 * provider is never told.
 *
 * @param eventId - The `providerWebhookEvents` row id (ObjectId or hex string).
 * @param options - The database and clock seams.
 */
export async function projectProviderWebhookEvent(
  eventId: ObjectId | string,
  options: ProjectProviderWebhookEventOptions = {}
): Promise<void> {
  const db = options.db ?? getDb();
  const clock = options.clock ?? systemClock;
  const now = clock.now();
  const inbox = platformRepo(db).collection(COLLECTIONS.providerWebhookEvents);
  const raw = await inbox.findOne({ _id: toObjectId(eventId) });
  if (raw === null || raw === undefined) {
    return;
  }
  const row = inboxRowSchema.parse(raw);

  try {
    const outcome = await applyProjection(db, clock, now, row);
    await inbox.updateOne(
      { _id: row._id },
      { $set: { processedAt: now, processResult: outcome, processError: null } }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    getLogger().error("provider webhook projection failed", {
      event: "billing.webhook.projection_failed",
      provider: row.provider,
      processError: message,
    });
    await inbox.updateOne(
      { _id: row._id },
      { $set: { processedAt: null, processResult: "error", processError: message } }
    );
  }
}

/**
 * Apply one inbox row's event, answering `applied` or `ignored`.
 *
 * @throws Whatever the transaction threw, so the caller can record the failure.
 */
async function applyProjection(
  db: Db,
  clock: Clock,
  now: Date,
  row: InboxRow
): Promise<"applied" | "ignored"> {
  const config = getConfig();
  if (config.payments.provider !== row.provider) {
    return ignore(row, "unregistered_provider");
  }

  const event = getPaymentProvider().parseWebhook(rawBodyOf(row.rawPayload));
  const ref = subscriptionRefOf(event);
  // A one-time charge (a retry or an add-on purchase) is confirmed by a payment
  // event that settles the pending intent its purchase wrote (§14.4, ADR-0480
  // §3): the payment ref is the correlation key, independent of the mandate ref.
  const intent = await findPendingIntent(db, event);
  if (ref === null && intent === null) {
    return ignore(row, "no_subscription_ref");
  }

  const subscriptions = platformRepo(db).collection(COLLECTIONS.subscriptions);
  const stored =
    ref === null
      ? null
      : await subscriptions.findOne({
          externalRefs: {
            // §11.1: the environment is part of the identity, so a sandbox event
            // can never address a production subscription's ref.
            $elemMatch: { provider: ref.provider, kind: "subscription", id: ref.id, env: ref.env },
          },
        });
  if (stored === null) {
    if (intent === null) {
      return ignore(row, "no_subscription_match");
    }
    // Nothing to patch on a subscription: the confirmation settles the intent
    // (and grants what it bought) on its own.
    await withTransaction(async (session: ClientSession) => {
      await settleIntent(db, clock, now, row, session, intent);
    });
    return "applied";
  }

  const subscription = subscriptionRowSchema.parse(stored);
  const eventAt = new Date(event.occurredAt);
  const watermark = subscription.lastProviderEventAt ?? null;
  if (watermark !== null && eventAt.getTime() <= watermark.getTime()) {
    // Arrival order is irrelevant; the provider's own instant is the order
    // (§10.1 step 6). An older event never rolls a newer success back.
    return ignore(row, "out_of_order");
  }

  const settings = await getPlatformSettings({ db, clock });
  const decision = reduceProviderEvent({
    event,
    subscription: toProjectionSubscription(subscription),
    settings,
    now,
  });
  if (decision.outcome === "ignored" && intent === null) {
    return ignore(row, "nothing_to_apply");
  }

  const outcome = await applyDecision(
    db,
    clock,
    now,
    row,
    subscription,
    event,
    eventAt,
    decision,
    intent
  );
  if (outcome === "ignored") {
    // The conditional write found the watermark already at/behind a newer
    // event's instant: a concurrent projection committed first (§10.1 step 6).
    return ignore(row, "out_of_order");
  }
  return "applied";
}

/** Log why a row was skipped and report it. */
function ignore(row: InboxRow, reason: IgnoreReason): "ignored" {
  getLogger().info("provider webhook projection ignored", {
    event: "billing.webhook.projection_ignored",
    provider: row.provider,
    reason,
  });
  return "ignored";
}

/** The §14.4 ledger document for one decision. */
function ledgerDocument(
  row: InboxRow,
  subscription: StoredSubscription,
  event: NormalizedProviderEvent,
  eventAt: Date,
  now: Date,
  transaction: ProjectionTransaction
): Document {
  return {
    tenantId: subscription.tenantId,
    subscriptionId: subscription._id,
    kind: transaction.kind,
    status: transaction.status,
    amountMinor: transaction.amountMinor,
    currency: transaction.currency,
    failure:
      transaction.failureCategory === null ? null : { category: transaction.failureCategory },
    idempotencyKey: transaction.idempotencyKey,
    externalRefs: [...event.externalRefs],
    occurredAt: eventAt,
    settledAt: now,
    // §14.4: the ledger *references* the raw payload instead of copying it.
    rawPayloadRef: row._id,
    createdAt: now,
  };
}

/**
 * Raised inside the projection transaction when the conditional subscription
 * write matched **no** document.
 *
 * That means the stored watermark had already advanced to (or past) this
 * event's instant — a newer projection for the same subscription committed
 * first — so this event may not apply. Throwing aborts the transaction, which
 * is what keeps the loser's ledger row and domain events from persisting; the
 * caller maps it to an `out_of_order` `ignored` result.
 */
class OutOfOrderProjectionError extends Error {
  constructor() {
    super("subscription watermark already advanced past this event");
    this.name = "OutOfOrderProjectionError";
  }
}

/**
 * Write the decision: ledger insert + subscription patch + domain events, all in
 * one transaction (§23).
 *
 * The subscription write is the ordering guard, not merely an update: it is
 * conditional on the stored `lastProviderEventAt` being absent, `null`, or
 * strictly older than `eventAt` (§10.1 step 6, ADR-0443). A zero-match write
 * throws {@link OutOfOrderProjectionError} — before the ledger insert and the
 * emits — so the transaction aborts without persisting anything from an event
 * that must not apply, and `withTransaction`'s retry re-evaluates the same
 * condition against the latest committed row.
 *
 * @returns `"applied"` once the transaction committed, or `"ignored"` when the
 *   watermark had already moved past this event.
 */
async function applyDecision(
  db: Db,
  clock: Clock,
  now: Date,
  row: InboxRow,
  subscription: StoredSubscription,
  event: NormalizedProviderEvent,
  eventAt: Date,
  decision: ProjectionDecision,
  intent: PendingIntent | null
): Promise<"applied" | "ignored"> {
  const subscriptions = platformRepo(db).collection(COLLECTIONS.subscriptions);
  const ledger = platformRepo(db).collection(COLLECTIONS.billingTransactions);
  const tenantId = String(subscription.tenantId);
  const subscriptionId = subscription._id.toHexString();

  try {
    await withTransaction(async (session: ClientSession) => {
      if (decision.subscriptionPatch !== null) {
        // The watermark check is fused into the write: only a row whose
        // watermark is still behind this event may take the patch. A
        // concurrent newer projection that committed first makes this match
        // zero documents, whatever order the two transactions reach the
        // engine in.
        const guarded = await subscriptions.updateOne(
          {
            _id: subscription._id,
            $or: [
              { lastProviderEventAt: { $exists: false } },
              { lastProviderEventAt: null },
              { lastProviderEventAt: { $lt: eventAt } },
            ],
          },
          {
            $set: {
              ...decision.subscriptionPatch,
              lastProviderEventAt: eventAt,
              updatedAt: now,
            },
          },
          { session }
        );
        if (guarded.matchedCount === 0) {
          throw new OutOfOrderProjectionError();
        }
      }
      if (intent !== null) {
        // The intent **is** this charge's ledger row (written before the
        // provider call), so the confirmation settles it rather than writing a
        // second row for the same money movement — and grants what it bought.
        await settleIntent(db, clock, now, row, session, intent);
      } else if (decision.transaction !== null) {
        await ledger.insertOne(
          ledgerDocument(row, subscription, event, eventAt, now, decision.transaction),
          { session }
        );
      }
      for (const eventKey of decision.emittedKeys) {
        await emitDomainEvent(
          {
            eventKey,
            tenantId,
            actorRef: { kind: "system", id: event.provider },
            subjectRef: { kind: "subscription", id: subscriptionId },
            payload: { subscriptionId },
            dedupeKey: `${eventKey}:${decision.transaction?.idempotencyKey ?? String(row._id)}`,
          },
          { db, clock, session }
        );
      }
    });
  } catch (error: unknown) {
    if (error instanceof OutOfOrderProjectionError) {
      return "ignored";
    }
    throw error;
  }

  return "applied";
}
