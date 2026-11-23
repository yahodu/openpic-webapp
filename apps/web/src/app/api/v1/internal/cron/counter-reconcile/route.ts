import { runBillingCronRoute } from "../_lib/run-billing-cron-route";

import { counterReconcileJob } from "@/server/jobs/counter-reconcile";

/**
 * `POST /api/v1/internal/cron/counter-reconcile` — recompute the cached counters from source (OP-139, contract §10.2 `counter-reconcile`, ADR-0919).
 *
 * Guarded by the internal HMAC stage: the scheduler's `CRON_SECRET` bearer (or a
 * signed `INTERNAL_API_SECRET` request) runs the bounded job and returns its
 * §10.2 `CronResult`.
 */
const ROUTE = "/api/v1/internal/cron/counter-reconcile";

/** Run the counter-reconcile job behind the internal guard. */
export function POST(request: Request): Promise<Response> {
  return runBillingCronRoute(request, ROUTE, counterReconcileJob);
}
