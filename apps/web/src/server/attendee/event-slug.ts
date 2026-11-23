import { ObjectId, type Db } from "mongodb";

import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { buildAccessLinkShareUrl } from "@/server/events/access-links";
import { crossTenantReads, platformRepo } from "@/server/repos";

/**
 * Event → active access-link slug, and the redirect the `selfie` × `retry`
 * action composes from it (OP-140, contract §4.2/§7.3, schema §15.1, ADR-0962
 * §1, ADR-0963).
 *
 * `resolveEventBySlug` (`server/attendee/request-event.ts`) answers the other
 * direction — slug → event — so the feed's `selfie` target could not be turned
 * back into a link. This module is the reverse read, and it reads the **same**
 * predicate: `accessLinks: { $elemMatch: { active: true } }`. A rotated-away
 * link is not a link, so an event whose only link is revoked answers `null`
 * rather than sending the attendee to a dead event page.
 *
 * It lives in the attendee lane because `server/events/access-links.ts` is pure
 * by ADR-0620 (its builders take the base URL as an argument); only the one
 * `/e/{slug}` builder is reused here, so that URL is still minted in one place.
 */

/** The `events.accessLinks` entry this module reads (schema §15.1). */
interface AccessLinkRow {
  readonly slug: string;
  readonly active: boolean;
}

/**
 * Resolve the slug of an event's **active** access link.
 *
 * @param db - The database to read `events` from.
 * @param eventId - The event id, as an ObjectId or a 24-hex string.
 * @returns The active link's slug, or `null` when the id is not 24-hex, no
 *   event carries it, or every link on it has been rotated away.
 */
export async function resolveActiveAccessSlug(
  db: Db,
  eventId: ObjectId | string
): Promise<string | null> {
  if (typeof eventId === "string" && !ObjectId.isValid(eventId)) {
    return null;
  }
  const id = typeof eventId === "string" ? new ObjectId(eventId) : eventId;
  const event = (await platformRepo(db)
    .collection(COLLECTIONS.events)
    .findOne(
      { _id: id, accessLinks: { $elemMatch: { active: true } } },
      { projection: { accessLinks: 1 } }
    )) as { readonly accessLinks?: readonly AccessLinkRow[] } | null;
  return event?.accessLinks?.find((link) => link.active)?.slug ?? null;
}

/**
 * Compose the public retry link of a selfie's event.
 *
 * Walks selfie → event → active slug, then `buildAccessLinkShareUrl` so the
 * configured `APP_BASE_URL` (never a hardcoded host) and the single `/e/`
 * builder are honoured.
 *
 * @param db - The database to read `selfies` and `events` from.
 * @param selfieId - The selfie id, as an ObjectId or a 24-hex string.
 * @returns `${APP_BASE_URL}/e/{slug}`, or `null` when the selfie, its event or
 *   the event's active link is absent.
 */
export async function attendeeRetryRedirectUrl(
  db: Db,
  selfieId: ObjectId | string
): Promise<string | null> {
  const id = typeof selfieId === "string" ? selfieId : selfieId.toHexString();
  const selfie = await crossTenantReads.findWorkItemById("selfie", id, db);
  if (selfie?.eventId === undefined) {
    return null;
  }
  const slug = await resolveActiveAccessSlug(db, selfie.eventId);
  return slug === null ? null : buildAccessLinkShareUrl(getConfig().app.baseUrl, slug);
}
