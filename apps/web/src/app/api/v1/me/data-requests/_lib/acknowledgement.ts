/**
 * The §8.1 acknowledgement sentence, rendered from a request's deadline
 * (OP-138).
 *
 * `en-GB` with a numeric day, a long month and a numeric year — "25 October
 * 2026" — in UTC, because the stored deadline is a UTC instant and a local
 * rendering would disagree with the promise on any other zone.
 *
 * @param due - The instant the request falls due.
 * @returns The sentence the filing receipt carries.
 */
export function acknowledgementFor(due: Date): string {
  const day = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(due);
  return `We've received your request and will complete it by ${day}.`;
}
