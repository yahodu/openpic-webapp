import { ObjectId } from "mongodb";

/**
 * The `{id}` path segment of a `/me/notifications/...` route (OP-97).
 *
 * The shared `defineRoute` pipeline hands the handler only `(request)`, so a
 * dynamic segment is read off the request URL exactly like
 * `me/sessions/{sessionId}` does. A malformed or absent segment is reported as
 * `null`, which every caller maps onto `404 not_found` (never `403`, so the
 * endpoints are not an existence oracle).
 *
 * @param request - The inbound request.
 * @param fromEnd - The segment's position from the end: `1` for a trailing
 *   `{id}`, `2` for `{id}/read`.
 * @returns The parsed id, or `null` when the segment is absent/malformed.
 */
export function notificationIdFromRequest(request: Request, fromEnd: number): ObjectId | null {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  const raw = segments.at(-fromEnd);
  return raw !== undefined && ObjectId.isValid(raw) ? new ObjectId(raw) : null;
}
