import { runBillingCronRoute } from "../_lib/run-billing-cron-route";

import { eventWindowSweepJob } from "@/server/jobs/event-window-sweep";

/**
 * `POST /api/v1/internal/cron/event-window-sweep` — announce the upload-window and lifecycle deadlines and follow the event clock (OP-136, contract §10.2 `event-window-sweep`, ADR-0849).
 *
 * Guarded by the internal HMAC stage: the scheduler's `CRON_SECRET` bearer (or a
 * signed `INTERNAL_API_SECRET` request) runs the bounded job and returns its
 * §10.2 `CronResult`.
 */
const ROUTE = "/api/v1/internal/cron/event-window-sweep";

/** Run the event-window-sweep job behind the internal guard. */
export function POST(request: Request): Promise<Response> {
  return runBillingCronRoute(request, ROUTE, eventWindowSweepJob);
}
