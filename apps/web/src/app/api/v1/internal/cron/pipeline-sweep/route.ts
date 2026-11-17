import { runBillingCronRoute } from "../_lib/run-billing-cron-route";

import { pipelineSweepJob } from "@/server/jobs/pipeline-sweep";

/**
 * `POST /api/v1/internal/cron/pipeline-sweep` — requeue expired leases and unanswered work, fail the spent attempt budget and enqueue the incremental match run (OP-136, contract §10.2 `pipeline-sweep`, ADR-0849).
 *
 * Guarded by the internal HMAC stage: the scheduler's `CRON_SECRET` bearer (or a
 * signed `INTERNAL_API_SECRET` request) runs the bounded job and returns its
 * §10.2 `CronResult`.
 */
const ROUTE = "/api/v1/internal/cron/pipeline-sweep";

/** Run the pipeline-sweep job behind the internal guard. */
export function POST(request: Request): Promise<Response> {
  return runBillingCronRoute(request, ROUTE, pipelineSweepJob);
}
