/**
 * Replay status (API contract §0.9).
 *
 * A replay returns the stored response body verbatim but is always served as
 * `200`, never the original `201 Created` — a client must not mistake a replay
 * for a resource that was created by *this* call.
 */

/**
 * Rewrite a stored status for replay.
 *
 * @param storedStatus - The status the original response was served with.
 * @returns `200` for a stored `201`, otherwise the stored status unchanged.
 */
export function replayedStatus(storedStatus: number): number {
  return storedStatus === 201 ? 200 : storedStatus;
}
