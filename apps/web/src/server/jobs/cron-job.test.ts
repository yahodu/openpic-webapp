import { describe, expect, it } from "vitest";
import { z } from "zod";

import { isoDateTimeSchema } from "@openpic/contracts";

import { createLogger, memoryTransport } from "@/server/logging";
import { fixedClock } from "@/server/runtime/clock";

import {
  clampLimit,
  defineCronJob,
  type CronJobContext,
  type CronRunOutcome,
} from "@/server/jobs/cron-job";

/**
 * Unit — the bounded cron job framework (OP-87, contract §10.2).
 *
 * `defineCronJob` wraps a job's `run(ctx)` in the observable `CronResult`
 * envelope: it resolves the `?limit` (clamped to `maxLimit`), times the run
 * through the injected `Clock` (never the wall clock) and logs one
 * `cron.<name>.completed` summary line at `info` — or `error` when the run
 * reported errors.
 *
 * Contract expected of the implementation:
 *
 *   - `@/server/jobs/cron-job` exports `defineCronJob(definition) -> CronJob`,
 *     `clampLimit(requested, { defaultLimit, maxLimit }) -> number`, and the
 *     `CronJobContext`/`CronRunOutcome` types.
 *   - `CronJob.run({ requestedLimit?, clock, logger }) -> Promise<CronResult>`
 *     where `CronResult` is the §10.2 body
 *     `{ job, startedAt, finishedAt, durationMs, scanned, affected, skipped, errors, hasMore, details? }`.
 *   - `CronJobContext` is `{ limit, clock, logger }`.
 */

/** The §10.2 `CronResult` body, asserted structurally so the shape cannot drift. */
const CronResultSchema = z.object({
  job: z.string().min(1),
  startedAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema,
  durationMs: z.number().int().nonnegative(),
  scanned: z.number().int().nonnegative(),
  affected: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const START = new Date("2026-03-04T05:06:07.000Z");

/** A logger that records into a memory transport the test can read back. */
function testLogger() {
  const transport = memoryTransport();
  const logger = createLogger({
    level: "info",
    transports: [transport],
    service: "openpic-web",
    env: "test",
  });
  return { transport, logger };
}

/** Build a job whose outcome is fixed and whose `ctx` is captured for assertions. */
function makeJob(options: {
  readonly name?: string;
  readonly outcome: CronRunOutcome;
  readonly seen?: CronJobContext[];
}) {
  return defineCronJob({
    name: options.name ?? "sample",
    defaultLimit: 500,
    maxLimit: 2000,
    run: (ctx) => {
      options.seen?.push(ctx);
      return Promise.resolve(options.outcome);
    },
  });
}

describe("cron job result envelope (U5)", () => {
  it("U5: computes startedAt/finishedAt/durationMs from the injected Clock", async () => {
    const { logger } = testLogger();
    const outcome: CronRunOutcome = {
      scanned: 10,
      affected: 2,
      skipped: 8,
      errors: 0,
      hasMore: false,
    };
    const job = makeJob({ outcome });

    const result = await job.run({
      requestedLimit: "10",
      clock: fixedClock(START, 1840),
      logger,
    });

    expect(CronResultSchema.parse(result)).toEqual(result);
    expect(result.startedAt).toBe(START.toISOString());
    expect(result.finishedAt).toBe(new Date(START.getTime() + 1840).toISOString());
    expect(result.durationMs).toBe(1840);
  });

  it("U5: carries the job name and every §10.2 count through unchanged", async () => {
    const { logger } = testLogger();
    const job = makeJob({
      name: "dunning",
      outcome: {
        scanned: 412,
        affected: 7,
        skipped: 405,
        errors: 0,
        hasMore: true,
        details: { downgraded: 7 },
      },
    });

    const result = await job.run({ clock: fixedClock(START), logger });

    expect(result).toMatchObject({
      job: "dunning",
      scanned: 412,
      affected: 7,
      skipped: 405,
      errors: 0,
      hasMore: true,
      details: { downgraded: 7 },
    });
  });

  it("U5: hands the clamped limit to the job context", async () => {
    const { logger } = testLogger();
    const seen: CronJobContext[] = [];
    const job = makeJob({
      outcome: { scanned: 0, affected: 0, skipped: 0, errors: 0, hasMore: false },
      seen,
    });

    await job.run({ requestedLimit: "9999", clock: fixedClock(START), logger });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.limit).toBe(2000);
  });

  it("U5: logs cron.<name>.completed at info with the summary counts", async () => {
    const { transport, logger } = testLogger();
    const job = makeJob({
      name: "sample",
      outcome: { scanned: 5, affected: 3, skipped: 2, errors: 0, hasMore: false },
    });

    await job.run({ clock: fixedClock(START, 500), logger });

    const entry = transport.entries.find(
      (candidate) => candidate.event === "cron.sample.completed"
    );
    expect(entry).toBeDefined();
    expect(entry?.level).toBe("info");
    expect(entry).toMatchObject({
      job: "sample",
      scanned: 5,
      affected: 3,
      skipped: 2,
      errors: 0,
      hasMore: false,
      durationMs: 500,
    });
  });

  it("U5: logs the summary at error when the run reported errors", async () => {
    const { transport, logger } = testLogger();
    const job = makeJob({
      name: "sample",
      outcome: { scanned: 5, affected: 1, skipped: 2, errors: 2, hasMore: false },
    });

    await job.run({ clock: fixedClock(START), logger });

    const entry = transport.entries.find(
      (candidate) => candidate.event === "cron.sample.completed"
    );
    expect(entry).toBeDefined();
    expect(entry?.level).toBe("error");
    expect(entry?.errors).toBe(2);
  });
});

describe("limit clamping (U6)", () => {
  const bounds = { defaultLimit: 500, maxLimit: 2000 };

  it.each<[string | number | null | undefined, number]>([
    [undefined, 500],
    [null, 500],
    ["", 500],
    ["not-a-number", 500],
    ["0", 500],
    ["-3", 500],
    ["1", 1],
    ["500", 500],
    ["1999", 1999],
    ["2000", 2000],
    ["2001", 2000],
    ["2.9", 2],
  ])("U6: clampLimit(%j, bounds) is %i", (requested, expected) => {
    expect(clampLimit(requested, bounds)).toBe(expected);
  });
});
