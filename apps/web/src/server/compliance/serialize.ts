/**
 * Reading stored privacy rows back onto the wire (OP-138).
 *
 * Both consent records and data-subject requests are read by the data subject
 * years after they were written, and both store their instants as `Date`. These
 * two helpers keep the ISO rendering in one place so a list and a detail view
 * can never disagree.
 */

/**
 * Read a stored instant as an ISO string.
 *
 * @param value - A `Date` (or a parseable string) as stored.
 * @returns The ISO-8601 rendering.
 * @throws {Error} when the value is missing or unparseable.
 */
export function isoOf(value: unknown): string {
  const instant = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(instant.getTime())) {
    throw new Error("a stored privacy row is missing an instant");
  }
  return instant.toISOString();
}

/**
 * Read an optional stored instant.
 *
 * @param value - A `Date`, a parseable string, or nothing.
 * @returns The ISO-8601 rendering, or `null` when absent.
 */
export function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : isoOf(value);
}
