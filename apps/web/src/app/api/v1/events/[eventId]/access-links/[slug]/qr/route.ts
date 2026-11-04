import { createHash } from "node:crypto";

import type { Document } from "mongodb";
import { z } from "zod";

import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { loadEventRow, requirePrincipal, resolveEventActorRole } from "@/server/events/access";
import { renderQrCode } from "@/server/events/access-link-qr";
import {
  buildQrPayloadUrl,
  parseQrQuery,
  QR_FORMATS,
  type QrQuery,
} from "@/server/events/access-links";
import { eventIdFromRequest } from "@/server/events/event-id";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { createMediaSigner, type SignedMediaUrl } from "@/server/media/signer";
import { platformRepo, type RepositoryCollection } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { getObjectStorage } from "@/server/storage/get-object-storage";
import { buildObjectKey } from "@/server/storage/object-key";
import { userAuth } from "@/server/tenancy/route-scope";

/**
 * `GET /api/v1/events/{eventId}/access-links/{slug}/qr` — download a QR code
 * for one event link (OP-118 §2, contract §4.2, schema §16.1; ADR-0620).
 *
 * The QR image is generated **once** per `(slug, format, size)`: the bytes are
 * content-addressed (lowercase SHA-256), stored under the `exports` location
 * and recorded as a `mediaAssets` row with `kind: "export"`, so a repeat
 * download is a cache hit — one stored object, one row, and the same signed URL
 * (including its `exp`), which is what keeps the answer byte-identical.
 *
 * The answer is the redirect-free §4.2 body `{ url, expiresAt, format, size }`:
 * the URL is signed for the `export` derivative with the media data plane's
 * secret, and the control plane never streams the bytes itself (§5.6–§5.7).
 *
 * Every **event member** may download (organizer, co-organizer or tenant
 * member, §4.2 "event member"); an unrelated caller gets `404` and generates
 * nothing, an unauthenticated one `401`. A slug that exists but was rotated away
 * answers `410 access_link_revoked` (the card's §3 decision, ADR-0620 §A6), and
 * a query outside `png|svg|pdf` × `256..2048` is a `422 validation_failed`
 * naming the offending parameter.
 *
 * ## Path decision
 *
 * Global `/api/v1/events/{eventId}` family, like this lane's other event routes
 * (ADR-0580 §D1, ADR-0620).
 */

/** The fields of one stored `mediaAssets` row this route reads and writes. */
interface QrAssetRow {
  readonly contentHash?: string;
  readonly qrCacheKey?: string;
  readonly qrUrl?: string;
  readonly qrExpiresAt?: string;
}

/** The stored `events` row fields this route needs. */
interface EventQrRow {
  readonly tenantId: string;
  readonly accessLinks?: readonly {
    readonly slug: string;
    readonly active: boolean;
  }[];
}

/** The §4.2 QR download answer schema — exactly these four keys. */
const qrResponseSchema = z.object({
  url: z.string(),
  expiresAt: z.string(),
  format: z.enum(QR_FORMATS),
  size: z.number().int(),
});

/** The §4.2 answer body. */
type QrResponse = z.infer<typeof qrResponseSchema>;

/** The path segment one position before `qr` is the link's slug. */
const SLUG_SEGMENT_FROM_END = 2;

/** The event id sits four segments before the end (`…/{eventId}/access-links/{slug}/qr`). */
const EVENT_ID_SEGMENT_FROM_END = 4;

/**
 * Read the `{slug}` segment off the request path.
 *
 * The pipeline never exposes Next's `params`, so a dynamic route reads its own
 * segments — the same convention `eventIdFromRequest` follows.
 *
 * @param request - The inbound request.
 * @returns The raw slug segment.
 */
function slugFromRequest(request: Request): string {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  return String(segments.at(-SLUG_SEGMENT_FROM_END));
}

/**
 * The still-valid cached signed URL of a stored QR asset, if it has one.
 *
 * Minting a fresh URL would move `exp` and break the byte-identical repeat
 * answer, so the URL is minted once per asset and reused until it expires.
 *
 * @param row - The stored asset row.
 * @param now - The request instant.
 * @returns The cached URL, or `undefined` when absent or expired.
 */
function cachedSignedUrl(row: QrAssetRow, now: Date): SignedMediaUrl | undefined {
  if (row.qrUrl === undefined || row.qrExpiresAt === undefined) {
    return undefined;
  }
  return Date.parse(row.qrExpiresAt) > now.getTime()
    ? { url: row.qrUrl, expiresAt: row.qrExpiresAt }
    : undefined;
}

/** MongoDB's duplicate-key server error code (a unique index rejected an insert). */
const DUPLICATE_KEY = 11000;

/**
 * True when `error` is MongoDB's duplicate-key error.
 *
 * @param error - The thrown value.
 * @returns Whether the unique index refused the write.
 */
function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === DUPLICATE_KEY
  );
}

/**
 * The render-free identity of one cached QR asset.
 *
 * The bytes' identity is their SHA-256, but deriving it would mean rendering
 * first — the very work the cache exists to avoid. The request identity
 * `(eventId, slug, format, size)` addresses the cache row instead, and the row
 * still stores the content hash that names the object (ADR-0623).
 *
 * @param eventId - The event the link belongs to.
 * @param slug - The link's slug.
 * @param query - The validated format and edge length.
 * @returns The row's `qrCacheKey`.
 */
function qrAssetCacheKey(eventId: string, slug: string, query: QrQuery): string {
  return `${eventId}:${slug}:${query.format}:${String(query.size)}`;
}

/**
 * Upsert the `export` cache row, absorbing the unique-index race.
 *
 * A first-time pair of requests can both miss and both insert; one wins and the
 * loser's upsert surfaces `E11000` from
 * `media_assets_tenant_content_hash_unique`. Retrying once reconciles against
 * the winner's row, whose write the filter now matches. If the `(tenantId,
 * contentHash)` slot is instead held by a row of another `kind`, the retry also
 * loses it: the bytes are still served with their signed URL, only the QR cache
 * row cannot be written (ADR-0623).
 *
 * @param assets - The `mediaAssets` collection handle.
 * @param filter - The natural-key filter.
 * @param update - The `$setOnInsert` / `$set` update document.
 */
async function upsertQrExportAsset(
  assets: RepositoryCollection,
  filter: Document,
  update: Document
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await assets.findOneAndUpdate(filter, update, { upsert: true });
      return;
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
    }
  }
}

export const GET = defineRoute({
  route: "/api/v1/events/:eventId/access-links/:slug/qr",
  response: qrResponseSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  handler: async (ctx): Promise<{ body: QrResponse }> => {
    const principal = requirePrincipal(ctx);
    const db = getDb();
    const config = getConfig();
    const now = systemClock.now();
    const eventId = eventIdFromRequest(ctx.request, { segmentFromEnd: EVENT_ID_SEGMENT_FROM_END });
    const slug = slugFromRequest(ctx.request);
    const row = await loadEventRow<EventQrRow>(db, eventId);

    // Every event member may download the QR; a caller with no relationship is
    // refused with `404`, never a cross-tenant existence oracle (contract §0.4).
    if ((await resolveEventActorRole(db, eventId, row.tenantId, principal)) === null) {
      throw appError("not_found");
    }

    const link = row.accessLinks?.find((candidate) => candidate.slug === slug);
    if (link === undefined) {
      throw appError("not_found");
    }

    const query = parseQrQuery(new URL(ctx.request.url).searchParams);

    if (!link.active) {
      throw appError("access_link_revoked", {
        details: { message: "This access link was rotated and can no longer be used." },
      });
    }

    const assets = platformRepo(db).collection(COLLECTIONS.mediaAssets);

    // The render-free cache read comes first: a valid stored URL ends the
    // request here, so a repeat download pays neither the `qrcode` render (nor
    // a PDF's `pdf-lib` embed) nor the signing — the cache hides the work, not
    // only the write (ADR-0623).
    const cacheKey = qrAssetCacheKey(eventId.toHexString(), slug, query);
    const cachedRow = (await assets.findOne({
      tenantId: row.tenantId,
      kind: "export",
      qrCacheKey: cacheKey,
    })) as QrAssetRow | null;
    const cached = cachedRow === null ? undefined : cachedSignedUrl(cachedRow, now);
    if (cached !== undefined) {
      return {
        body: {
          url: cached.url,
          expiresAt: cached.expiresAt,
          format: query.format,
          size: query.size,
        },
      };
    }

    const rendered = await renderQrCode(buildQrPayloadUrl(config.app.baseUrl, slug), query);
    const contentHash = createHash("sha256").update(rendered.bytes).digest("hex");

    // The object is written only on a miss: the content hash is the bytes'
    // identity, so a repeat download of the same `(eventId, slug, format, size)`
    // stores nothing. A changed cache key over unchanged bytes (a row that
    // predates the key) still reuses the stored object and its signed URL.
    const existing = (await assets.findOne({
      tenantId: row.tenantId,
      kind: "export",
      contentHash,
    })) as QrAssetRow | null;
    if (existing === null) {
      await getObjectStorage().putObject(
        "exports",
        buildObjectKey(contentHash, rendered.extension),
        rendered.bytes,
        rendered.contentType
      );
    }

    const signer = createMediaSigner({
      currentSecret: config.media.signingSecretCurrent,
      ...(config.media.signingSecretPrevious === undefined
        ? {}
        : { previousSecret: config.media.signingSecretPrevious }),
    });
    const signed =
      (existing === null ? undefined : cachedSignedUrl(existing, now)) ??
      signer.sign({ kind: "export", contentHash, ext: rendered.extension });

    await upsertQrExportAsset(
      assets,
      { tenantId: row.tenantId, kind: "export", contentHash },
      {
        $setOnInsert: {
          tenantId: row.tenantId,
          contentHash,
          kind: "export",
          qrCacheKey: cacheKey,
          createdAt: now,
        },
        $set: { qrUrl: signed.url, qrExpiresAt: signed.expiresAt },
      }
    );

    return {
      body: {
        url: signed.url,
        expiresAt: signed.expiresAt,
        format: query.format,
        size: query.size,
      },
    };
  },
});
