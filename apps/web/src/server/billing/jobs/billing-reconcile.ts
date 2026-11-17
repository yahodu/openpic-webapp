import { ObjectId } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { emitDomainEvent } from "@/server/domain/domain-events";
import type { CronRunOutcome } from "@/server/jobs/cron-job";
import { getLogger } from "@/server/logging";
import { getPaymentProvider } from "@/server/payments/get-payment-provider";
import type { FetchStatusResult, ProviderRef } from "@/server/payments/payment-provider";
import { platformRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { addMilliseconds } from "@/server/runtime/time";

import type { BillingJobRunOptions } from "./run-options";

/**
 * The billing-reconciliation cron (OP-111, contract §10.2 `billing-reconcile`;
 * schema §14.3; ADR-0500).
 *
 * The webhook-miss safety net: a subscription the provider has moved but whose
 * webhook never arrived would otherwise sit `incomplete` (never activated) or
 * `past_due` (never reactivated) forever. This job is the **only** billing cron
 * that reaches `getPaymentProvider().fetchStatus`, and it reaches it only for a
 * row that has been stuck for more than the documented hour — an in-flight
 * activation must not be raced.
 */

/** How long a row may sit in a non-terminal billing state before it is reconciled. */
const STUCK_AFTER_MS = 60 * 60 * 1000;

/** The statuses reconciliation owns: a live period, or one waiting to activate. */
const RECONCILABLE_STATUSES: readonly string[] = ["incomplete", "past_due"];

/** The stored fields the reconcile runner reads off a candidate row. */
interface ReconcileCandidate {
  readonly _id: unknown;
  readonly tenantId: string;
  readonly subjectId: string | null;
  readonly status: string;
  readonly mandateStatus: string;
  readonly ref: ProviderRef | null;
}

/** The subscription-scoped provider ref stored on a row's `externalRefs` (§11.1). */
function subscriptionRefOf(value: unknown): ProviderRef | null {
  if (!Array.isArray(value)) {
    return null;
  }
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const { provider, env, kind, id } = entry as Record<string, unknown>;
    if (kind === "subscription" && typeof provider === "string" && typeof id === "string") {
      return {
        provider: provider as ProviderRef["provider"],
        env: env === "production" ? "production" : "sandbox",
        kind: "subscription",
        id,
      };
    }
  }
  return null;
}

/** Narrow an unknown stored value to a reconcile candidate, or `null`. */
function asReconcileCandidate(value: unknown): ReconcileCandidate | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { _id, status, mandateStatus, externalRefs, tenantId } = value as {
    _id?: unknown;
    status?: unknown;
    mandateStatus?: unknown;
    externalRefs?: unknown;
    tenantId?: unknown;
  };
  if (_id === undefined || typeof status !== "string") {
    return null;
  }
  return {
    _id,
    tenantId: typeof tenantId === "string" ? tenantId : "",
    subjectId: _id instanceof ObjectId ? _id.toHexString() : null,
    status,
    mandateStatus: typeof mandateStatus === "string" ? mandateStatus : "",
    ref: subscriptionRefOf(externalRefs),
  };
}

/**
 * Reconcile subscriptions stuck beyond the §10.2 window against the provider.
 *
 * A row is a candidate only when it is `incomplete`/`past_due` **and** neither
 * its `createdAt` nor its `updatedAt` has moved inside the last hour — the
 * double stamp is deliberate: a row created long ago but touched a minute ago is
 * progressing and must not be raced. A missing stamp counts as *not fresh*
 * (`$lt` never matches an absent field, so each stamp is `$lt` OR absent);
 * a both-present row keeps the shipped **and**. The correction is a conditional
 * `updateOne` whose filter carries the prior `status`, so a webhook that lands
 * mid-run wins and this job records a `skipped` no-op instead. The job
 * auto-applies only drift toward `active` (the missed activation/reactivation
 * webhook, which fabricates no side effects); any other status divergence is the
 * `admin.billing.manual_review` class — the row is left untouched and one outbox
 * row is emitted for an operator (contract §10.2; ADR-0502). A mandate-only
 * drift (same `status`, different `mandateStatus`) stays resolvable and silent.
 *
 * @param options - Database/clock seams and the per-run limit.
 * @returns The §10.2 run outcome (`hasMore` when the candidate window filled).
 */
export async function runBillingReconcile(options: BillingJobRunOptions): Promise<CronRunOutcome> {
  const db = options.db ?? getDb();
  const clock = options.clock ?? systemClock;
  const now = clock.now();
  const staleBefore = addMilliseconds(now, -STUCK_AFTER_MS);
  const subscriptions = platformRepo(db).collection(COLLECTIONS.subscriptions);

  const raw: unknown = await subscriptions
    .find({
      status: { $in: RECONCILABLE_STATUSES },
      $and: [
        { $or: [{ createdAt: { $lt: staleBefore } }, { createdAt: { $exists: false } }] },
        { $or: [{ updatedAt: { $lt: staleBefore } }, { updatedAt: { $exists: false } }] },
      ],
    })
    .sort({ createdAt: 1 })
    .limit(options.limit)
    .toArray();
  const candidates = Array.isArray(raw)
    ? raw.map(asReconcileCandidate).filter((row): row is ReconcileCandidate => row !== null)
    : [];

  let affected = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of candidates) {
    if (row.ref === null) {
      skipped += 1;
      continue;
    }

    let fetched: FetchStatusResult;
    try {
      fetched = await getPaymentProvider().fetchStatus(row.ref);
    } catch (error: unknown) {
      errors += 1;
      getLogger().warn("billing reconcile could not read the provider status", {
        event: "billing.reconcile.provider_error",
        provider: row.ref.provider,
        processError: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    // Any status divergence other than drift toward `active` needs the missed
    // webhook's own side effects (a grace clock, a dunning reset, a refund, an
    // access cut) that a reconciler must not invent: leave the row untouched
    // and hand it to an operator (contract §10.2; ADR-0502).
    if (fetched.status !== row.status && fetched.status !== "active") {
      skipped += 1;
      if (row.tenantId !== "" && row.subjectId !== null) {
        await emitDomainEvent(
          {
            eventKey: "admin.billing.manual_review",
            tenantId: row.tenantId,
            actorRef: { kind: "system", id: "billing-reconcile" },
            subjectRef: { kind: "subscription", id: row.subjectId },
            payload: { fromStatus: row.status, toStatus: fetched.status },
          },
          { db, clock }
        );
      }
      getLogger().warn("billing reconcile could not auto-apply a provider divergence", {
        event: "billing.reconcile.manual_review",
        provider: row.ref.provider,
        fromStatus: row.status,
        toStatus: fetched.status,
      });
      continue;
    }

    const patch: Record<string, unknown> = {};
    if (fetched.status !== row.status) {
      patch.status = fetched.status;
    }
    if (fetched.mandateStatus !== row.mandateStatus) {
      patch.mandateStatus = fetched.mandateStatus;
    }
    if (Object.keys(patch).length === 0) {
      skipped += 1;
      continue;
    }

    // The prior status stays in the filter: a webhook that landed while the
    // provider call was in flight must win, and this run is then a no-op.
    const result = await subscriptions.updateOne(
      { _id: row._id, status: row.status },
      { $set: { ...patch, updatedAt: now } }
    );
    if (result.matchedCount === 0) {
      skipped += 1;
      continue;
    }

    affected += 1;
    getLogger().warn("billing reconcile corrected a drifted subscription", {
      event: "billing.reconcile.drift",
      provider: row.ref.provider,
      fromStatus: row.status,
      toStatus: fetched.status,
      fromMandateStatus: row.mandateStatus,
      toMandateStatus: fetched.mandateStatus,
    });
  }

  const scanned = candidates.length;
  const outcome: CronRunOutcome = {
    scanned,
    affected,
    skipped,
    errors,
    hasMore: scanned === options.limit,
  };

  getLogger().info("billing reconcile completed", {
    event: "billing.billing_reconcile",
    ...outcome,
    limit: options.limit,
  });

  return outcome;
}
