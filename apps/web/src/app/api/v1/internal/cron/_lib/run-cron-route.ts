/**
 * Shared plumbing for the notification cron routes (OP-96, contract §10.2).
 *
 * Mirrors the shipped `cron/sample/route.ts` wiring so each notification route
 * is a one-liner: the internal HMAC stage guards the request, the bounded job
 * runs through {@link defineCronJob} and the §10.2 `CronResult` is serialized
 * through `defineRoute`. The secrets are read through a thunk so
 * `next build`'s page-data collection (which runs without a configured
 * environment) never evaluates `getConfig()` at module scope.
 */
import { internalAuthStage } from "@/server/auth/internal-hmac";
import { getConfig } from "@/server/config/env";
import { defineRoute } from "@/server/http/define-route";
import { cronResultSchema, type CronJob } from "@/server/jobs/cron-job";
import { getLogger } from "@/server/logging";
import { systemClock } from "@/server/runtime/clock";

/**
 * Run one notification cron job behind the internal guard.
 *
 * @param request - The inbound request (its `?limit=` is honoured and clamped).
 * @param route - The matched route template, used for logging/context.
 * @param job - The bounded job to run.
 * @returns The HTTP response carrying the §10.2 `CronResult`.
 */
export function runNotificationCronRoute(
  request: Request,
  route: string,
  job: CronJob
): Promise<Response> {
  const requestedLimit = new URL(request.url).searchParams.get("limit");

  return defineRoute({
    route,
    response: cronResultSchema,
    auth: (ctx, req) =>
      internalAuthStage({
        internalApiSecret: getConfig().internal.apiSecret,
        cronSecret: getConfig().cron.secret,
      })(ctx, req),
    handler: async () => {
      const result = await job.run({ requestedLimit, clock: systemClock, logger: getLogger() });
      return { body: result };
    },
  })(request);
}
