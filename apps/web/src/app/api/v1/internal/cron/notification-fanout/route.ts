import { internalAuthStage } from "@/server/auth/internal-hmac";
import { getConfig } from "@/server/config/env";
import { defineRoute } from "@/server/http/define-route";
import { cronResultSchema, defineCronJob } from "@/server/jobs/cron-job";
import { getLogger } from "@/server/logging";
import { runNotificationFanOut } from "@/server/notifications/fan-out";
import { toCronRunOutcome } from "@/server/notifications/fan-out-cron";
import { notificationRecipients } from "@/server/repos/notification-recipients";
import { systemClock } from "@/server/runtime/clock";
import { getNotificationTransport } from "@/server/services/notification-transport";

/**
 * `GET`/`POST /api/v1/internal/cron/notification-fanout` — the scheduled drain
 * of the notification outbox (OP-94 §1 follow-up, contract §10.2, ADR-0028,
 * ADR-0090, ADR-0106).
 *
 * OP-94 shipped the fan-out consumer (`@/server/notifications/fan-out`) but
 * de-scoped its two triggers. This is the scheduled half: it runs a bounded
 * `defineCronJob` that claims up to `?limit=` pending `domainEvents` rows for
 * the `notifications` consumer and projects the run summary onto the §10.2
 * `CronResult`. The opportunistic `after()` trigger in `emitDomainEvent`
 * delivers a fresh event without waiting for the next minute tick.
 *
 * The internal HMAC stage guards the route exactly like `sample/route.ts`:
 * Vercel Cron invokes the `GET` with the `CRON_SECRET` bearer, and a
 * manual/QStash trigger signs a `POST` with the `INTERNAL_API_SECRET`.
 */

const ROUTE = "/api/v1/internal/cron/notification-fanout";

/** The bounded outbox-drain job: `?limit=` is resolved per request. */
const notificationFanOutJob = defineCronJob({
  name: "notification-fanout",
  defaultLimit: 500,
  maxLimit: 2000,
  run: async (ctx) => {
    const summary = await runNotificationFanOut({
      transport: getNotificationTransport(),
      recipients: notificationRecipients,
      batch: ctx.limit,
      clock: ctx.clock,
      claimerId: "cron.notification-fanout",
    });
    return toCronRunOutcome(summary, ctx.limit);
  },
});

/**
 * Build the route for one request so `?limit=` (and only it) varies per call.
 *
 * The auth stage reads its secrets through a thunk: `getConfig()` validates the
 * environment, so evaluating it at module scope would fail `next build`'s
 * page-data collection (which runs without a configured environment).
 */
function buildNotificationFanOutRoute(requestedLimit: string | null) {
  return defineRoute({
    route: ROUTE,
    response: cronResultSchema,
    auth: (ctx, request) => {
      const config = getConfig();
      // The route has two credential legs (ADR-0106 §3): `GET` is the Vercel Cron
      // leg and accepts only the `CRON_SECRET` bearer, while `POST` is the
      // signed manual/QStash leg requiring `Bearer <INTERNAL_API_SECRET>` plus a
      // valid HMAC. Presenting the internal secret on the cron `GET` is a wrong
      // bearer for that leg, so both stage secrets are the cron secret there.
      const internalApiSecret =
        request.method === "GET" ? config.cron.secret : config.internal.apiSecret;
      return internalAuthStage({
        internalApiSecret,
        cronSecret: config.cron.secret,
      })(ctx, request);
    },
    handler: async () => {
      const result = await notificationFanOutJob.run({
        requestedLimit,
        clock: systemClock,
        logger: getLogger(),
      });
      return { body: result };
    },
  });
}

/** Drain the pending notification outbox behind the internal guard (Vercel Cron). */
export function GET(request: Request): Promise<Response> {
  return buildNotificationFanOutRoute(new URL(request.url).searchParams.get("limit"))(request);
}

/** Drain the pending notification outbox behind the internal guard (signed trigger). */
export function POST(request: Request): Promise<Response> {
  return buildNotificationFanOutRoute(new URL(request.url).searchParams.get("limit"))(request);
}
