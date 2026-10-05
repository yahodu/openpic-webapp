import { internalAuthStage } from "@/server/auth/internal-hmac";
import { getConfig } from "@/server/config/env";
import { defineRoute } from "@/server/http/define-route";
import { cronResultSchema, defineCronJob } from "@/server/jobs/cron-job";
import { getLogger } from "@/server/logging";
import { systemClock } from "@/server/runtime/clock";

/**
 * `GET`/`POST /api/v1/internal/cron/sample` — the cron framework's
 * proving-ground (OP-87, contract §10.2, ADR-0028 §4).
 *
 * The internal HMAC stage guards the route; a signed `POST` runs the sample job
 * (which does no work) and returns its §10.2 `CronResult`. Vercel Cron invokes
 * the `GET` with the `CRON_SECRET` bearer. Real domain jobs land in their own
 * stories and extend the same {@link defineCronJob} call.
 */

const ROUTE = "/api/v1/internal/cron/sample";

/** The proving-ground job: bounded, observable and inert. */
const sampleJob = defineCronJob({
  name: "sample",
  defaultLimit: 500,
  maxLimit: 2000,
  run: () =>
    Promise.resolve({
      scanned: 0,
      affected: 0,
      skipped: 0,
      errors: 0,
      hasMore: false,
    }),
});

/**
 * Build the route for one request so `?limit=` (and only it) varies per call.
 *
 * The auth stage reads its secrets through a thunk: `getConfig()` validates the
 * environment, so evaluating it at module scope would fail `next build`'s
 * page-data collection (which runs without a configured environment).
 */
function buildSampleRoute(requestedLimit: string | null) {
  return defineRoute({
    route: ROUTE,
    response: cronResultSchema,
    auth: (ctx, request) =>
      internalAuthStage({
        internalApiSecret: getConfig().internal.apiSecret,
        cronSecret: getConfig().cron.secret,
      })(ctx, request),
    handler: async () => {
      const result = await sampleJob.run({
        requestedLimit,
        clock: systemClock,
        logger: getLogger(),
      });
      return { body: result };
    },
  });
}

/** Run the sample job behind the internal guard. */
export function GET(request: Request): Promise<Response> {
  return buildSampleRoute(new URL(request.url).searchParams.get("limit"))(request);
}

/** Run the sample job behind the internal guard (signed manual/QStash trigger). */
export function POST(request: Request): Promise<Response> {
  return buildSampleRoute(new URL(request.url).searchParams.get("limit"))(request);
}
