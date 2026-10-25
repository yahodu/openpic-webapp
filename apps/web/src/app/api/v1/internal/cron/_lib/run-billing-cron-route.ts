import { internalAuthStage } from "@/server/auth/internal-hmac";
import { getConfig } from "@/server/config/env";
import { defineRoute } from "@/server/http/define-route";
import { cronResultSchema, type CronJob } from "@/server/jobs/cron-job";
import { getLogger } from "@/server/logging";
import { systemClock } from "@/server/runtime/clock";

/**
 * Shared plumbing for the billing cron routes (OP-111, contract §10.2, ADR-0500).
 *
 * Mirrors the shipped `_lib/run-cron-route.ts` wiring so each billing route is a
 * one-liner: the internal HMAC stage guards the request, the bounded job runs
 * through {@link defineCronJob} and the §10.2 `CronResult` is serialized through
 * `defineRoute`. The secrets are read through a thunk so `next build`'s
 * page-data collection (which runs without a configured environment) never
 * evaluates `getConfig()` at module scope.
 *
 * The one deliberate difference from the notification wiring is
 * `cronBearerAnyMethod`: §10.2's table spells these crons as `POST` and
 * `docs/Subscription flow.md` §4.3 describes them as *"invoked by your
 * scheduler (Vercel Cron / a hosted cron pinging with a secret header)"*, so the
 * scheduler's `CRON_SECRET` bearer is accepted for a `POST` under the cron
 * prefix as well as the Vercel-Cron `GET` (ADR-0500 §"Route wiring"). The
 * shipped default — a non-GET cron request needs `INTERNAL_API_SECRET` plus a
 * valid HMAC — is unchanged everywhere else.
 */

/**
 * Run one billing cron job behind the internal guard.
 *
 * @param request - The inbound request (its `?limit=` is honoured and clamped).
 * @param route - The matched route template, used for logging/context.
 * @param job - The bounded job to run.
 * @returns The HTTP response carrying the §10.2 `CronResult`.
 */
export function runBillingCronRoute(
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
        cronBearerAnyMethod: true,
      })(ctx, req),
    handler: async () => {
      const result = await job.run({ requestedLimit, clock: systemClock, logger: getLogger() });
      return { body: result };
    },
  })(request);
}
