import { runBillingCronRoute } from "../_lib/run-billing-cron-route";

import { retentionWarningsJob } from "@/server/jobs/retention-warnings";

/**
 * `POST /api/v1/internal/cron/retention-warnings` — warn both audiences before the retention deadline (OP-136, contract §10.2 `retention-warnings`, ADR-0849).
 *
 * Guarded by the internal HMAC stage: the scheduler's `CRON_SECRET` bearer (or a
 * signed `INTERNAL_API_SECRET` request) runs the bounded job and returns its
 * §10.2 `CronResult`.
 */
const ROUTE = "/api/v1/internal/cron/retention-warnings";

/** Run the retention-warnings job behind the internal guard. */
export function POST(request: Request): Promise<Response> {
  return runBillingCronRoute(request, ROUTE, retentionWarningsJob);
}
