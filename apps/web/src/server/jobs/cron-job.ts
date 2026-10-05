import { z } from "zod";

import { isoDateTimeSchema } from "@openpic/contracts";

import type { Logger } from "@/server/logging";
import type { Clock } from "@/server/runtime/clock";

/**
 * The bounded cron job framework (OP-87, contract §10.2, ADR-0028 §1).
 *
 * Every `/api/v1/internal/cron/**` job is idempotent, concurrency-safe, bounded
 * and observable. This module owns the structural half of that contract: a job
 * declares its name and limit bounds once, and {@link defineCronJob} wraps every
 * run in the §10.2 `CronResult` envelope, times it through the injected
 * {@link Clock} (never the wall clock) and emits exactly one
 * `cron.<name>.completed` summary line.
 *
 * The framework holds no notification dependency: a job writes `domainEvents`
 * and the fan-out consumer delivers (the `src/server/jobs/**` import boundary
 * enforces that).
 */

/** The §10.2 result shape every job run resolves to. */
export const cronResultSchema = z.object({
  /** The job name, matching its `defineCronJob` declaration. */
  job: z.string().min(1),
  /** When the run started, from the injected clock. */
  startedAt: isoDateTimeSchema,
  /** When the run finished, from the injected clock. */
  finishedAt: isoDateTimeSchema,
  /** `finishedAt - startedAt`, in milliseconds. */
  durationMs: z.number().int().nonnegative(),
  /** How many records the job examined. */
  scanned: z.number().int().nonnegative(),
  /** How many records the job changed. */
  affected: z.number().int().nonnegative(),
  /** How many records the job deliberately left alone. */
  skipped: z.number().int().nonnegative(),
  /** How many per-record failures the job swallowed. */
  errors: z.number().int().nonnegative(),
  /** Whether the scheduler should invoke again to drain the backlog. */
  hasMore: z.boolean(),
  /** Optional job-specific counters. */
  details: z.record(z.string(), z.unknown()).optional(),
});

/** The §10.2 result every job run resolves to. */
export type CronResult = z.infer<typeof cronResultSchema>;

/** The outcome a job's business logic returns. */
export interface CronRunOutcome {
  readonly scanned: number;
  readonly affected: number;
  readonly skipped: number;
  readonly errors: number;
  readonly hasMore: boolean;
  readonly details?: Record<string, unknown>;
}

/** The context handed to a job's `run`. */
export interface CronJobContext {
  /** The resolved, clamped per-invocation work limit. */
  readonly limit: number;
  /** The injected clock (jobs must never read the wall clock). */
  readonly clock: Clock;
  /** The logger the job may use for its own per-record diagnostics. */
  readonly logger: Logger;
}

/** Options accepted by {@link CronJob.run}. */
export interface CronRunOptions {
  /** The raw `?limit=` value; absent/invalid/`<= 0` falls back to `defaultLimit`. */
  readonly requestedLimit?: string | number | null;
  /** The injected clock the run is timed with. */
  readonly clock: Clock;
  /** The logger the summary line is emitted through. */
  readonly logger: Logger;
}

/** A job declaration accepted by {@link defineCronJob}. */
export interface CronJobDefinition {
  /** The job name, used in the result and the summary event. */
  readonly name: string;
  /** The limit used when `?limit=` is absent or invalid. */
  readonly defaultLimit: number;
  /** The upper bound `?limit=` is clamped to. */
  readonly maxLimit: number;
  /** The business logic. */
  readonly run: (ctx: CronJobContext) => Promise<CronRunOutcome>;
}

/** A runnable, bounded, observable cron job. */
export interface CronJob {
  readonly name: string;
  readonly defaultLimit: number;
  readonly maxLimit: number;
  /** Run the job once, returning the §10.2 envelope. */
  run(options: CronRunOptions): Promise<CronResult>;
}

/** The per-job limit bounds {@link clampLimit} resolves against. */
export interface LimitBounds {
  readonly defaultLimit: number;
  readonly maxLimit: number;
}

/**
 * Resolve a requested `?limit=` to a positive, bounded work limit.
 *
 * Absent, empty, non-numeric or `<= 0` values fall back to `defaultLimit`; a
 * larger value is clamped to `maxLimit`; a fractional value is truncated.
 *
 * @param requested - The raw query value.
 * @param bounds - The job's default and maximum.
 * @returns A limit in `1..maxLimit` (or `defaultLimit` for a bad/missing value).
 * @example
 * clampLimit("9999", { defaultLimit: 500, maxLimit: 2000 }); // 2000
 */
export function clampLimit(
  requested: string | number | null | undefined,
  bounds: LimitBounds
): number {
  if (requested === null || requested === undefined || requested === "") {
    return bounds.defaultLimit;
  }

  const parsed = typeof requested === "number" ? requested : Number(requested);
  if (!Number.isFinite(parsed)) {
    return bounds.defaultLimit;
  }

  const limit = Math.trunc(parsed);
  if (limit <= 0) {
    return bounds.defaultLimit;
  }

  return Math.min(limit, bounds.maxLimit);
}

/**
 * Declare a cron job on the bounded framework.
 *
 * @param definition - Name, limit bounds and the business `run`.
 * @returns A {@link CronJob} whose `run` returns the §10.2 `CronResult` and logs
 *   one `cron.<name>.completed` summary (`error` when the run reported errors).
 */
export function defineCronJob(definition: CronJobDefinition): CronJob {
  return {
    name: definition.name,
    defaultLimit: definition.defaultLimit,
    maxLimit: definition.maxLimit,

    async run(options: CronRunOptions): Promise<CronResult> {
      const limit = clampLimit(options.requestedLimit, {
        defaultLimit: definition.defaultLimit,
        maxLimit: definition.maxLimit,
      });

      const startedAt = options.clock.now();
      const outcome = await definition.run({ limit, clock: options.clock, logger: options.logger });
      const finishedAt = options.clock.now();
      const durationMs = finishedAt.getTime() - startedAt.getTime();

      const result = cronResultSchema.parse({
        job: definition.name,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs,
        scanned: outcome.scanned,
        affected: outcome.affected,
        skipped: outcome.skipped,
        errors: outcome.errors,
        hasMore: outcome.hasMore,
        ...(outcome.details === undefined ? {} : { details: outcome.details }),
      });

      const fields = {
        event: `cron.${definition.name}.completed`,
        job: definition.name,
        scanned: result.scanned,
        affected: result.affected,
        skipped: result.skipped,
        errors: result.errors,
        hasMore: result.hasMore,
        durationMs: result.durationMs,
      };
      if (result.errors > 0) {
        options.logger.error("cron job completed with errors", fields);
      } else {
        options.logger.info("cron job completed", fields);
      }

      return result;
    },
  };
}
