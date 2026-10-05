/**
 * Low-level readiness poll shared by the Mongo test harness (ADR-0037,
 * OP-85 follow-up).
 *
 * Both `test/helpers/db.ts` (`waitForMongoReady`) and
 * `test/integration/global-setup.ts` (`waitForPrimary`) need the same
 * "retry a real ping until it answers, then fail loudly" loop with the same
 * budget. Keeping the loop and its constants in exactly one module removes the
 * drift risk where a future change to the readiness budget silently diverges
 * between the worker suites and the setup process.
 *
 * This module is deliberately dependency-light: `global-setup.ts` runs in the
 * Vitest setup process before `MONGODB_URI` exists, so it must NOT import
 * `@/server/db/mongo` or `../factories/env` (both would pull in validated
 * server config). It imports nothing but itself.
 */

/** How long a readiness wait keeps retrying before it gives up, in ms. */
export const MONGO_READY_TIMEOUT_MS = 30_000;

/**
 * Delay between readiness probes; short enough to react promptly to a late
 * primary, long enough not to busy-loop.
 */
export const MONGO_READY_RETRY_MS = 250;

/** Options for {@link pollReady}. */
export interface PollReadyOptions {
  /**
   * Genuine readiness probe. Resolve when the dependency is ready; reject (or
   * throw) to schedule a retry. Must have an observable side effect — this is a
   * real check, never a fixed sleep.
   */
  ping: () => Promise<unknown>;

  /** Total budget in ms before {@link pollReady} fails loudly. */
  timeoutMs: number;

  /** Delay between probes, in ms. */
  retryMs: number;

  /**
   * Builds the fail-loud error message from the budget that was actually used.
   * Each call site supplies its own message so its observable wording is
   * unchanged by the extraction.
   */
  timeoutMessage: (timeoutMs: number) => string;
}

/**
 * Poll `ping` until it answers, then resolve; if the budget is exhausted first,
 * fail loudly with `timeoutMessage(timeoutMs)` and the last probe error as the
 * `cause`.
 *
 * @param options - The probe, its budget/retry cadence and the timeout message.
 * @throws If no probe answers before the budget is exhausted.
 */
export async function pollReady(options: PollReadyOptions): Promise<void> {
  const { ping, timeoutMs, retryMs, timeoutMessage } = options;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  for (;;) {
    try {
      await ping();
      return;
    } catch (error) {
      lastError = error;
    }

    if (Date.now() >= deadline) {
      throw new Error(timeoutMessage(timeoutMs), { cause: lastError });
    }

    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
}
