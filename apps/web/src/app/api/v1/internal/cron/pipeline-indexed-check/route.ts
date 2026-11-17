import { runBillingCronRoute } from "../_lib/run-billing-cron-route";

import { pipelineIndexedCheckJob } from "@/server/jobs/pipeline-indexed-check";

/**
 * `POST /api/v1/internal/cron/pipeline-indexed-check` — announce the events whose queued images all reached a terminal state (OP-136, contract §10.2 `pipeline-indexed-check`, ADR-0849).
 *
 * Guarded by the internal HMAC stage: the scheduler's `CRON_SECRET` bearer (or a
 * signed `INTERNAL_API_SECRET` request) runs the bounded job and returns its
 * §10.2 `CronResult`.
 */
const ROUTE = "/api/v1/internal/cron/pipeline-indexed-check";

/** Run the pipeline-indexed-check job behind the internal guard. */
export function POST(request: Request): Promise<Response> {
  return runBillingCronRoute(request, ROUTE, pipelineIndexedCheckJob);
}
