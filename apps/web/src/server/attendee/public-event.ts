/**
 * The public event page's two pure decisions (OP-130, contract §6.1, schema
 * §15.1; ADR-0784 §1).
 *
 * `GET /api/v1/p/events/{slug}` is unauthenticated and cross-tenant, so its
 * whole risk is the two questions this module answers without a database, a
 * clock or a request:
 *
 *   - {@link formatStartAtLocal} pre-renders the event's start instant in its
 *     `displayTimeZone`, so the attendee page ships no timezone data and a
 *     phone with stale `tzdata` still shows the right local time;
 *   - {@link resolvePublicEventOutcome} is the §6.1 state table — what a caller
 *     may learn about an event, from the link the slug names and the event's
 *     status, in the contract's own precedence order.
 */

/** Every `events.status` value (schema §15.1). */
export type PublicEventStatus = "draft" | "published" | "live" | "ended" | "archived" | "deleting";

/** What the slug names: a live link, a rotated-away one, or nothing at all. */
export type PublicEventLinkState = "active" | "revoked" | "unknown";

/** The stored facts the §6.1 state table is a function of. */
export interface PublicEventFacts {
  /** The link the slug resolved to. */
  readonly link: PublicEventLinkState;
  /** The event's status, `null` when the link is unknown. */
  readonly status: PublicEventStatus | null;
  /** The clock the gallery window is judged against. */
  readonly now: Date;
  /** The gallery retention instant (schema §15.1); `null` means unbounded. */
  readonly retentionExpiresAt: Date | null;
}

/** A refusal: the HTTP status and catalogue code the route must answer. */
export interface PublicEventRefusal {
  readonly kind: "error";
  readonly status: 404 | 410;
  readonly code: "not_found" | "access_link_revoked" | "event_gone";
}

/** The page renders, with the gallery window resolved. */
export interface PublicEventPage {
  readonly kind: "ok";
  readonly galleryOpen: boolean;
  /** The §6.1 `gallery.expiredAt`: the retention instant once it elapsed. */
  readonly galleryExpiredAt: Date | null;
}

/** The resolved outcome of one `GET /p/events/{slug}`. */
export type PublicEventOutcome = PublicEventRefusal | PublicEventPage;

/**
 * The §6.1 refusal rows (contract §6.1's table, in its precedence order).
 *
 * @param facts - The stored facts of the request.
 * @returns The refusal, or `null` when the page renders.
 */
function refusalFor(facts: PublicEventFacts): PublicEventRefusal | null {
  // Row 1: a slug that names no link at all (its status is `null` by definition).
  if (facts.link === "unknown") {
    return { kind: "error", status: 404, code: "not_found" };
  }
  // Row 2 before row 3/4: the QR the attendee holds is dead whatever the event
  // became afterwards, so a revoked link answers the same for every status.
  if (facts.link === "revoked") {
    return { kind: "error", status: 410, code: "access_link_revoked" };
  }
  // Row 3: a draft is indistinguishable from a slug that never existed. A
  // status that could not be read renders the same way — never an oracle.
  if (facts.status === null || facts.status === "draft") {
    return { kind: "error", status: 404, code: "not_found" };
  }
  // Row 4: the content is going away.
  if (facts.status === "deleting") {
    return { kind: "error", status: 410, code: "event_gone" };
  }
  return null;
}

/**
 * Resolve the §6.1 outcome of a landing call.
 *
 * @param facts - The link state, the event's status, the clock and the
 *   retention instant.
 * @returns A refusal, or the resolved gallery window. Retention is inclusive:
 *   the gallery is closed from `retentionExpiresAt` onward.
 */
export function resolvePublicEventOutcome(facts: PublicEventFacts): PublicEventOutcome {
  const refusal = refusalFor(facts);
  if (refusal !== null) {
    return refusal;
  }

  const retention = facts.retentionExpiresAt;
  const elapsed = retention !== null && facts.now.getTime() >= retention.getTime();
  return {
    kind: "ok",
    galleryOpen: !elapsed,
    galleryExpiredAt: elapsed ? retention : null,
  };
}

/** The `timeZoneName` prefix `Intl` puts before a non-zero UTC offset. */
const OFFSET_PREFIX = "GMT";

/** The offset a zero-offset zone renders as (`longOffset` answers bare `GMT`). */
const ZERO_OFFSET = "+00:00";

/** One instant's wall clock and zone offset, split for {@link formatStartAtLocal}. */
interface ZonedFields {
  readonly year: string;
  readonly month: string;
  readonly day: string;
  readonly hour: string;
  readonly minute: string;
  readonly second: string;
  /** The zone's offset **at this instant** (`+05:30`, `-05:00`, `+00:00`). */
  readonly offset: string;
}

/**
 * The wall-clock fields and the zone offset of one instant, in `timeZone`.
 *
 * @param startAt - The canonical UTC instant.
 * @param timeZone - The event's `displayTimeZone` (an IANA zone name).
 * @returns The RFC 3339 local date-time fields and the numeric offset.
 */
function zonedFields(startAt: Date, timeZone: string): ZonedFields {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "longOffset",
  }).formatToParts(startAt);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  // `longOffset` renders a zero offset as bare "GMT" and every other offset as
  // "GMT+05:30"; `startAtLocal` must never say `Z`.
  const zoneName = value("timeZoneName");
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
    offset: zoneName.slice(OFFSET_PREFIX.length) || ZERO_OFFSET,
  };
}

/**
 * Render an instant as the §6.1 `startAtLocal`: `YYYY-MM-DDTHH:mm:ss±HH:MM`.
 *
 * The offset is the zone's offset **at that instant** (not a per-zone
 * constant), so both sides of a DST transition render correctly.
 *
 * @param startAt - The event's canonical UTC `startAt`.
 * @param timeZone - The event's `displayTimeZone`.
 * @returns The local date-time with a numeric offset, second precision.
 */
export function formatStartAtLocal(startAt: Date, timeZone: string): string {
  const fields = zonedFields(startAt, timeZone);
  return `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}:${fields.second}${fields.offset}`;
}
