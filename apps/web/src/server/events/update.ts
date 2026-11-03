/**
 * The event-update surface (OP-117, contract §4.1, ADR-0580).
 *
 * Three pure behaviours the PATCH / archive / delete routes lean on, exposed
 * as module-level exports so the unit specs can drive them without a clock or
 * a database:
 *
 * - {@link EVENT_EDITABLE_FIELDS} — the ten §4.1 editable field names,
 *   verbatim. The PATCH route rejects any supplied key outside this set with
 *   `422 forbidden_field`.
 * - {@link findForbiddenEditableFields} — the pure filter the PATCH route
 *   runs over the request body (a supplied key whose value is `undefined` is
 *   invisible, mirroring the `PATCH /me` precedent).
 * - {@link isEventLocked} — the start boundary predicate: once
 *   `now >= startAt` the event has started and a `startAt` change is refused
 *   with `409 event_already_started`; **exactly** at `now === startAt` the
 *   event is already locked.
 */

/** The ten §4.1 editable field names, verbatim (contract §4.1). */
export const EVENT_EDITABLE_FIELDS: readonly string[] = [
  "name",
  "description",
  "startAt",
  "endAt",
  "displayTimeZone",
  "logoAssetId",
  "watermarkAssetId",
  "thumbnailPreset",
  "visibilityDefaults",
  "status",
];

/**
 * The supplied keys that fall outside the §4.1 editable set.
 *
 * A key whose value is `undefined` is invisible to the check — it was never
 * meaningfully supplied (the `PATCH /me` precedent, `@/server/me/patch-schema`).
 *
 * @param supplied - The parsed request body.
 * @returns The offending top-level key names, in `Object.keys` order.
 */
export function findForbiddenEditableFields(supplied: Record<string, unknown>): string[] {
  const editable = new Set<string>(EVENT_EDITABLE_FIELDS);
  return Object.keys(supplied).filter((key) => supplied[key] !== undefined && !editable.has(key));
}

/**
 * Whether the event has begun at `now` and its start can no longer be moved.
 *
 * The exact `now === startAt` boundary counts as started.
 *
 * @param now - The current clock instant.
 * @param startAt - The event's stored start instant.
 * @returns `true` when `now.getTime() >= startAt.getTime()`.
 */
export function isEventLocked(now: Date, startAt: Date): boolean {
  return now.getTime() >= startAt.getTime();
}
