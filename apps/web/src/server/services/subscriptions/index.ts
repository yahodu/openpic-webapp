/**
 * The subscription service barrel (OP-106, contract §3.2, schema §14.3).
 *
 * The route layer imports only from `@/server/services/subscriptions`; the pure
 * banner/actions builders, the `daysRemaining` arithmetic, the served schemas
 * and the two reads all live in `./view`.
 */

export {
  buildSubscriptionActions,
  buildSubscriptionBanner,
  daysRemaining,
  mandateStatusSchema,
  readSubscriptionHistory,
  readSubscriptionView,
  REASSURANCE_COPY,
  statusHistoryEntrySchema,
  subscriptionActionsSchema,
  subscriptionBannerSchema,
  subscriptionHistorySchema,
  subscriptionStatusSchema,
  subscriptionViewFactsSchema,
  subscriptionViewSchema,
} from "./view";

export {
  checkoutEnvelopeSchema,
  checkoutPaymentMethodKindSchema,
  checkoutRequestSchema,
  decideExistingSubscription,
  isAllowedReturnUrl,
} from "./checkout";

export type {
  CheckoutEnvelope,
  CheckoutRequest,
  ExistingCheckout,
  ExistingSubscriptionDecision,
  ExistingSubscriptionFacts,
} from "./checkout";

export {
  comparePlanTiers,
  computeDowngradeConsequences,
  downgradeRequestSchema,
  downgradeResponseSchema,
  scheduledChangeSchema,
  upgradeEnvelopeSchema,
  upgradeRequestSchema,
} from "./plan-change";

export { CONTACT_SALES_URL, loadPlan, soldPrice, unsoldField } from "./catalogue";
export type { SoldPrice } from "./catalogue";

export { decideRetryEligibility, retryChargeResponseSchema } from "./retry-charge";
export type { RetryChargeResponse, RetryEligibility, RetryEligibilityInput } from "./retry-charge";

export { servedTransactionSchema, toTransactionDto, transactionPageSchema } from "./transactions";
export type {
  ServedPeriodCovered,
  ServedTransaction,
  ServedTransactionFailure,
  StoredTransactionId,
  StoredTransactionRow,
  TransactionPage,
} from "./transactions";

export { resolveMandateCustomer } from "./mandate-customer";

export type {
  DowngradeConsequence,
  DowngradeConsequencesInput,
  DowngradeRequest,
  DowngradeResponse,
  EntitlementUsageFact,
  PlanChangeDirection,
  UpgradeEnvelope,
  UpgradeRequest,
} from "./plan-change";

export type {
  MandateStatus,
  StatusHistoryEntry,
  SubscriptionActionRole,
  SubscriptionActions,
  SubscriptionActionsInput,
  SubscriptionBanner,
  SubscriptionBannerKind,
  SubscriptionBannerSeverity,
  SubscriptionFacts,
  SubscriptionStatus,
  SubscriptionView,
  SubscriptionViewFacts,
} from "./view";
