import { runBillingCronRoute } from "../_lib/run-billing-cron-route";

import { dunningRemindersJob } from "@/server/billing/billing-cron-jobs";

/**
 * `POST /api/v1/internal/cron/dunning-reminders` — send the grace-day reminders named by `platformSettings.dunning.reminderDays` (OP-111, contract §10.2 `dunning-reminders`, ADR-0500).
 *
 * Guarded by the internal HMAC stage: the scheduler's `CRON_SECRET` bearer (or a
 * signed `INTERNAL_API_SECRET` request) runs the bounded job and returns its
 * §10.2 `CronResult`.
 */
const ROUTE = "/api/v1/internal/cron/dunning-reminders";

/** Run the dunning-reminders job behind the internal guard. */
export function POST(request: Request): Promise<Response> {
  return runBillingCronRoute(request, ROUTE, dunningRemindersJob);
}
