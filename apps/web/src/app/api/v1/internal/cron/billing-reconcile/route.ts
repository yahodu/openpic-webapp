import { runBillingCronRoute } from "../_lib/run-billing-cron-route";

import { billingReconcileJob } from "@/server/billing/billing-cron-jobs";

/**
 * `POST /api/v1/internal/cron/billing-reconcile` — correct subscriptions stuck beyond the §10.2 window against the provider (OP-111, contract §10.2 `billing-reconcile`, ADR-0500).
 *
 * Guarded by the internal HMAC stage: the scheduler's `CRON_SECRET` bearer (or a
 * signed `INTERNAL_API_SECRET` request) runs the bounded job and returns its
 * §10.2 `CronResult`.
 */
const ROUTE = "/api/v1/internal/cron/billing-reconcile";

/** Run the billing-reconcile job behind the internal guard. */
export function POST(request: Request): Promise<Response> {
  return runBillingCronRoute(request, ROUTE, billingReconcileJob);
}
