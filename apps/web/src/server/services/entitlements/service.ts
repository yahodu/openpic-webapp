import type { ClientSession, Db, Document } from "mongodb";
import { z } from "zod";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { emitDomainEvent, type DomainEventInput } from "@/server/domain/domain-events";
import type { AppError } from "@/server/http/app-error";
import { appError } from "@/server/http/errors";
import { getLogger } from "@/server/logging";
import { planSchema } from "@/server/plans/plans";
import { platformRepo, tenantRepo, type RepositoryCollection } from "@/server/repos";
import { systemClock, type Clock } from "@/server/runtime/clock";

import { effectiveLimit, periodKey } from "./policy";
import type {
  EntitlementAllowedVerdict,
  EntitlementCheckOptions,
  EntitlementConsumeOptions,
  EntitlementContext,
  EntitlementDenialReason,
  EntitlementDeniedVerdict,
  EntitlementEventEmitter,
  EntitlementGrant,
  EntitlementReleaseOptions,
  EntitlementScope,
  EntitlementSpec,
  EntitlementVerdict,
} from "./types";

/**
 * The generic entitlement check, consumption and release (OP-103, schema
 * §14.2/§14.3/§23, contract §0.14; ADR-0340, ADR-0341).
 *
 * Every mutating endpoint that consumes a metered resource calls
 * {@link consumeEntitlement} **inside the same transaction** as the domain
 * write, so the check, the `$inc` and the caller's write commit or abort
 * together. The limit itself is *policy as data* —
 * `plans.entitlements[key]` — so no plan is named anywhere in this directory.
 *
 * - {@link checkEntitlement} is the **decision**: it reads the live
 *   subscription, the plan spec, the grants and the counter, and returns the
 *   schema §14.2 verdict. It never throws for a denial.
 * - {@link consumeEntitlement} is the **enforcement point**: it re-checks
 *   inside the caller's session, advances the counter with one conditional
 *   update, and on a denial emits `usage.action.blocked` (outside the aborted
 *   transaction) and throws the Appendix A `AppError`.
 * - {@link releaseEntitlement} reverses a consumption for a delete, clamped at
 *   zero.
 */

/** The blocked-action event key (contract §0.14, notification catalogue §4.4). */
const BLOCKED_EVENT_KEY = "usage.action.blocked";

/** The upgrade offer carried by a `plan_limit_exceeded` / `feature_not_available`. */
const UPGRADE_PATH = "/api/v1/tenants/current/billing/upgrade";

/** MongoDB's duplicate-key server error code. */
const DUPLICATE_KEY = 11000;

/** The stored fields of a `subscriptions` row this service reads. */
const subscriptionRowSchema = z.object({
  status: z.string().nullable().default(null),
  activePlanKey: z.string().default("free"),
  pendingDueMinor: z.number().nullable().default(null),
  currency: z.string().nullable().default(null),
  gracePeriodEndsAt: z.date().nullable().default(null),
});

/** The stored fields of an `entitlementGrants` row. */
const grantRowSchema = z.object({
  delta: z.number(),
  overrideLimit: z.number().nullable(),
  validFrom: z.date(),
  validUntil: z.date().nullable(),
});

/** The stored fields of a `usageCounters` row. */
const counterRowSchema = z.object({ value: z.number() });

/** The resolved inputs the decision surface reasons about. */
interface ResolvedEntitlement {
  readonly tenantId: string;
  readonly entitlementKey: string;
  readonly spec: EntitlementSpec | null;
  readonly limit: number | null;
  readonly effectiveLimit: number | null;
  readonly periodKey: string;
  readonly scope: EntitlementScope;
  readonly used: number;
  readonly status: string | null;
  readonly pendingDueMinor: number | null;
  readonly currency: string | null;
  readonly gracePeriodEndsAt: Date | null;
}

/** The resolved seams every private helper takes. */
interface Seams {
  readonly db: Db;
  readonly clock: Clock;
  /** The caller's transaction, or `undefined` for a read-only check. */
  readonly session: ClientSession | undefined;
}

/**
 * Apply the production defaults to a caller's optional seams.
 *
 * @param options - The caller's `{ db?, clock? }`.
 * @param session - The caller's transaction, if any.
 * @returns The seams every helper reads through.
 */
function resolveSeams(
  options: { readonly db?: Db; readonly clock?: Clock },
  session: ClientSession | undefined
): Seams {
  return { db: options.db ?? getDb(), clock: options.clock ?? systemClock, session };
}

/** True when an error is MongoDB's duplicate-key (E11000) refusal. */
function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === DUPLICATE_KEY
  );
}

/** The driver options that carry the caller's transaction, if any. */
function sessionOptions(deps: Seams): Document {
  return deps.session === undefined ? {} : { session: deps.session };
}

/**
 * Resolve the plan spec, the effective limit, the period key and the usage for
 * one key. Reads only; the caller decides.
 *
 * @param tenantId - The tenant the usage belongs to.
 * @param entitlementKey - The metered key.
 * @param ctx - Caller context (counts for `event`/`attendee` scope).
 * @param deps - Database/clock/session seams.
 * @returns The resolved inputs.
 */
async function resolveEntitlement(
  tenantId: string,
  entitlementKey: string,
  ctx: EntitlementContext,
  deps: Seams
): Promise<ResolvedEntitlement> {
  const now = deps.clock.now();
  const options = sessionOptions(deps);

  const subscriptionRow = await tenantRepo(tenantId, deps.db)
    .collection(COLLECTIONS.subscriptions)
    .findOne({ status: { $ne: "cancelled" } }, options);
  const subscription =
    subscriptionRow === null ? null : subscriptionRowSchema.parse(subscriptionRow);

  // Resolved once, before the early return, so both verdicts carry the same
  // subscription-derived fields from one resolution — the `null` side is
  // exercised by a tenant that has no live subscription row.
  const subscriptionStatus = subscription === null ? null : subscription.status;
  const subscriptionPendingDueMinor = subscription === null ? null : subscription.pendingDueMinor;
  const subscriptionCurrency = subscription === null ? null : subscription.currency;
  const subscriptionGracePeriodEndsAt =
    subscription === null ? null : subscription.gracePeriodEndsAt;
  const planKey = subscription === null ? "free" : subscription.activePlanKey;

  const planRow = await platformRepo(deps.db)
    .collection(COLLECTIONS.plans)
    .findOne({ key: planKey }, options);
  const spec =
    planRow === null ? null : (planSchema.parse(planRow).entitlements[entitlementKey] ?? null);

  if (spec === null) {
    return {
      tenantId,
      entitlementKey,
      spec: null,
      limit: null,
      effectiveLimit: null,
      periodKey: "lifetime",
      scope: "tenant",
      used: 0,
      status: subscriptionStatus,
      pendingDueMinor: subscriptionPendingDueMinor,
      currency: subscriptionCurrency,
      gracePeriodEndsAt: subscriptionGracePeriodEndsAt,
    };
  }

  const grants: readonly EntitlementGrant[] = await tenantRepo(tenantId, deps.db)
    .collection(COLLECTIONS.entitlementGrants)
    .find({ entitlementKey }, options)
    .toArray()
    .then((rows) => rows.map((row) => grantRowSchema.parse(row)));

  const key = periodKey(spec.resetPeriod, now);
  const used =
    spec.scope === "tenant"
      ? await readCounterValue(tenantId, entitlementKey, key, deps)
      : (ctx.counts ?? 0);

  return {
    tenantId,
    entitlementKey,
    spec,
    limit: spec.limit,
    effectiveLimit: effectiveLimit(spec, grants, now),
    periodKey: key,
    scope: spec.scope,
    used,
    status: subscriptionStatus,
    pendingDueMinor: subscriptionPendingDueMinor,
    currency: subscriptionCurrency,
    gracePeriodEndsAt: subscriptionGracePeriodEndsAt,
  };
}

/** Read the stored counter value for a `tenant`-scoped key, or `0`. */
async function readCounterValue(
  tenantId: string,
  entitlementKey: string,
  key: string,
  deps: Seams
): Promise<number> {
  const row = await tenantRepo(tenantId, deps.db)
    .collection(COLLECTIONS.usageCounters)
    .findOne({ entitlementKey, periodKey: key }, sessionOptions(deps));
  return row === null ? 0 : counterRowSchema.parse(row).value;
}

/** Build the allowed verdict from a resolved state and a usage value. */
function allowedVerdict(resolved: ResolvedEntitlement, used: number): EntitlementAllowedVerdict {
  return {
    allowed: true,
    entitlementKey: resolved.entitlementKey,
    limit: resolved.limit,
    effectiveLimit: resolved.effectiveLimit,
    used,
    remaining: resolved.effectiveLimit === null ? null : resolved.effectiveLimit - used,
    periodKey: resolved.periodKey,
    scope: resolved.scope,
    unlimited: resolved.effectiveLimit === null,
  };
}

/** Build the denied verdict from a resolved state and a reason. */
function deniedVerdict(
  resolved: ResolvedEntitlement,
  reason: EntitlementDenialReason
): EntitlementDeniedVerdict {
  return {
    allowed: false,
    reason,
    entitlementKey: resolved.entitlementKey,
    limit: resolved.limit,
    effectiveLimit: resolved.effectiveLimit,
    used: resolved.used,
    periodKey: resolved.periodKey,
    scope: resolved.scope,
    pendingDueMinor: resolved.pendingDueMinor,
    currency: resolved.currency,
    gracePeriodEndsAt: resolved.gracePeriodEndsAt,
  };
}

/**
 * Decide whether `amount` may be consumed: the schema §14.2 decision surface.
 *
 * A key the active plan does not gate, an unlimited limit, and a feature whose
 * gate is open are all allowed. A hard limit is denied once `used + amount`
 * exceeds it, and a `downgraded` subscription turns that denial into
 * `payment_downgrade` (the `402` vs `403` split).
 */
function decide(resolved: ResolvedEntitlement, amount: number): EntitlementVerdict {
  const spec = resolved.spec;
  if (spec === null) {
    return allowedVerdict(resolved, resolved.used);
  }
  if (spec.enforcement === "feature") {
    return spec.enabled === true
      ? allowedVerdict(resolved, resolved.used)
      : deniedVerdict(resolved, "feature_not_available");
  }
  if (resolved.effectiveLimit === null) {
    return allowedVerdict(resolved, resolved.used);
  }
  if (resolved.used + amount > resolved.effectiveLimit) {
    return deniedVerdict(
      resolved,
      resolved.status === "downgraded" ? "payment_downgrade" : "plan_limit"
    );
  }
  return allowedVerdict(resolved, resolved.used);
}

/**
 * Check one entitlement and return the verdict (schema §14.2).
 *
 * Never throws for a denial — the verdict carries `allowed: false` and the
 * `reason` the `402` vs `403` mapping is derived from.
 *
 * @param tenantId - The tenant the usage belongs to.
 * @param entitlementKey - The metered key.
 * @param amount - The amount about to be consumed (default `1`).
 * @param ctx - Caller context (counts, event refs).
 * @param options - Database/clock/session seams.
 * @returns The verdict.
 */
export async function checkEntitlement(
  tenantId: string,
  entitlementKey: string,
  amount = 1,
  ctx: EntitlementContext = {},
  options: EntitlementCheckOptions = {}
): Promise<EntitlementVerdict> {
  const resolved = await resolveEntitlement(
    tenantId,
    entitlementKey,
    ctx,
    resolveSeams(options, options.session)
  );
  return decide(resolved, amount);
}

/**
 * Atomically advance the counter by `amount`, admitting the write only while
 * the stored value leaves room for it.
 *
 * The conditional `$inc` is race-safe only with the schema §14.2 unique
 * `{tenantId, entitlementKey, periodKey}` index; the upsert that creates the
 * row on first use can lose that race, so a duplicate-key insert is retried as
 * a plain update.
 *
 * @returns The counter's new value.
 */
async function advanceCounter(
  resolved: ResolvedEntitlement,
  amount: number,
  deps: Seams
): Promise<number> {
  const limit = resolved.effectiveLimit;
  const collection = tenantRepo(resolved.tenantId, deps.db).collection(COLLECTIONS.usageCounters);
  const filter: Document = {
    entitlementKey: resolved.entitlementKey,
    periodKey: resolved.periodKey,
    ...(limit === null ? {} : { value: { $lte: limit - amount } }),
  };
  const update: Document = {
    $inc: { value: amount },
    $set: { updatedAt: deps.clock.now() },
  };

  const created = await applyCounterUpdate(collection, filter, update, deps, true);
  if (created !== null) {
    return created;
  }
  const retried = await applyCounterUpdate(collection, filter, update, deps, false);
  return (
    retried ??
    (await readCounterValue(resolved.tenantId, resolved.entitlementKey, resolved.periodKey, deps))
  );
}

/** Apply one `findOneAndUpdate`, returning the new value or `null`. */
async function applyCounterUpdate(
  collection: RepositoryCollection,
  filter: Document,
  update: Document,
  deps: Seams,
  upsert: boolean
): Promise<number | null> {
  try {
    const row = await collection.findOneAndUpdate(filter, update, {
      returnDocument: "after",
      upsert,
      ...sessionOptions(deps),
    });
    return row === null ? null : counterRowSchema.parse(row).value;
  } catch (error) {
    if (upsert && isDuplicateKeyError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Release `amount` from the counter, clamped at zero, and return the new value.
 */
async function releaseCounter(
  resolved: ResolvedEntitlement,
  amount: number,
  deps: Seams
): Promise<number> {
  const collection = tenantRepo(resolved.tenantId, deps.db).collection(COLLECTIONS.usageCounters);
  const filter: Document = {
    entitlementKey: resolved.entitlementKey,
    periodKey: resolved.periodKey,
  };
  const options = { returnDocument: "after", ...sessionOptions(deps) };
  const updatedAt = deps.clock.now();

  const decremented = await collection.findOneAndUpdate(
    { ...filter, value: { $gte: amount } },
    { $inc: { value: -amount }, $set: { updatedAt } },
    options
  );
  if (decremented !== null) {
    return counterRowSchema.parse(decremented).value;
  }

  // The first attempt failed, so the stored value is below `amount` (or no row
  // exists): the decrement clamps to `0`, which is exactly the release target.
  await collection.findOneAndUpdate(
    { ...filter, value: { $gt: 0, $lt: amount } },
    { $set: { value: 0, updatedAt } },
    options
  );
  return 0;
}

/** The UTC hour bucket a denial's dedupe key collapses to. */
function hourBucket(now: Date): string {
  return now.toISOString().slice(0, 13);
}

/**
 * Emit `usage.action.blocked` (once per tenant/key/hour) and log the denial.
 *
 * The emit is a best-effort side effect: a rejection is swallowed and recorded
 * as a `warn` line (`entitlement.denied.emit_failed`) so the lost
 * `usage.action.blocked` row stays observable, but a broken outbox can never
 * replace the denial `AppError` the caller is about to throw (OP-103 follow-up
 * F2; contract §0.14). This mirrors the `safeEmit` seam in
 * `@/server/auth/identity-hooks`.
 */
async function recordDenial(
  tenantId: string,
  verdict: EntitlementDeniedVerdict,
  ctx: EntitlementContext,
  deps: { readonly db: Db; readonly clock: Clock; readonly emit?: EntitlementEventEmitter }
): Promise<void> {
  getLogger().info("entitlement.denied", {
    event: "entitlement.denied",
    tenantId,
    entitlementKey: verdict.entitlementKey,
    used: verdict.used,
    limit: verdict.limit,
    reason: verdict.reason,
  });

  const input: DomainEventInput = {
    eventKey: BLOCKED_EVENT_KEY,
    tenantId,
    actorRef: ctx.actorRef ?? { kind: "tenant", id: tenantId },
    subjectRef: ctx.subjectRef ?? { kind: "entitlement", id: verdict.entitlementKey },
    payload: {
      entitlementKey: verdict.entitlementKey,
      reason: verdict.reason,
      limit: verdict.limit,
      used: verdict.used,
      periodKey: verdict.periodKey,
      scope: verdict.scope,
    },
    dedupeKey: `${tenantId}:${verdict.entitlementKey}:${hourBucket(deps.clock.now())}`,
  };

  try {
    if (deps.emit === undefined) {
      await emitDomainEvent(input, { db: deps.db, clock: deps.clock });
    } else {
      await deps.emit(input);
    }
  } catch (error) {
    getLogger().warn("entitlement.denied.emit_failed", {
      event: "entitlement.denied.emit_failed",
      tenantId,
      entitlementKey: verdict.entitlementKey,
      err: error,
    });
  }
}

/** Map a denied verdict onto the Appendix A `AppError` (contract §0.14). */
function denialError(tenantId: string, verdict: EntitlementDeniedVerdict): AppError {
  if (verdict.reason === "payment_downgrade") {
    return appError("payment_required", {
      details: {
        entitlementKey: verdict.entitlementKey,
        reason: "payment_downgrade",
        pendingDueMinor: verdict.pendingDueMinor,
        currency: verdict.currency,
        payNowUrl: `/api/v1/tenants/${tenantId}/billing/retry-charge`,
        gracePeriodEndsAt:
          verdict.gracePeriodEndsAt === null ? null : verdict.gracePeriodEndsAt.toISOString(),
      },
    });
  }
  if (verdict.reason === "feature_not_available") {
    return appError("feature_not_available", {
      details: { entitlementKey: verdict.entitlementKey, upgradePath: UPGRADE_PATH },
    });
  }
  return appError("plan_limit_exceeded", {
    details: {
      entitlementKey: verdict.entitlementKey,
      limit: verdict.limit,
      used: verdict.used,
      periodKey: verdict.periodKey,
      scope: verdict.scope,
      reason: "plan_limit",
      upgradePath: UPGRADE_PATH,
    },
  });
}

/**
 * Consume `amount` of a metered key inside the caller's transaction.
 *
 * Re-checks, then advances the counter atomically. On a denial it emits the
 * durable `usage.action.blocked` event **outside** the caller's session (the
 * throw aborts that transaction, and the blocked record must survive it) and
 * throws the Appendix A `AppError`. A rejected blocked-emit is swallowed (and
 * logged at `warn`) so it can never replace that denial.
 *
 * @param session - The caller's transaction; every read and write joins it.
 * @param tenantId - The tenant the usage belongs to.
 * @param entitlementKey - The metered key.
 * @param amount - The amount to consume (default `1`).
 * @param ctx - Caller context (counts, event refs).
 * @param options - Database/clock/emitter seams.
 * @returns The allowed verdict, with the post-increment `used`.
 * @throws {AppError} `plan_limit_exceeded` / `payment_required` /
 *   `feature_not_available` on a denial.
 */
export async function consumeEntitlement(
  session: ClientSession,
  tenantId: string,
  entitlementKey: string,
  amount = 1,
  ctx: EntitlementContext = {},
  options: EntitlementConsumeOptions = {}
): Promise<EntitlementVerdict> {
  const seams = resolveSeams(options, session);
  const resolved = await resolveEntitlement(tenantId, entitlementKey, ctx, seams);
  const verdict = decide(resolved, amount);

  if (!verdict.allowed) {
    await recordDenial(tenantId, verdict, ctx, {
      db: seams.db,
      clock: seams.clock,
      ...(options.emit === undefined ? {} : { emit: options.emit }),
    });
    throw denialError(tenantId, verdict);
  }

  const used = await advanceCounter(resolved, amount, seams);
  return allowedVerdict(resolved, used);
}

/**
 * Release `amount` of a metered key inside the caller's transaction.
 *
 * The reversal for a delete (contract §0.14 C6): decrements the counter,
 * clamped at zero, and returns the resulting verdict. Never denies.
 *
 * Only a `tenant`-scoped key decrements a `usageCounters` row, because only a
 * `tenant`-scoped key reads one: for `event`/`attendee` scope the caller's
 * `ctx.counts` is the sole usage source, so the release neither writes a counter
 * nor reports its value — it mirrors the consume decision (ADR-0342, ADR-0347).
 *
 * @param session - The caller's transaction; the counter write joins it.
 * @param tenantId - The tenant the usage belongs to.
 * @param entitlementKey - The metered key.
 * @param amount - The amount to release (default `1`).
 * @param ctx - Caller context (counts).
 * @param options - Database/clock seams.
 * @returns The allowed verdict, with the post-release `used` for a
 *   `tenant`-scoped key or the clamped `ctx.counts` otherwise.
 */
export async function releaseEntitlement(
  session: ClientSession,
  tenantId: string,
  entitlementKey: string,
  amount = 1,
  ctx: EntitlementContext = {},
  options: EntitlementReleaseOptions = {}
): Promise<EntitlementVerdict> {
  const seams = resolveSeams(options, session);
  const resolved = await resolveEntitlement(tenantId, entitlementKey, ctx, seams);

  if (resolved.scope !== "tenant") {
    const counts = ctx.counts ?? 0;
    return allowedVerdict(resolved, amount > counts ? 0 : counts);
  }

  const used = await releaseCounter(resolved, amount, seams);
  return allowedVerdict(resolved, used);
}
