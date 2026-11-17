import { runBillingCronRoute } from "../_lib/run-billing-cron-route";

import { invitationExpiryJob } from "@/server/jobs/invitation-expiry";

/**
 * `POST /api/v1/internal/cron/invitation-expiry` — expire past-deadline invitations and remind the ones that have waited (OP-136, contract §10.2 `invitation-expiry`, ADR-0849).
 *
 * Guarded by the internal HMAC stage: the scheduler's `CRON_SECRET` bearer (or a
 * signed `INTERNAL_API_SECRET` request) runs the bounded job and returns its
 * §10.2 `CronResult`.
 */
const ROUTE = "/api/v1/internal/cron/invitation-expiry";

/** Run the invitation-expiry job behind the internal guard. */
export function POST(request: Request): Promise<Response> {
  return runBillingCronRoute(request, ROUTE, invitationExpiryJob);
}
