import { runBillingCronRoute } from "../_lib/run-billing-cron-route";

import { renewalRemindersJob } from "@/server/billing/billing-cron-jobs";

/**
 * `POST /api/v1/internal/cron/renewal-reminders` — send the upcoming-renewal reminder once per cycle (OP-111, contract §10.2 `renewal-reminders`, ADR-0500).
 *
 * Guarded by the internal HMAC stage: the scheduler's `CRON_SECRET` bearer (or a
 * signed `INTERNAL_API_SECRET` request) runs the bounded job and returns its
 * §10.2 `CronResult`.
 */
const ROUTE = "/api/v1/internal/cron/renewal-reminders";

/** Run the renewal-reminders job behind the internal guard. */
export function POST(request: Request): Promise<Response> {
  return runBillingCronRoute(request, ROUTE, renewalRemindersJob);
}
