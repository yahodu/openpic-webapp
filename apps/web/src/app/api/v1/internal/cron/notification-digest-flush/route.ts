import { runNotificationCronRoute } from "../_lib/run-cron-route";

import { digestFlushJob } from "@/server/services/notification-cron-jobs";

/**
 * `GET`/`POST /api/v1/internal/cron/notification-digest-flush` — drain due
 * digest buckets (OP-96, contract §10.2, ADR-0100).
 *
 * Guarded by the internal HMAC stage; a `CRON_SECRET` bearer (Vercel Cron) or a
 * signed POST runs the bounded job and returns its §10.2 `CronResult`.
 */
const ROUTE = "/api/v1/internal/cron/notification-digest-flush";

/** Run the digest flush job behind the internal guard. */
export function GET(request: Request): Promise<Response> {
  return runNotificationCronRoute(request, ROUTE, digestFlushJob);
}

/** Run the digest flush job behind the internal guard (signed trigger). */
export function POST(request: Request): Promise<Response> {
  return runNotificationCronRoute(request, ROUTE, digestFlushJob);
}
