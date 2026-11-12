import { ObjectId } from "mongodb";
import { z } from "zod";

import { getAuth } from "@/server/auth";
import { enforceAuth, resolvePrincipal } from "@/server/auth/guards";
import { getConfig, getRateLimitConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { resolveEventActorRole } from "@/server/events/access";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { createMediaSigner } from "@/server/media/signer";
import {
  SIGNED_URL_DENIAL_CODES,
  SIGNED_URL_KINDS,
  authorizeSignedUrlItem,
  signedUrlBatchStatus,
  type SignedUrlCaller,
  type SignedUrlDecision,
  type SignedUrlDenialCode,
  type SignedUrlKind,
} from "@/server/media/signed-urls";
import { createRateLimiter, rateLimitStage } from "@/server/rate-limit";
import { systemClock } from "@/server/runtime/clock";
import { platformRepo, tenantRepo } from "@/server/repos";
import { checkEntitlement } from "@/server/services/entitlements";

/**
 * `POST /api/v1/media/signed-urls` — the batch signed-media-URL refresh (OP-128,
 * contract §5.6, §0.11, §0.14, §0.15).
 *
 * A long-lived gallery page refreshes every expired thumbnail/original it shows
 * in one call. Authorization is per item (§5.6), so `denied[]` carries a coded
 * refusal while the batch still answers `200`; only an all-denied batch is a
 * `403` ({@link signedUrlBatchStatus}).
 *
 * The route is **`public`**-labelled: §5.6 names `user` or `attendee`, but its
 * authorization is per item, and an anonymous caller must learn per item that
 * it has to sign in (`denied[] authentication_required`) rather than receive a
 * gateway `401` (ADR-0764 D3/D4). The principal is therefore resolved here —
 * and put through the `user` label's account-status guard (ADR-0772) — and
 * decides the caller class — an event member (organizer, co-organizer or
 * active tenant member) or an attendee (a caller with a `face_matches` row for
 * the image; OP-129 owns the `op_att` session resolver).
 *
 * Every read is batched with `$in` — one query per collection regardless of the
 * batch size (`I5`), and the plan gate is resolved once per request.
 */

/** The §5.6 maximum batch; a larger list is `413` before any lookup. */
const MAX_ITEMS = 200;

/** The plan key whose `originals.download` gate protects originals (§0.14). */
const ORIGINALS_KEY = "originals.download";

/** One refresh item as the wire carries it. */
const itemSchema = z.object({
  kind: z.enum(SIGNED_URL_KINDS),
  imageId: z.string().min(1),
});

/**
 * The §5.6 request `{ scope: { kind: "event", id }, items }`.
 *
 * The item array carries no `.max(200)`: a schema cap would reach the wire as
 * `422 validation_failed`, while the card's contract is `413
 * payload_too_large` for a 201-item list (ADR-0764 D7) — so the cap is the
 * handler's own check.
 */
const requestSchema = z.object({
  scope: z.object({
    kind: z.enum(["event"]),
    id: z.string().min(1),
  }),
  items: z.array(itemSchema).min(1),
});

/** The §5.6 answer: two keys, never `objectKey`, `contentHash` or a bucket (§0.15). */
const responseSchema = z.object({
  urls: z.array(
    z.object({
      imageId: z.string(),
      kind: z.enum(SIGNED_URL_KINDS),
      url: z.string(),
      expiresAt: z.string(),
    })
  ),
  denied: z.array(
    z.object({
      imageId: z.string(),
      kind: z.enum(SIGNED_URL_KINDS),
      code: z.enum(SIGNED_URL_DENIAL_CODES),
    })
  ),
});

/** The `events` fields the scope resolution reads. */
interface EventRow {
  readonly tenantId?: unknown;
}

/** The `event_images` fields the gate reads (§16.3). */
interface ImageRow {
  readonly _id: ObjectId;
  readonly assetId: ObjectId;
  readonly visibility?: string;
}

/** The `media_assets` fields the signing reads (§16.1). */
interface AssetRow {
  readonly _id: ObjectId;
  readonly contentHash: string;
  readonly storage: { readonly contentType: string };
  readonly derivatives?: { readonly thumbnail?: { readonly format?: string } };
}

/** The `face_matches` fields the attendee gate reads (§17.5). */
interface FaceMatchRow {
  readonly imageId: ObjectId;
}

/** One signed entry of the §5.6 answer. */
interface SignedUrlEntry {
  readonly imageId: string;
  readonly kind: SignedUrlKind;
  readonly url: string;
  readonly expiresAt: string;
}

/** One denial of the §5.6 answer — always coded (§5.6). */
interface SignedUrlDenial {
  readonly imageId: string;
  readonly kind: SignedUrlKind;
  readonly code: SignedUrlDenialCode;
}

/**
 * The data-plane extension for one derivative.
 *
 * A thumbnail's recorded format is authoritative; the content type's subtype
 * addresses an original, as `createMediaSigner` is path-agnostic.
 */
function extensionOf(kind: SignedUrlKind, asset: AssetRow): string {
  if (kind === "thumbnail") {
    return asset.derivatives?.thumbnail?.format ?? "webp";
  }
  return asset.storage.contentType.split("/")[1] ?? "jpg";
}

export const POST = defineRoute({
  route: "/api/v1/media/signed-urls",
  body: requestSchema,
  response: responseSchema,
  rateLimit: rateLimitStage({
    classKey: "media.sign",
    limiter: createRateLimiter(),
    salt: getRateLimitConfig().salt,
  }),
  handler: async (ctx) => {
    const { scope, items } = ctx.body;
    if (items.length > MAX_ITEMS) {
      throw appError("payload_too_large");
    }

    const db = getDb();
    const principal = await resolvePrincipal(ctx.request, { auth: getAuth(), database: db });

    // This `public` route resolves the principal itself, so the `user` label's
    // account-state rules never run; apply them here through the guards' own
    // seam (ADR-0772, ADR-0773), so a refusal logs `auth.denied` and answers
    // the Appendix A.1 envelope instead of a flattened `forbidden`. A suspended,
    // banned or deletion-pending caller is refused the whole request — the
    // account decides every item, so the batch rule would collapse it anyway.
    if (principal?.kind === "user") {
      enforceAuth("user", { principal, now: systemClock.now() }, ctx.request, ctx.route);
    }

    // The scope event names the tenant every read is confined to.
    const scopeId = ObjectId.isValid(scope.id) ? new ObjectId(scope.id) : null;
    const event =
      scopeId === null
        ? null
        : ((await platformRepo(db)
            .collection(COLLECTIONS.events)
            .findOne({ _id: scopeId })) as EventRow | null);
    const tenantKey = typeof event?.tenantId === "string" ? event.tenantId : null;

    let caller: SignedUrlCaller = "anonymous";
    if (principal !== null) {
      const isMember =
        principal.kind === "user" &&
        scopeId !== null &&
        tenantKey !== null &&
        (await resolveEventActorRole(db, scopeId, tenantKey, principal.userId)) !== null;
      caller = isMember ? "member" : "attendee";
    }

    // The requested ids, deduplicated and narrowed to well-formed ids: a
    // malformed or unknown id simply finds no live image (`not_found`).
    const requestedIds = [...new Set(items.map((item) => item.imageId))];
    const objectIds = requestedIds
      .filter((id) => ObjectId.isValid(id))
      .map((id) => new ObjectId(id));

    const images =
      tenantKey === null || scopeId === null
        ? []
        : ((await tenantRepo(tenantKey, db)
            .collection(COLLECTIONS.eventImages)
            .find({ _id: { $in: objectIds }, eventId: scopeId, deletedAt: null })
            .toArray()) as unknown as ImageRow[]);

    const assets =
      tenantKey === null
        ? []
        : ((await tenantRepo(tenantKey, db)
            .collection(COLLECTIONS.mediaAssets)
            .find({ _id: { $in: images.map((image) => image.assetId) } })
            .toArray()) as unknown as AssetRow[]);

    // An attendee's only claim is a `face_matches` row for the image, so the
    // match set is one `$in` read (never one per item).
    const subjectUserId = principal !== null && principal.kind === "user" ? principal.userId : null;
    const matches =
      caller === "attendee" && tenantKey !== null && scopeId !== null && subjectUserId !== null
        ? ((await tenantRepo(tenantKey, db)
            .collection(COLLECTIONS.faceMatches)
            .find({
              eventId: scopeId,
              imageId: { $in: objectIds },
              "subject.userId": new ObjectId(subjectUserId),
            })
            .toArray()) as unknown as FaceMatchRow[])
        : [];

    // The plan gate is resolved once per request, and only when an original is
    // actually asked for by a credentialed caller.
    const originalsAllowed =
      caller !== "anonymous" && tenantKey !== null && items.some((item) => item.kind === "original")
        ? (await checkEntitlement(tenantKey, ORIGINALS_KEY, 0, {}, { db })).allowed
        : false;

    const imageById = new Map(images.map((image) => [image._id.toHexString(), image]));
    const assetById = new Map(assets.map((asset) => [asset._id.toHexString(), asset]));
    const matchedIds = new Set(matches.map((match) => String(match.imageId)));
    const signer = createMediaSigner({
      currentSecret: getConfig().media.signingSecretCurrent,
    });

    const urls: SignedUrlEntry[] = [];
    const denied: SignedUrlDenial[] = [];
    const decisions: SignedUrlDecision[] = [];

    for (const item of items) {
      const image = imageById.get(item.imageId);
      const asset = image === undefined ? undefined : assetById.get(String(image.assetId));
      const decision = authorizeSignedUrlItem({
        kind: item.kind,
        caller,
        matched: matchedIds.has(item.imageId),
        originalsAllowed,
        // An image whose asset row is gone has nothing to sign: out of scope.
        image:
          image === undefined || asset === undefined
            ? null
            : { hidden: image.visibility === "hidden" },
      });
      decisions.push(decision);

      if (!decision.allowed) {
        if (decision.code === undefined) {
          // A denial without a code would be an unpinned wire value; refuse it.
          throw appError("internal_error");
        }
        denied.push({ imageId: item.imageId, kind: item.kind, code: decision.code });
        continue;
      }
      if (asset === undefined) {
        throw appError("internal_error");
      }
      const signed = signer.sign({
        kind: item.kind,
        contentHash: asset.contentHash,
        ext: extensionOf(item.kind, asset),
      });
      urls.push({
        imageId: item.imageId,
        kind: item.kind,
        url: signed.url,
        expiresAt: signed.expiresAt,
      });
    }

    if (signedUrlBatchStatus(decisions) === 403) {
      throw appError("forbidden");
    }

    return { body: { urls, denied } };
  },
});
