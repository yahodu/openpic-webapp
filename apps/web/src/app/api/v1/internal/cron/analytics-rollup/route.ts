import { dateKeySchema, type FieldError } from "@openpic/contracts";

import { internalAuthStage } from "@/server/auth/internal-hmac";
import { getConfig } from "@/server/config/env";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { analyticsRollupJob } from "@/server/jobs/analytics-rollup";
import { cronResultSchema } from "@/server/jobs/cron-job";
import { getLogger } from "@/server/logging";
import { systemClock } from "@/server/runtime/clock";

/**
 * `POST /api/v1/internal/cron/analytics-rollup` — roll one IST day's activity into `analyticsDaily` (OP-139, contract §10.2 `analytics-rollup`, ADR-0919).
 *
 * Guarded by the internal HMAC stage: the scheduler's `CRON_SECRET` bearer (or a
 * signed `INTERNAL_API_SECRET` request) runs the bounded job and returns its
 * §10.2 `CronResult`. `?date=YYYY-MM-DD` re-runs any day; an invalid one is
 * refused `422 validation_failed` **before** the job writes anything.
 */
const ROUTE = "/api/v1/internal/cron/analytics-rollup";

/** The `details.fields` entry for a `?date=` that is not a calendar day key. */
const DATE_FIELD: FieldError = {
  path: "date",
  code: "invalid",
  message: "Must be a calendar date in YYYY-MM-DD form.",
};

/** Run the analytics-rollup job behind the internal guard, honouring `?date=`. */
export function POST(request: Request): Promise<Response> {
  return defineRoute({
    route: ROUTE,
    response: cronResultSchema,
    auth: (ctx, req) =>
      internalAuthStage({
        internalApiSecret: getConfig().internal.apiSecret,
        cronSecret: getConfig().cron.secret,
        cronBearerAnyMethod: true,
      })(ctx, req),
    handler: async () => {
      const params = new URL(request.url).searchParams;
      const date = params.get("date");
      if (date !== null && !dateKeySchema.safeParse(date).success) {
        throw appError("validation_failed", { details: { fields: [DATE_FIELD] } });
      }

      const result = await analyticsRollupJob.run({
        requestedLimit: params.get("limit"),
        clock: systemClock,
        logger: getLogger(),
        ...(date === null ? {} : { date }),
      });
      return { body: result };
    },
  })(request);
}
