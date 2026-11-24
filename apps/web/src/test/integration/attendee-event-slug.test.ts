/**
 * Integration / contract — the attendee lane's **event → active access-link
 * slug** resolver and the redirect it composes (OP-140 precondition, card
 * `t_9df3b691`; contract §4.2 and §7.3 `selfie` × `retry`; schema §15.1;
 * ADR-0962).
 *
 * §7.3 answers a `selfie` × `retry` click with `{ "redirectUrl": "/e/{slug}" }`,
 * and the only builder of that URL on the trunk is
 * `buildAccessLinkShareUrl(baseUrl, slug)` (`server/events/access-links.ts`).
 * The shipped resolver reads the predicate the other way round —
 * `resolveEventBySlug(db, slug)` answers slug → event
 * (`server/attendee/request-event.ts`) — so nothing today can turn the feed
 * row's `selfie` target into a link.
 *
 * Two halves are pinned here, in one module
 * (`@/server/attendee/event-slug`):
 *
 * - `resolveActiveAccessSlug(db, eventId)` reads the **same** predicate
 *   `resolveEventBySlug` reads — `accessLinks.$elemMatch { slug, active: true }`
 *   — and answers the event's active slug or `null`. One predicate, both
 *   directions: the last case walks a slug out and `resolveEventBySlug` back in
 *   and requires the same event.
 * - `attendeeRetryRedirectUrl(db, selfieId)` walks selfie → event → slug and
 *   composes the answer with `buildAccessLinkShareUrl(APP_BASE_URL, slug)`, so
 *   `/e/` is still minted by exactly one function in this repo and the redirect
 *   honours a configured base URL with a trailing slash.
 *
 * The active-only arm is the whole point of the resolver. A naive
 * `findOne({ _id: eventId })` that reads `accessLinks[0]`, or a filter on
 * `accessLinks.active` rather than an `$elemMatch`, answers a link the
 * organizer deliberately rotated away — and the attendee's retry button would
 * send them to a dead event page.
 */

import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";

import { attendeeRetryRedirectUrl, resolveActiveAccessSlug } from "@/server/attendee/event-slug";
import { resolveEventBySlug } from "@/server/attendee/request-event";
import { COLLECTIONS } from "@/server/db/collections";

import { APP_ORIGIN } from "../helpers/authed-app";
import { app, submittedSelfie } from "../helpers/internal-worker-harness";
import { seedTenant } from "../helpers/selfie-flow";

/** The access-link row shape §15.1 stores (one entry of `events.accessLinks`). */
interface AccessLinkRow {
  readonly slug: string;
  readonly active: boolean;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
  readonly scanCount: number;
}

/**
 * Seed one tenant with one published event and nothing else.
 *
 * @param prefix - The suite-local identity/slug prefix.
 * @returns The tenant key and the event's id and active slug.
 */
async function seedEventOnly(prefix: string) {
  const { tenantKey, events } = await seedTenant(app, prefix);
  const [event] = events;
  if (event === undefined) {
    throw new Error("expected the seeded tenant to carry one event");
  }
  return { tenantKey, event };
}

/**
 * Replace one event's `accessLinks` with exactly the rows a rotation leaves.
 *
 * @param eventId - The event to rewrite.
 * @param links - The link rows the case wants the event to hold, in order.
 */
async function replaceAccessLinks(
  eventId: ObjectId,
  links: readonly AccessLinkRow[]
): Promise<void> {
  await app.db
    .collection(COLLECTIONS.events)
    .updateOne({ _id: eventId }, { $set: { accessLinks: links } });
}

/** One access-link row, active unless the case says otherwise. */
function accessLink(slug: string, active: boolean): AccessLinkRow {
  const createdAt = new Date("2026-01-02T00:00:00.000Z");
  return {
    slug,
    active,
    createdAt,
    revokedAt: active ? null : new Date("2026-01-03T00:00:00.000Z"),
    scanCount: 0,
  };
}

describe("when an event's active access-link slug is resolved", () => {
  it("answers the slug of the event's active access link", async () => {
    const { event } = await seedEventOnly("op140-slug-active");

    // Arrange: the seeded event carries exactly one active link.

    // Act
    const slug = await resolveActiveAccessSlug(app.db, event.id);

    // Assert
    expect(slug).toBe(event.slug);
  });

  it("answers the active slug from the stored 24-hex id the feed row carries", async () => {
    const { event } = await seedEventOnly("op140-slug-hex");

    // Arrange: `actionTarget.id` reaches a delegate as a string, never an ObjectId.

    // Act
    const slug = await resolveActiveAccessSlug(app.db, event.id.toHexString());

    // Assert
    expect(slug).toBe(event.slug);
  });

  it("answers null when the event's only access link has been rotated away", async () => {
    const { event } = await seedEventOnly("op140-slug-rotated-only");
    await replaceAccessLinks(event.id, [accessLink(event.slug, false)]);

    // Act
    const slug = await resolveActiveAccessSlug(app.db, event.id);

    // Assert: a revoked link is not a link.
    expect(slug).toBeNull();
  });

  it("answers the live link when an earlier link on the same event was rotated away", async () => {
    const { event } = await seedEventOnly("op140-slug-rotated-first");
    const liveSlug = "live140a";
    await replaceAccessLinks(event.id, [accessLink("rotated0", false), accessLink(liveSlug, true)]);

    // Act
    const slug = await resolveActiveAccessSlug(app.db, event.id);

    // Assert: the answer is the active entry, not `accessLinks[0]`.
    expect(slug).toBe(liveSlug);
  });

  it("answers null for an id that addresses no event", async () => {
    // Arrange

    // Act
    const slug = await resolveActiveAccessSlug(app.db, new ObjectId());

    // Assert: a missing event is an absent link, never a throw.
    expect(slug).toBeNull();
  });

  it("answers null for an id that is not a 24-hex ObjectId", async () => {
    // Arrange

    // Act
    const slug = await resolveActiveAccessSlug(app.db, "not-an-object-id");

    // Assert: a malformed segment must not reach the driver as a BSON error.
    expect(slug).toBeNull();
  });

  it("agrees with the shipped slug→event resolver (one predicate, both directions)", async () => {
    const { tenantKey, event } = await seedEventOnly("op140-slug-round-trip");

    // Act: resolve event → slug, then hand that slug back to the shipped resolver.
    const slug = await resolveActiveAccessSlug(app.db, event.id);
    if (slug === null) {
      throw new Error("expected the seeded event to resolve an active slug");
    }
    const resolved = await resolveEventBySlug(app.db, slug);

    // Assert
    expect(resolved.eventId.toHexString()).toBe(event.id.toHexString());
    expect(resolved.tenantKey).toBe(tenantKey);
  });
});

describe("when the selfie × retry redirect is composed", () => {
  it("answers the public link of the selfie's event's active access link", async () => {
    const fixture = await submittedSelfie("op140-redirect", "op140-redirect");

    // Act
    const redirectUrl = await attendeeRetryRedirectUrl(app.db, fixture.selfieId);

    // Assert: `/e/{slug}` comes from `buildAccessLinkShareUrl`, so the base URL
    // is the configured `APP_BASE_URL` and never a hardcoded host.
    expect(redirectUrl).toBe(`${APP_ORIGIN}/e/${fixture.world.event.slug}`);
  });

  it("answers null when the selfie's event link was rotated away", async () => {
    const fixture = await submittedSelfie("op140-redirect-rotated", "op140-redirect-rotated");
    await replaceAccessLinks(fixture.world.event.id, [accessLink(fixture.world.event.slug, false)]);

    // Act
    const redirectUrl = await attendeeRetryRedirectUrl(app.db, fixture.selfieId);

    // Assert
    expect(redirectUrl).toBeNull();
  });

  it("answers null for an id that addresses no selfie", async () => {
    // Arrange

    // Act
    const redirectUrl = await attendeeRetryRedirectUrl(app.db, new ObjectId());

    // Assert
    expect(redirectUrl).toBeNull();
  });
});
