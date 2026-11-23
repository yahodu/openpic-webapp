import { runBillingCronRoute } from "../_lib/run-billing-cron-route";

import { dsrSlaCheckJob } from "@/server/jobs/dsr-sla-check";

/**
 * `POST /api/v1/internal/cron/dsr-sla-check` — warn before a data-subject request's statutory deadline runs out (OP-139, contract §10.2 `dsr-sla-check`, ADR-0919).
 *
 * Guarded by the internal HMAC stage: the scheduler's `CRON_SECRET` bearer (or a
 * signed `INTERNAL_API_SECRET` request) runs the bounded job and returns its
 * §10.2 `CronResult`.
 */
const ROUTE = "/api/v1/internal/cron/dsr-sla-check";

/** Run the dsr-sla-check job behind the internal guard. */
export function POST(request: Request): Promise<Response> {
  return runBillingCronRoute(request, ROUTE, dsrSlaCheckJob);
}
