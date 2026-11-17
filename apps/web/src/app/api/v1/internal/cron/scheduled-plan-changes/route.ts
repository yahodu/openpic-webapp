import { runBillingCronRoute } from "../_lib/run-billing-cron-route";

import { scheduledPlanChangesJob } from "@/server/billing/billing-cron-jobs";

/**
 * `POST /api/v1/internal/cron/scheduled-plan-changes` — apply and clear the scheduled plan changes whose effective instant has passed (OP-111, contract §10.2 `scheduled-plan-changes`, ADR-0500).
 *
 * Guarded by the internal HMAC stage: the scheduler's `CRON_SECRET` bearer (or a
 * signed `INTERNAL_API_SECRET` request) runs the bounded job and returns its
 * §10.2 `CronResult`.
 */
const ROUTE = "/api/v1/internal/cron/scheduled-plan-changes";

/** Run the scheduled-plan-changes job behind the internal guard. */
export function POST(request: Request): Promise<Response> {
  return runBillingCronRoute(request, ROUTE, scheduledPlanChangesJob);
}
