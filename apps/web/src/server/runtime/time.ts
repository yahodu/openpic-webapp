/**
 * Date arithmetic for injected-`Clock` code (OP-72, OP-88).
 *
 * Domain and service code must read time through the injected `Clock` port and
 * must not construct dates ambiently — the `src/server/domain/**` and
 * `src/server/services/**` lint bans `new Date(...)`/`Date.now()` outright
 * (see `eslint.config.mjs`). Deriving a future/expiry instant from a
 * `clock.now()` reading still needs a shift, so the shift lives here where it
 * is lint-legal and testable.
 */

/** Milliseconds in one day, named so retention windows read as `days * MS_PER_DAY`. */
export const MS_PER_DAY = 86_400_000;

/**
 * Shift an instant by a signed number of milliseconds, as a new `Date`.
 *
 * @param instant - The instant to shift (unchanged).
 * @param milliseconds - The signed offset to apply.
 * @returns A new `Date` `milliseconds` after `instant`.
 */
export function addMilliseconds(instant: Date, milliseconds: number): Date {
  return new Date(instant.getTime() + milliseconds);
}

/**
 * Shift an instant by a signed number of days, as a new `Date`.
 *
 * @param instant - The instant to shift (unchanged).
 * @param days - The signed number of days to add (may be fractional).
 * @returns A new `Date` `days` after `instant`.
 */
export function addDays(instant: Date, days: number): Date {
  return addMilliseconds(instant, days * MS_PER_DAY);
}
