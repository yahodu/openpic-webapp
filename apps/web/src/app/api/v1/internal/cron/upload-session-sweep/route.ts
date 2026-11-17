import { runBillingCronRoute } from "../_lib/run-billing-cron-route";

import { uploadSessionSweepJob } from "@/server/jobs/upload-session-sweep";

/**
 * `POST /api/v1/internal/cron/upload-session-sweep` — announce the upload sessions idle for a day (OP-136, contract §10.2 `upload-session-sweep`, ADR-0849).
 *
 * Guarded by the internal HMAC stage: the scheduler's `CRON_SECRET` bearer (or a
 * signed `INTERNAL_API_SECRET` request) runs the bounded job and returns its
 * §10.2 `CronResult`.
 */
const ROUTE = "/api/v1/internal/cron/upload-session-sweep";

/** Run the upload-session-sweep job behind the internal guard. */
export function POST(request: Request): Promise<Response> {
  return runBillingCronRoute(request, ROUTE, uploadSessionSweepJob);
}
