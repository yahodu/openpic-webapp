/**
 * Event instant normalisation (OP-115, contract §4.1, schema §15.1).
 *
 * Event instants are **canonical UTC**: a client may send `startAt` with any
 * RFC 3339 offset (e.g. `+05:30`), and the server stores and returns the same
 * instant as a `Z`-suffixed UTC string (OP-115 U4). The event's
 * `displayTimeZone` is a display preference stored separately — it never
 * participates in the instant arithmetic.
 */

/**
 * Normalise an RFC 3339 instant string to its canonical UTC `Z` form.
 *
 * The offset is resolved against the real calendar, so a `+05:30` input and a
 * `-05:00` input that denote the same UTC instant collapse to the same output.
 *
 * @param input - An RFC 3339 instant, possibly with a non-UTC offset.
 * @returns The same instant re-serialised with a `Z` suffix and millisecond
 *   precision.
 * @throws {Error} when `input` is not an instant at all — the function never
 *   guesses.
 */
export function normalizeInstantToUtc(input: string): string {
  const instant = new Date(input);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`not an RFC 3339 instant: ${input}`);
  }
  return instant.toISOString();
}
