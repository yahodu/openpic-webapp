/**
 * The `Clock` port (OP-72, epic Runtime Primitives).
 *
 * Domain and service code must never read the wall clock directly: inject a
 * `Clock` so time is deterministic in tests and controllable at the seam.
 */
export interface Clock {
  /** The current instant. */
  now(): Date;
}

/**
 * The production clock. Reads the process wall clock on every call.
 *
 * @example
 * systemClock.now().toISOString();
 */
export const systemClock: Clock = {
  now: () => new Date(),
};

/**
 * A deterministic clock.
 *
 * The first `now()` returns `start`; every subsequent read advances the cursor
 * by `stepMs` (default `0`, so the clock is frozen). Each clock owns its own
 * cursor, so two clocks never share state, and the `start` date is never
 * mutated.
 *
 * @param start - The initial instant as a `Date`, ISO string or epoch millis.
 * @param stepMs - Milliseconds to advance on every read. Defaults to `0`.
 * @returns A `Clock` whose reads advance deterministically.
 * @example
 * const clock = fixedClock("2026-01-02T03:04:05.000Z", 1000);
 * clock.now().toISOString(); // "2026-01-02T03:04:05.000Z"
 * clock.now().toISOString(); // "2026-01-02T03:04:06.000Z"
 */
export function fixedClock(start: Date | string | number, stepMs = 0): Clock {
  let cursor = new Date(start).getTime();

  return {
    now: (): Date => {
      const current = new Date(cursor);
      cursor += stepMs;
      return current;
    },
  };
}
