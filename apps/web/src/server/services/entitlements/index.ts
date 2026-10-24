/**
 * The generic entitlement service barrel (OP-103, schema §14.2, contract §0.14).
 *
 * The route layer imports only from `@/server/services/entitlements`; the pure
 * limit arithmetic lives in `./policy`, the decision/enforcement surface in
 * `./service`, and the advisory read view (OP-104, contract §3.5) in
 * `./read-model` + `./view`.
 */

export { effectiveLimit, periodKey } from "./policy";
export { checkEntitlement, consumeEntitlement, releaseEntitlement } from "./service";

export { blockReasonFor, resetsAtFor } from "./read-model";
export {
  entitlementsSchema,
  entitlementStateSchema,
  readEntitlementsView,
  readUsageCounters,
  usageCountersSchema,
} from "./view";

export type { BlockReason, EntitlementQuota, SubscriptionStatus } from "./read-model";
export type { EntitlementsBody, EntitlementState, UsageCountersBody } from "./view";

export type {
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
  ResetPeriod,
} from "./types";
