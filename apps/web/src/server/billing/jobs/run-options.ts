import type { Db } from "mongodb";

import type { Clock } from "@/server/runtime/clock";

/**
 * The seam every billing cron runner accepts (OP-111, contract §10.2; ADR-0500).
 *
 * A runner is deliberately database- and clock-injectable: the composition
 * module (`@/server/billing/billing-cron-jobs`) hands it the shared client and
 * the wall clock, while a spec hands it a private database and a
 * `fixedClock(now)` so every window (`gracePeriodEndsAt < now`, the 1 h
 * reconcile window, the 60 s projection grace) is evaluated deterministically.
 *
 * `limit` is the already-clamped per-invocation bound resolved by
 * `defineCronJob` — a runner never reads `?limit=` itself.
 */
export interface BillingJobRunOptions {
  /** The database handle; defaults to the shared client. */
  readonly db?: Db;
  /** The clock the run is evaluated at; defaults to the system clock. */
  readonly clock?: Clock;
  /** The maximum number of records this invocation may examine. */
  readonly limit: number;
}
