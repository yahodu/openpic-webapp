import type { Db } from "mongodb";
import { z } from "zod";

import { COLLECTIONS } from "@/server/db/collections";
import { tenantRepo } from "@/server/repos";

/**
 * The subscription read view (OP-106, contract §3.2, schema §14.3; ADR-0400).
 *
 * §3.2 makes `GET /tenants/{tenantId}/subscription` "the single source for every
 * billing UI surface": the stored subscription, a **computed** `actions` block
 * (what *this* caller may do) and a **computed** `banner` (the one line of
 * reassurance the organizer sees). Both computed blocks are pure functions, so
 * the banner precedence and the actions matrix are pinned away from Mongo and
 * from the HTTP pipeline — this module holds them, the reads, and the served
 * shapes.
 *
 * The served document is the tenant's **most recently updated** `subscriptions`
 * row, including a `cancelled`/`expired` one: a workspace that cancelled keeps
 * seeing its cancellation rather than silently reverting to "free". Only the
 * **absence** of a row is the explicit free state (`exists: false`,
 * `status: "none"`), which is never a `404` — that is what makes "nothing was
 * deleted" true in the UI.
 *
 * Subscription rows are tenant-scoped on the **string** hex `tenantId` (the
 * OP-103/OP-104 convention), so every read goes through `tenantRepo`, which
 * stamps the scope structurally.
 */

/** The milliseconds in one UTC day, the unit `daysRemaining` counts in. */
const DAY_MS = 86_400_000;

/** The history cap §3.2 puts on the served `statusHistory` (schema §14.3). */
const HISTORY_LIMIT = 50;

/**
 * The reassurance copy §3.2 calls *the single most important copy in the
 * product*: the organizer must know their data survived a billing problem.
 */
export const REASSURANCE_COPY =
  "Your workspace and everything in it are safe — nothing has been deleted. You can keep working while this is sorted out.";

/** A subscription lifecycle status (schema §14.3). `none` is no document. */
export const subscriptionStatusSchema = z.enum([
  "none",
  "incomplete",
  "active",
  "past_due",
  "downgraded",
  "cancelled",
  "expired",
]);

/** A stored subscription status. */
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

/** A stored mandate status (schema §14.3). */
export const mandateStatusSchema = z.enum(["pending", "active", "paused", "revoked", "expired"]);

/** A stored mandate status. */
export type MandateStatus = z.infer<typeof mandateStatusSchema>;

/** The workspace role that decides whether a billing action is offered. */
export type SubscriptionActionRole = "owner" | "admin" | "member";

/** The five banner kinds §3.2 enumerates, in precedence order. */
const BANNER_KINDS = [
  "past_due",
  "downgraded",
  "mandate_pending",
  "mandate_revoked",
  "cancelling",
] as const;

/** A banner kind (contract §3.2 enumerates exactly five). */
export type SubscriptionBannerKind = (typeof BANNER_KINDS)[number];

/** The banner severities, from quietest to loudest. */
const BANNER_SEVERITIES = ["critical", "important", "informational"] as const;

/** How loudly the banner speaks: money problems are `critical`. */
export type SubscriptionBannerSeverity = (typeof BANNER_SEVERITIES)[number];

/**
 * The computed banner a client renders above the subscription view.
 *
 * `reassurance` is present **only** on `past_due`/`downgraded` (§3.2 makes it
 * mandatory exactly there); `daysRemaining`/`downgradeOn` are present only while
 * a `gracePeriodEndsAt` is set.
 */
export interface SubscriptionBanner {
  /** The discriminator the client switches on. */
  readonly kind: SubscriptionBannerKind;
  /** How loudly the banner speaks. */
  readonly severity: SubscriptionBannerSeverity;
  /** Whole days left in the grace window (never negative). */
  readonly daysRemaining?: number;
  /** The ISO instant the workspace drops to free. */
  readonly downgradeOn?: string;
  /** The §3.2 "nothing has been deleted" copy (money banners only). */
  readonly reassurance?: string;
}

/** The stored fields the banner builder reasons about. */
export interface SubscriptionFacts {
  /** The stored subscription status (`none` when there is no document). */
  readonly status: SubscriptionStatus;
  /** The stored mandate status, or `null` when there is none. */
  readonly mandateStatus: MandateStatus | null;
  /** The scheduled period-end cancellation, or `null`. */
  readonly cancelAt: Date | null;
  /** The end of the dunning grace window, or `null`. */
  readonly gracePeriodEndsAt: Date | null;
  /** The instant the countdown is measured from. */
  readonly now: Date;
}

/** The §3.2 `actions` block: what the caller may do next. */
export interface SubscriptionActions {
  /** May the caller start or move up to another plan? */
  readonly canUpgrade: boolean;
  /** May the caller move down to a cheaper plan? */
  readonly canDowngrade: boolean;
  /** May the caller cancel the subscription? */
  readonly canCancel: boolean;
  /** May the caller retry the outstanding charge? */
  readonly canRetryCharge: boolean;
  /** Must the caller finish the mandate before anything else? */
  readonly mustCompleteMandate: boolean;
}

/** The `actions` builder input. */
export interface SubscriptionActionsInput {
  /** The stored subscription status. */
  readonly status: SubscriptionStatus;
  /** The stored mandate status, or `null`. */
  readonly mandateStatus: MandateStatus | null;
  /** The caller's workspace role. */
  readonly role: SubscriptionActionRole;
}

/** An RFC 3339 UTC timestamp, the wire shape of every stored `Date`. */
const isoDateTime = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: "must be an RFC 3339 date-time",
});

/** The §3.2 `actions` block schema. */
export const subscriptionActionsSchema = z.object({
  canUpgrade: z.boolean(),
  canDowngrade: z.boolean(),
  canCancel: z.boolean(),
  canRetryCharge: z.boolean(),
  mustCompleteMandate: z.boolean(),
});

/** The §3.2 `banner` schema (five kinds, `reassurance` only where mandated). */
export const subscriptionBannerSchema = z.object({
  kind: z.enum(BANNER_KINDS),
  severity: z.enum(BANNER_SEVERITIES),
  daysRemaining: z.number().optional(),
  downgradeOn: isoDateTime.optional(),
  reassurance: z.string().optional(),
});

/** The §3.2 `pendingDue` block. */
const pendingDueSchema = z.object({
  amountMinor: z.number().int(),
  currency: z.literal("INR"),
});

/** The §3.2 `scheduledChange` block. */
const scheduledChangeSchema = z.object({
  toPlanKey: z.string(),
  effectiveAt: isoDateTime,
  reason: z.string(),
});

/** The payment method kinds schema §14.3 stores and this view serves. */
const paymentMethodKindSchema = z.enum([
  "mandate_upi",
  "mandate_bank_debit",
  "card",
  "invoice",
  "manual",
]);

/** The billing cycles schema §14.3 stores and this view serves. */
const billingCycleSchema = z.enum(["monthly", "yearly"]);

/**
 * The served subscription view **without** `actions`.
 *
 * `actions` depends on the caller's role, so the read cannot compute it; the
 * route composes the two (`{ ...view, actions: buildSubscriptionActions(…) }`).
 * Every optional field is served only when the stored row carries it — a field
 * is never invented.
 */
export const subscriptionViewFactsSchema = z.object({
  tenantId: z.string(),
  exists: z.boolean(),
  status: subscriptionStatusSchema,
  subscribedPlanKey: z.string(),
  subscribedPlanVersion: z.number().optional(),
  activePlanKey: z.string(),
  priceKey: z.string().optional(),
  billingCycle: billingCycleSchema.optional(),
  paymentMethodKind: paymentMethodKindSchema.optional(),
  mandateStatus: mandateStatusSchema.nullable().optional(),
  currentPeriodStart: isoDateTime.optional(),
  currentPeriodEnd: isoDateTime.optional(),
  nextChargeAt: isoDateTime.optional(),
  gracePeriodEndsAt: isoDateTime.nullable().optional(),
  pendingDue: pendingDueSchema.nullable(),
  scheduledChange: scheduledChangeSchema.nullable().optional(),
  cancelAt: isoDateTime.nullable().optional(),
  banner: subscriptionBannerSchema.nullable(),
  updatedAt: isoDateTime.optional(),
});

/** The served subscription view (a bare single resource, §0.5). */
export const subscriptionViewSchema = subscriptionViewFactsSchema.extend({
  actions: subscriptionActionsSchema,
});

/** The served subscription view, without the role-dependent `actions`. */
export type SubscriptionViewFacts = z.infer<typeof subscriptionViewFactsSchema>;

/** The served subscription view. */
export type SubscriptionView = z.infer<typeof subscriptionViewSchema>;

/** One `statusHistory` transition as served (schema §14.3). */
export const statusHistoryEntrySchema = z.object({
  from: z.string(),
  to: z.string(),
  at: isoDateTime,
  reason: z.string(),
  actor: z.string(),
});

/** One served `statusHistory` transition. */
export type StatusHistoryEntry = z.infer<typeof statusHistoryEntrySchema>;

/** The §3.2 history body (§0.5 collection envelope). */
export const subscriptionHistorySchema = z.object({ data: z.array(statusHistoryEntrySchema) });

/** One stored `statusHistory` transition. */
const storedHistoryEntrySchema = z.object({
  from: z.string(),
  to: z.string(),
  at: z.date(),
  reason: z.string(),
  actor: z.string(),
});

/**
 * The stored `subscriptions` fields this view reads (schema §14.3).
 *
 * Everything the view does not serve — `_id`, `externalRefs`, `dunning`,
 * `cancelledAt`/`cancelReason`, `previousSubscriptionId`, `createdAt` — is
 * simply not declared, so a projection can never carry it (§0.15 never-return).
 */
const storedSubscriptionSchema = z.object({
  status: subscriptionStatusSchema,
  subscribedPlanKey: z.string().default("free"),
  subscribedPlanVersion: z.number().optional(),
  activePlanKey: z.string().default("free"),
  priceKey: z.string().optional(),
  billingCycle: billingCycleSchema.optional(),
  paymentMethodKind: paymentMethodKindSchema.optional(),
  mandateStatus: mandateStatusSchema.nullable().optional(),
  currentPeriodStart: z.date().optional(),
  currentPeriodEnd: z.date().optional(),
  nextChargeAt: z.date().optional(),
  gracePeriodEndsAt: z.date().nullable().optional(),
  pendingDueMinor: z.number().default(0),
  currency: z.literal("INR").default("INR"),
  scheduledChange: z
    .object({ toPlanKey: z.string(), effectiveAt: z.date(), reason: z.string() })
    .nullable()
    .optional(),
  cancelAt: z.date().nullable().optional(),
  statusHistory: z.array(storedHistoryEntrySchema).default([]),
  updatedAt: z.date().optional(),
});

/** The stored subscription shape the reads project. */
type StoredSubscription = z.infer<typeof storedSubscriptionSchema>;

/**
 * Whole days remaining until `until`, rounded **up** and never negative.
 *
 * A partial final day counts as a whole one (the user is still inside it), a
 * single millisecond left is `1`, and an instant already reached — or an
 * elapsed window, which a stale dunning row can leave behind — clamps to `0`
 * rather than printing a negative countdown. The arithmetic is UTC
 * milliseconds only, so it is independent of the tenant's time zone.
 *
 * @param until - The deadline.
 * @param now - The instant to measure from.
 * @returns The non-negative whole-day count.
 */
export function daysRemaining(until: Date, now: Date): number {
  return Math.max(0, Math.ceil((until.getTime() - now.getTime()) / DAY_MS));
}

/**
 * Build the §3.2 banner, the first matching rule winning.
 *
 * `past_due` (the money banner) outranks a revoked mandate, which outranks a
 * scheduled cancellation; `incomplete` asks the user to finish the mandate.
 * `reassurance` is attached to `past_due`/`downgraded` only — exactly where
 * §3.2 makes it mandatory — and `daysRemaining`/`downgradeOn` only while a
 * grace window is set.
 *
 * @param facts - The stored status/mandate/cancel/grace fields plus `now`.
 * @returns The banner, or `null` when the workspace is healthy or terminal.
 */
export function buildSubscriptionBanner(facts: SubscriptionFacts): SubscriptionBanner | null {
  if (facts.status === "past_due") {
    const grace = facts.gracePeriodEndsAt;
    if (grace === null) {
      return { kind: "past_due", severity: "critical", reassurance: REASSURANCE_COPY };
    }
    return {
      kind: "past_due",
      severity: "critical",
      daysRemaining: daysRemaining(grace, facts.now),
      downgradeOn: grace.toISOString(),
      reassurance: REASSURANCE_COPY,
    };
  }
  if (facts.status === "downgraded") {
    return { kind: "downgraded", severity: "critical", reassurance: REASSURANCE_COPY };
  }
  if (facts.status === "active" && facts.mandateStatus === "revoked") {
    return { kind: "mandate_revoked", severity: "important" };
  }
  if (facts.status === "incomplete") {
    return { kind: "mandate_pending", severity: "informational" };
  }
  if (facts.cancelAt !== null) {
    return { kind: "cancelling", severity: "informational" };
  }
  return null;
}

/**
 * Build the §3.2 `actions` block: what **this caller** may do.
 *
 * Every billing mutation in §3.3 is `owner`-only while this read is open to any
 * member, so a `member` — and an `admin`, which §3.3 does not authorise — sees
 * every action `false`. For an `owner`, `canUpgrade` is `false` only while
 * `incomplete`; `canDowngrade` needs a live paid state; `canCancel` covers the
 * states that still have something to cancel; `canRetryCharge` needs an
 * outstanding charge **and** a chargeable mandate; and `mustCompleteMandate` is
 * exactly `incomplete`.
 *
 * @param input - The stored status/mandate and the caller's role.
 * @returns The `actions` block.
 */
export function buildSubscriptionActions(input: SubscriptionActionsInput): SubscriptionActions {
  if (input.role !== "owner") {
    return {
      canUpgrade: false,
      canDowngrade: false,
      canCancel: false,
      canRetryCharge: false,
      mustCompleteMandate: false,
    };
  }

  const { status, mandateStatus } = input;
  const chargeable = mandateStatus !== "revoked" && mandateStatus !== "expired";

  return {
    canUpgrade: status !== "incomplete",
    canDowngrade: status === "active" || status === "past_due",
    canCancel:
      status === "incomplete" ||
      status === "active" ||
      status === "past_due" ||
      status === "downgraded",
    canRetryCharge: (status === "past_due" || status === "downgraded") && chargeable,
    mustCompleteMandate: status === "incomplete",
  };
}

/**
 * Load the tenant's most recently updated `subscriptions` row, or `null`.
 *
 * @param db - The database handle.
 * @param tenantId - The string hex workspace id every query is scoped to.
 * @returns The parsed stored row, or `null` when the workspace has none.
 */
async function loadSubscriptionRow(db: Db, tenantId: string): Promise<StoredSubscription | null> {
  const row = await tenantRepo(tenantId, db)
    .collection(COLLECTIONS.subscriptions)
    .findOne({}, { sort: { updatedAt: -1 } });
  return row === null ? null : storedSubscriptionSchema.parse(row);
}

/** The explicit free state: no document is a first-class state, never a 404. */
function freeView(tenantId: string): SubscriptionViewFacts {
  return {
    tenantId,
    exists: false,
    status: "none",
    subscribedPlanKey: "free",
    activePlanKey: "free",
    pendingDue: null,
    banner: null,
  };
}

/**
 * Project a stored row onto the served view (dates become RFC 3339 strings).
 *
 * @param row - The parsed stored row.
 * @param tenantId - The string hex workspace id echoed in the body.
 * @param now - The instant the banner countdown is measured from.
 * @returns The served view fields (without the role-dependent `actions`).
 */
function projectStoredRow(
  row: StoredSubscription,
  tenantId: string,
  now: Date
): SubscriptionViewFacts {
  const mandateStatus = row.mandateStatus ?? null;
  const gracePeriodEndsAt = row.gracePeriodEndsAt ?? null;
  const cancelAt = row.cancelAt ?? null;
  const scheduledChange =
    row.scheduledChange === null || row.scheduledChange === undefined
      ? row.scheduledChange
      : {
          toPlanKey: row.scheduledChange.toPlanKey,
          effectiveAt: row.scheduledChange.effectiveAt.toISOString(),
          reason: row.scheduledChange.reason,
        };

  return {
    tenantId,
    exists: true,
    status: row.status,
    subscribedPlanKey: row.subscribedPlanKey,
    subscribedPlanVersion: row.subscribedPlanVersion,
    activePlanKey: row.activePlanKey,
    priceKey: row.priceKey,
    billingCycle: row.billingCycle,
    paymentMethodKind: row.paymentMethodKind,
    mandateStatus: row.mandateStatus,
    currentPeriodStart: row.currentPeriodStart?.toISOString(),
    currentPeriodEnd: row.currentPeriodEnd?.toISOString(),
    nextChargeAt: row.nextChargeAt?.toISOString(),
    gracePeriodEndsAt: gracePeriodEndsAt === null ? null : gracePeriodEndsAt.toISOString(),
    pendingDue:
      row.pendingDueMinor > 0 ? { amountMinor: row.pendingDueMinor, currency: row.currency } : null,
    scheduledChange,
    cancelAt: cancelAt === null ? null : cancelAt.toISOString(),
    banner: buildSubscriptionBanner({
      status: row.status,
      mandateStatus,
      cancelAt,
      gracePeriodEndsAt,
      now,
    }),
    updatedAt: row.updatedAt?.toISOString(),
  };
}

/**
 * Read the §3.2 subscription view for a workspace.
 *
 * A workspace with no `subscriptions` row reads as the explicit free state
 * (`exists: false`, `status: "none"`), not a `404`; otherwise the tenant's most
 * recently updated row is served, with its computed `banner`. The
 * role-dependent `actions` block is composed by the route.
 *
 * @param db - The database handle.
 * @param tenantId - The string hex workspace id.
 * @param now - The instant the banner countdown is measured from.
 * @returns The served view fields.
 */
export async function readSubscriptionView(
  db: Db,
  tenantId: string,
  now: Date
): Promise<SubscriptionViewFacts> {
  const row = await loadSubscriptionRow(db, tenantId);
  return row === null ? freeView(tenantId) : projectStoredRow(row, tenantId, now);
}

/**
 * Read the workspace's `statusHistory`, newest first and capped at 50.
 *
 * Schema §14.3 lets the stored array grow to ~50 rows; the read refuses to
 * serve an over-long list verbatim (a whole 60-row list, or the oldest 50, both
 * fail the pins). A workspace with no document answers the empty list, never a
 * `404` — the free state is explicit in every §3.2 surface.
 *
 * @param db - The database handle.
 * @param tenantId - The string hex workspace id.
 * @returns The newest-first, capped transitions.
 */
export async function readSubscriptionHistory(
  db: Db,
  tenantId: string
): Promise<readonly StatusHistoryEntry[]> {
  const row = await loadSubscriptionRow(db, tenantId);
  if (row === null) {
    return [];
  }
  return [...row.statusHistory]
    .sort((left, right) => right.at.getTime() - left.at.getTime())
    .slice(0, HISTORY_LIMIT)
    .map((entry) => ({
      from: entry.from,
      to: entry.to,
      at: entry.at.toISOString(),
      reason: entry.reason,
      actor: entry.actor,
    }));
}
