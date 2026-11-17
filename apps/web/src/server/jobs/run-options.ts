import type { Db } from "mongodb";

import type { Logger } from "@/server/logging";
import type { Clock } from "@/server/runtime/clock";

/**
 * The seam every OP-136 sweep accepts (contract §10.2; ADR-0849).
 *
 * A sweep resolves its own collaborators from this seam — the shared database
 * and wall clock in production, a suite's private database and `fixedClock` in
 * the tests. `limit` is already clamped by `defineCronJob`, so a sweep never
 * reads `?limit=` itself.
 */
export interface SweepJobRunOptions {
  /** The database handle. */
  readonly db: Db;
  /** The clock every window is evaluated at. */
  readonly clock: Clock;
  /** The logger the run's per-step evidence is written through. */
  readonly logger: Logger;
  /** The maximum number of candidates this invocation may examine. */
  readonly limit: number;
}
