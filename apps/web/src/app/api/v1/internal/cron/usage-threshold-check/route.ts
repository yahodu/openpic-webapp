import { runBillingCronRoute } from "../_lib/run-billing-cron-route";

import { usageThresholdCheckJob } from "@/server/jobs/usage-threshold-check";

/**
 * `POST /api/v1/internal/cron/usage-threshold-check` — warn once per crossed allowance threshold per period (OP-136, contract §10.2 `usage-threshold-check`, ADR-0849).
 *
 * Guarded by the internal HMAC stage: the scheduler's `CRON_SECRET` bearer (or a
 * signed `INTERNAL_API_SECRET` request) runs the bounded job and returns its
 * §10.2 `CronResult`.
 */
const ROUTE = "/api/v1/internal/cron/usage-threshold-check";

/** Run the usage-threshold-check job behind the internal guard. */
export function POST(request: Request): Promise<Response> {
  return runBillingCronRoute(request, ROUTE, usageThresholdCheckJob);
}
