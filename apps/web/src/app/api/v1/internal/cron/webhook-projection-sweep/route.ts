import { runBillingCronRoute } from "../_lib/run-billing-cron-route";

import { webhookProjectionSweepJob } from "@/server/billing/billing-cron-jobs";

/**
 * `POST /api/v1/internal/cron/webhook-projection-sweep` — re-project the inbox rows an earlier projection left unprocessed (OP-111, contract §10.2 `webhook-projection-sweep`, ADR-0500).
 *
 * Guarded by the internal HMAC stage: the scheduler's `CRON_SECRET` bearer (or a
 * signed `INTERNAL_API_SECRET` request) runs the bounded job and returns its
 * §10.2 `CronResult`.
 */
const ROUTE = "/api/v1/internal/cron/webhook-projection-sweep";

/** Run the webhook-projection-sweep job behind the internal guard. */
export function POST(request: Request): Promise<Response> {
  return runBillingCronRoute(request, ROUTE, webhookProjectionSweepJob);
}
