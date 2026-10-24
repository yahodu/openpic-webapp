/**
 * The generic entitlement service barrel (OP-103, schema §14.2, contract §0.14).
 *
 * The route layer imports only from `@/server/services/entitlements`; the pure
 * limit arithmetic lives in `./policy` and the decision/enforcement surface in
 * `./service`.
 */

export { effectiveLimit, periodKey } from "./policy";
export { checkEntitlement, consumeEntitlement, releaseEntitlement } from "./service";

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
