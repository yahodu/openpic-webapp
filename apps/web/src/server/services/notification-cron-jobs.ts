/**
 * The three notification cron jobs (OP-96, contract §10.2, ADR-0100).
 *
 * The route handlers under `app/api/v1/internal/cron/**` may not import an
 * adapter directly (they depend on services, not adapters), so this module owns
 * the wiring of each notification job to its collaborators: the shared database
 * handle, the config-driven {@link getMessageTransport} and a bounded
 * {@link defineCronJob} declaration. Each job's business logic lives in its own
 * notification module (`digest`, `dispatch-retry`, `quiet-hours-release`).
 */
import { getMessageTransport } from "@/server/adapters/message-transport-provider";
import { getDb } from "@/server/db/mongo";
import { defineCronJob, type CronJob } from "@/server/jobs/cron-job";
import { flushDueDigests } from "@/server/notifications/digest";
import { retryDueDispatches } from "@/server/notifications/dispatch-retry";
import { releaseDeferredDispatches } from "@/server/notifications/quiet-hours-release";

/** `notification-digest-flush` — drain due digest buckets (default limit 1000). */
export const digestFlushJob: CronJob = defineCronJob({
  name: "notification-digest-flush",
  defaultLimit: 1000,
  maxLimit: 5000,
  run: ({ limit, clock }) =>
    flushDueDigests({ db: getDb(), clock, transport: getMessageTransport(), limit }),
});

/** `notification-dispatch-retry` — re-attempt failed-retryable dispatches (default limit 500). */
export const dispatchRetryJob: CronJob = defineCronJob({
  name: "notification-dispatch-retry",
  defaultLimit: 500,
  maxLimit: 2000,
  run: ({ limit, clock }) =>
    retryDueDispatches({ db: getDb(), clock, transport: getMessageTransport(), limit }),
});

/** `quiet-hours-release` — release deferred dispatches past their window (default limit 1000). */
export const quietHoursReleaseJob: CronJob = defineCronJob({
  name: "quiet-hours-release",
  defaultLimit: 1000,
  maxLimit: 5000,
  run: ({ limit, clock }) =>
    releaseDeferredDispatches({ db: getDb(), clock, transport: getMessageTransport(), limit }),
});
