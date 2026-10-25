import { getDb } from "@/server/db/mongo";
import { defineCronJob, type CronJob } from "@/server/jobs/cron-job";

import { runBillingReconcile } from "./jobs/billing-reconcile";
import { runDunning } from "./jobs/dunning";
import { runDunningReminders } from "./jobs/dunning-reminders";
import { runRenewalReminders } from "./jobs/renewal-reminders";
import { runScheduledPlanChanges } from "./jobs/scheduled-plan-changes";
import { runWebhookProjectionSweep } from "./jobs/webhook-projection-sweep";

/**
 * The six billing cron jobs (OP-111, contract §10.2, ADR-0500).
 *
 * The route handlers under `app/api/v1/internal/cron/**` may not import a
 * business module's internals directly, so this module owns the wiring of each
 * billing job to its collaborators: the shared database handle, the bounded
 * {@link defineCronJob} declaration (name, default and maximum limit) and the
 * job's own runner under `./jobs/**`. It mirrors the shipped
 * `@/server/services/notification-cron-jobs` shape.
 *
 * Every job's `run` closes over `getDb()` and forwards the framework's clamped
 * `limit` and injected clock, so the runners stay database- and
 * clock-injectable for the suites.
 */

/** `dunning` — downgrade past-grace subscriptions (default limit 500). */
export const dunningJob: CronJob = defineCronJob({
  name: "dunning",
  defaultLimit: 500,
  maxLimit: 2000,
  run: ({ limit, clock }) => runDunning({ db: getDb(), clock, limit }),
});

/** `dunning-reminders` — grace-day reminders (default limit 1000). */
export const dunningRemindersJob: CronJob = defineCronJob({
  name: "dunning-reminders",
  defaultLimit: 1000,
  maxLimit: 5000,
  run: ({ limit, clock }) => runDunningReminders({ db: getDb(), clock, limit }),
});

/** `renewal-reminders` — upcoming-renewal reminders (default limit 1000). */
export const renewalRemindersJob: CronJob = defineCronJob({
  name: "renewal-reminders",
  defaultLimit: 1000,
  maxLimit: 5000,
  run: ({ limit, clock }) => runRenewalReminders({ db: getDb(), clock, limit }),
});

/** `scheduled-plan-changes` — apply due scheduled changes (default limit 500). */
export const scheduledPlanChangesJob: CronJob = defineCronJob({
  name: "scheduled-plan-changes",
  defaultLimit: 500,
  maxLimit: 2000,
  run: ({ limit, clock }) => runScheduledPlanChanges({ db: getDb(), clock, limit }),
});

/** `billing-reconcile` — correct drift against the provider (default limit 200). */
export const billingReconcileJob: CronJob = defineCronJob({
  name: "billing-reconcile",
  defaultLimit: 200,
  maxLimit: 1000,
  run: ({ limit, clock }) => runBillingReconcile({ db: getDb(), clock, limit }),
});

/** `webhook-projection-sweep` — re-project unprocessed inbox rows (default limit 500). */
export const webhookProjectionSweepJob: CronJob = defineCronJob({
  name: "webhook-projection-sweep",
  defaultLimit: 500,
  maxLimit: 2000,
  run: ({ limit, clock }) => runWebhookProjectionSweep({ db: getDb(), clock, limit }),
});
