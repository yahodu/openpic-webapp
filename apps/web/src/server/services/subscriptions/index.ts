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
