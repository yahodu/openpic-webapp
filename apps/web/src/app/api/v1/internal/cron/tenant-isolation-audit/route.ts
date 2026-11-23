import { runBillingCronRoute } from "../_lib/run-billing-cron-route";

import { tenantIsolationAuditJob } from "@/server/jobs/tenant-isolation-audit";

/**
 * `POST /api/v1/internal/cron/tenant-isolation-audit` — sweep every tenant-scoped collection for escaped rows (OP-139, contract §10.2 `tenant-isolation-audit`, ADR-0919).
 *
 * Guarded by the internal HMAC stage: the scheduler's `CRON_SECRET` bearer (or a
 * signed `INTERNAL_API_SECRET` request) runs the bounded job and returns its
 * §10.2 `CronResult`.
 */
const ROUTE = "/api/v1/internal/cron/tenant-isolation-audit";

/** Run the tenant-isolation-audit job behind the internal guard. */
export function POST(request: Request): Promise<Response> {
  return runBillingCronRoute(request, ROUTE, tenantIsolationAuditJob);
}
