import { ObjectId } from "mongodb";

import { appError } from "@/server/http/errors";

/**
 * The `{eventId}` path segment of a matched global event request (OP-117,
 * contract §0.4).
 *
 * The global event routes are matched on a literal route string
 * (`/api/v1/events/:eventId` and `/api/v1/events/:eventId/archive`), so the id
 * is read from the request's own path rather than from a `ctx.params` map. A
 * segment that is not a 24-hex-character id cannot name an event, so it denies
 * `404` — the endpoint must never become an existence oracle.
 */

/** A 24-hex-character `ObjectId`, the only shape a route accepts as an id. */
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/** Where the id segment sits relative to the end of the path. */
export interface EventIdSegmentOptions {
  /**
   * `1` when the id is the last segment (`…/{eventId}`, the default) and `2`
   * when a fixed suffix follows it (`…/{eventId}/archive`).
   */
  readonly segmentFromEnd?: number;
}

/**
 * Parse the event id out of the request path.
 *
 * @param request - The inbound request.
 * @param options - How far from the path's end the id segment sits.
 * @returns The event id.
 * @throws An `AppError` with code `not_found` when the segment is not a valid
 *   24-hex id.
 */
export function eventIdFromRequest(
  request: Request,
  options: EventIdSegmentOptions = {}
): ObjectId {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  const raw = String(segments.at(-(options.segmentFromEnd ?? 1)));
  if (!OBJECT_ID_PATTERN.test(raw)) {
    throw appError("not_found");
  }
  return new ObjectId(raw);
}

/**
 * Parse the event id that follows the literal `events` path segment.
 *
 * The tenant-scoped routes nest the event under
 * `/tenants/{tenantId}/events/{eventId}/…`, and the segments that follow it
 * differ per route (`/members`, `/invitations`, or nothing at all on the event
 * detail read), so the id is located by its own anchor rather than by a fixed
 * distance from the end.
 *
 * @param request - The inbound request.
 * @returns The event id.
 * @throws An `AppError` with code `not_found` when the segment after `events`
 *   is not a valid 24-hex id.
 */
export function eventIdAfterEventsSegment(request: Request): ObjectId {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  const raw = segments[segments.indexOf("events") + 1] ?? "";
  if (!OBJECT_ID_PATTERN.test(raw)) {
    throw appError("not_found");
  }
  return new ObjectId(raw);
}
