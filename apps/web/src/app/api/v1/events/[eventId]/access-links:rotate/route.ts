import type { Document } from "mongodb";
import { z } from "zod";

import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { withTransaction } from "@/server/db/transaction";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { buildAccessLinkShareUrl } from "@/server/events/access-links";
import { loadEventRow, requireEventRole, requirePrincipal } from "@/server/events/access";
import { eventIdFromRequest } from "@/server/events/event-id";
import { generateAccessLinkSlug } from "@/server/events/slug";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { getLogger } from "@/server/logging";
import { platformRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { userAuth } from "@/server/tenancy/route-scope";

/**
 * `POST /api/v1/events/{eventId}/access-links:rotate` — rotate a compromised
 * share link (OP-118 §1, contract §4.2, schema §15.1; ADR-0620).
 *
 * The **organizer** rotates the event's public link: a fresh slug is pushed and
 * the previously active one is revoked with a `revokedAt` stamp, so exactly one
 * link stays `active` at any instant. The write is one array update computed
 * server-side, so a concurrent rotation cannot leave the event with zero or two
 * active links; the `event.link.rotated` domain event joins the same
 * transaction. The answer is the §4.2 `{ accessLinks, warning }` body — the new
 * link first with its `shareUrl`, the revoked one second — and the warning
 * names the slug whose printed QR codes stop working.
 *
 * The rotation demands an explicit acknowledgement (`{ confirmUnderstood: true }`):
 * a missing or `false` value is `422 acknowledgement_required` and writes
 * nothing. Admission is `organizer` only — a co-organizer answers `403
 * forbidden`, a caller with no relationship `404 not_found` (never a
 * cross-tenant existence oracle, contract §0.4).
 *
 * ## Path decision
 *
 * The contract spells the endpoint tenant-scoped; it lives on the **global**
 * `/api/v1/events/{eventId}` family like this lane's PATCH/archive/delete and
 * `upload-window:extend`, because that family admits a co-organizer who is not
 * a tenant member (ADR-0580 §D1, ADR-0620).
 */

/** One stored `accessLinks[]` element (schema §15.1). */
interface StoredAccessLink {
  readonly slug: string;
  readonly active: boolean;
  readonly createdAt?: Date;
  readonly revokedAt?: Date | null;
  readonly scanCount?: number;
}

/** The stored `events` row fields this route reads beyond the DTO. */
interface EventRotateRow {
  readonly tenantId: string;
  readonly accessLinks?: readonly StoredAccessLink[];
}

/**
 * The request body.
 *
 * `confirmUnderstood` is optional here on purpose: a refusal is the contract's
 * `422 acknowledgement_required`, not the generic body-validation error, so the
 * handler owns that decision.
 */
const rotateBodySchema = z.object({
  confirmUnderstood: z.boolean().optional(),
});

/** The §4.2 rotate answer schema. */
const rotateResponseSchema = z.object({
  accessLinks: z.array(
    z.object({
      slug: z.string(),
      active: z.boolean(),
      shareUrl: z.string().optional(),
      revokedAt: z.string().optional(),
    })
  ),
  warning: z.string(),
});

/** The §4.2 answer body. */
type RotateResponse = z.infer<typeof rotateResponseSchema>;

/** The link a rotation appends (schema §15.1's element shape). */
type NewAccessLink = Required<StoredAccessLink>;

/**
 * The rotation as one server-side array update.
 *
 * The new link leads the array and every currently active link is revoked in
 * the same document write, so two rotations in flight can never both win: the
 * engine serialises the writes on the document and each ends with exactly one
 * active link (ADR-0620 §Decision, consequences).
 *
 * @param newLink - The element being pushed.
 * @param now - The rotation instant stamped on the revoked elements.
 * @returns The aggregation-pipeline update.
 */
function rotatePipeline(newLink: NewAccessLink, now: Date): Document[] {
  return [
    {
      $set: {
        accessLinks: {
          $concatArrays: [
            [newLink],
            {
              $map: {
                input: { $ifNull: ["$accessLinks", []] },
                in: {
                  $cond: [
                    { $eq: ["$$this.active", true] },
                    { $mergeObjects: ["$$this", { active: false, revokedAt: now }] },
                    "$$this",
                  ],
                },
              },
            },
          ],
        },
        updatedAt: now,
      },
    },
  ];
}

/** The active element of a stored `accessLinks[]`, if any. */
function activeLinkOf(
  links: readonly StoredAccessLink[] | undefined
): StoredAccessLink | undefined {
  return links?.find((link) => link.active);
}

export const POST = defineRoute({
  route: "/api/v1/events/:eventId/access-links:rotate",
  body: rotateBodySchema,
  response: rotateResponseSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  handler: async (ctx): Promise<{ body: RotateResponse }> => {
    const principal = requirePrincipal(ctx);
    const db = getDb();
    const config = getConfig();
    // The literal `access-links:rotate` suffix follows the id in this path.
    const eventId = eventIdFromRequest(ctx.request, { segmentFromEnd: 2 });
    const id = eventId.toHexString();
    const row = await loadEventRow<EventRotateRow>(db, eventId);

    // Rotation is organizer-only. A related caller without the role is refused
    // with `403`, a caller with no relationship with `404` (never an oracle).
    await requireEventRole(db, eventId, row.tenantId, principal, ["organizer"]);

    if (!ctx.body.confirmUnderstood) {
      throw appError("acknowledgement_required", {
        details: {
          consequences: ["Previously printed QR codes for this event will stop working."],
        },
      });
    }

    const now = systemClock.now();
    const newLink: NewAccessLink = {
      slug: generateAccessLinkSlug(),
      active: true,
      createdAt: now,
      revokedAt: null,
      scanCount: 0,
    };

    const before = await withTransaction(async (session) => {
      const previous = (await platformRepo(db)
        .collection(COLLECTIONS.events)
        .findOneAndUpdate({ _id: eventId }, rotatePipeline(newLink, now), {
          session,
          returnDocument: "before",
        })) as EventRotateRow | null;
      if (previous === null) {
        throw appError("not_found");
      }
      await emitDomainEvent(
        {
          eventKey: "event.link.rotated",
          tenantId: row.tenantId,
          actorRef: { kind: "user", id: principal },
          subjectRef: { kind: "event", id },
          payload: { eventId: id, newSlug: newLink.slug },
        },
        { db, session }
      );
      return previous;
    });

    const revoked = activeLinkOf(before.accessLinks);
    if (revoked === undefined) {
      throw appError("conflict");
    }

    getLogger().info("event access link rotated", {
      event: "event.link.rotated",
      tenantId: row.tenantId,
      eventId: id,
    });

    return {
      body: {
        accessLinks: [
          {
            slug: newLink.slug,
            active: true,
            shareUrl: buildAccessLinkShareUrl(config.app.baseUrl, newLink.slug),
          },
          { slug: revoked.slug, active: false, revokedAt: now.toISOString() },
        ],
        warning: `Previously printed QR codes for ${revoked.slug} will no longer work.`,
      },
    };
  },
});
