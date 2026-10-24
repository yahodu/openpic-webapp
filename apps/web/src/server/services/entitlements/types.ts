import type { ClientSession, Db } from "mongodb";

import type {
  DomainEventInput,
  DomainEventRef,
  EmitDomainEventResult,
} from "@/server/domain/domain-events";
import type { Entitlement } from "@/server/plans/plans";
import type { Clock } from "@/server/runtime/clock";

/**
 * Types for the generic entitlement service (OP-103, schema §14.2, contract
 * §0.14; ADR-0340/ADR-0341).
 *
 * `plans.entitlements[key]` is *policy as data*: the service resolves a limit
 * from the stored, self-describing spec, so a new tier or a new limit is a data
 * edit with zero code change. Nothing in this module names a plan.
 */

/** The self-describing entitlement spec (schema §14.1). */
export type EntitlementSpec = Entitlement;

/** What an entitlement's usage is counted against. */
export type EntitlementScope = Entitlement["scope"];

/** The reset cadence of an entitlement. */
export type ResetPeriod = Entitlement["resetPeriod"];

/**
 * An additive top-up row (`entitlementGrants`, schema §14.2).
 *
 * A grant is **active** while `validFrom <= now < validUntil` (the upper bound
 * is exclusive; `validUntil: null` is open-ended). A non-null `overrideLimit`
 * replaces the plan limit and the deltas entirely — the negotiated-contract
 * escape hatch.
 */
export interface EntitlementGrant {
  /** The additive amount added to the plan limit while active. */
  readonly delta: number;
  /** When non-null, replaces the plan limit and every delta. */
  readonly overrideLimit: number | null;
  /** The inclusive lower bound of the grant's window. */
  readonly validFrom: Date;
  /** The exclusive upper bound of the grant's window; `null` is open-ended. */
  readonly validUntil: Date | null;
}

/**
 * Caller-supplied context.
 *
 * `counts` supplies the usage for an `event`/`attendee`-scoped key (the service
 * reads the counter itself only for `tenant` scope). The refs are used when a
 * denial emits `usage.action.blocked`.
 */
export interface EntitlementContext {
  /** The current usage for an `event`/`attendee`-scoped key. */
  readonly counts?: number;
  /** The actor of the blocked action; defaults to the tenant. */
  readonly actorRef?: DomainEventRef;
  /** The subject of the blocked action; defaults to the entitlement. */
  readonly subjectRef?: DomainEventRef;
}

/** Why an entitlement was denied. */
export type EntitlementDenialReason = "plan_limit" | "payment_downgrade" | "feature_not_available";

/** The verdict for an allowed (or not-gated) entitlement check. */
export interface EntitlementAllowedVerdict {
  readonly allowed: true;
  readonly entitlementKey: string;
  /** The raw plan limit, or `null` for unlimited. */
  readonly limit: number | null;
  /** `overrideLimit ?? plan.limit + Σ active grants.delta`, or `null`. */
  readonly effectiveLimit: number | null;
  readonly used: number;
  /** `effectiveLimit - used`, or `null` when unlimited. */
  readonly remaining: number | null;
  readonly periodKey: string;
  readonly scope: EntitlementScope;
  readonly unlimited: boolean;
}

/** The verdict for a denied entitlement check. */
export interface EntitlementDeniedVerdict {
  readonly allowed: false;
  readonly reason: EntitlementDenialReason;
  readonly entitlementKey: string;
  readonly limit: number | null;
  readonly effectiveLimit: number | null;
  readonly used: number;
  readonly periodKey: string;
  readonly scope: EntitlementScope;
  readonly pendingDueMinor: number | null;
  readonly currency: string | null;
  readonly gracePeriodEndsAt: Date | null;
}

/** The discriminated decision returned by a check. */
export type EntitlementVerdict = EntitlementAllowedVerdict | EntitlementDeniedVerdict;

/**
 * The outbox seam: what a denial emits.
 *
 * The default is {@link emitDomainEvent}; a unit spec injects its own so it can
 * observe the denial path without booting the outbox.
 */
export type EntitlementEventEmitter = (input: DomainEventInput) => Promise<EmitDomainEventResult>;

/** Seams for {@link checkEntitlement}. */
export interface EntitlementCheckOptions {
  /** The database handle; defaults to the shared client. */
  readonly db?: Db;
  /** The clock that resolves the period and grant windows. */
  readonly clock?: Clock;
  /** The caller's transaction; every read joins it when supplied. */
  readonly session?: ClientSession;
}

/** Seams for {@link consumeEntitlement}. */
export interface EntitlementConsumeOptions {
  /** The database handle; defaults to the shared client. */
  readonly db?: Db;
  /** The clock that resolves the period and grant windows. */
  readonly clock?: Clock;
  /** The outbox emitter; defaults to {@link emitDomainEvent}. */
  readonly emit?: EntitlementEventEmitter;
}

/** Seams for {@link releaseEntitlement}. */
export interface EntitlementReleaseOptions {
  /** The database handle; defaults to the shared client. */
  readonly db?: Db;
  /** The clock that stamps the counter update. */
  readonly clock?: Clock;
}
