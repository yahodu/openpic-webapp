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
import { platformRepo } from "@/server/repos";
import { systemClock, type Clock } from "@/server/runtime/clock";
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
      // plan they pay for, never to a hard-coded tier (§14.3).
      const reactivating = subscription.status === "downgraded";
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
  if (ref === null) {
    return ignore(row, "no_subscription_ref");
  }

  const subscriptions = platformRepo(db).collection(COLLECTIONS.subscriptions);
  const stored = await subscriptions.findOne({
    externalRefs: {
      // §11.1: the environment is part of the identity, so a sandbox event can
      // never address a production subscription's ref.
      $elemMatch: { provider: ref.provider, kind: "subscription", id: ref.id, env: ref.env },
    },
  });
  if (stored === null) {
    return ignore(row, "no_subscription_match");
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
  if (decision.outcome === "ignored") {
    return ignore(row, "nothing_to_apply");
  }

  await applyDecision(db, clock, now, row, subscription, event, eventAt, decision);
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
 * Write the decision: ledger insert + subscription patch + domain events, all in
 * one transaction (§23).
 */
async function applyDecision(
  db: Db,
  clock: Clock,
  now: Date,
  row: InboxRow,
  subscription: StoredSubscription,
  event: NormalizedProviderEvent,
  eventAt: Date,
  decision: ProjectionDecision
): Promise<void> {
  const subscriptions = platformRepo(db).collection(COLLECTIONS.subscriptions);
  const ledger = platformRepo(db).collection(COLLECTIONS.billingTransactions);
  const tenantId = String(subscription.tenantId);
  const subscriptionId = subscription._id.toHexString();

  await withTransaction(async (session: ClientSession) => {
    if (decision.transaction !== null) {
      await ledger.insertOne(
        ledgerDocument(row, subscription, event, eventAt, now, decision.transaction),
        { session }
      );
    }
    if (decision.subscriptionPatch !== null) {
      await subscriptions.updateOne(
        { _id: subscription._id },
        {
          $set: {
            ...decision.subscriptionPatch,
            lastProviderEventAt: eventAt,
            updatedAt: now,
          },
        },
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
}
