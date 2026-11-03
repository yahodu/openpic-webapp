import { createHash } from "node:crypto";

import { z } from "zod";

import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { loadEventRow, requirePrincipal, resolveEventActorRole } from "@/server/events/access";
import { renderQrCode } from "@/server/events/access-link-qr";
import { buildQrPayloadUrl, parseQrQuery, QR_FORMATS } from "@/server/events/access-links";
import { eventIdFromRequest } from "@/server/events/event-id";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { createMediaSigner, type SignedMediaUrl } from "@/server/media/signer";
import { platformRepo } from "@/server/repos";
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

    const rendered = await renderQrCode(buildQrPayloadUrl(config.app.baseUrl, slug), query);
    const contentHash = createHash("sha256").update(rendered.bytes).digest("hex");
    const assets = platformRepo(db).collection(COLLECTIONS.mediaAssets);

    // The object is written only on a miss: the content hash is the cache key,
    // so a repeat download of the same `(slug, format, size)` stores nothing.
    const existing = (await assets.findOne({
      tenantId: row.tenantId,
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
    const cached = existing === null ? undefined : cachedSignedUrl(existing, now);
    const signed = cached ?? signer.sign({ kind: "export", contentHash, ext: rendered.extension });

    await assets.findOneAndUpdate(
      { tenantId: row.tenantId, contentHash },
      {
        $setOnInsert: {
          tenantId: row.tenantId,
          contentHash,
          kind: "export",
          createdAt: now,
        },
        $set: { qrUrl: signed.url, qrExpiresAt: signed.expiresAt },
      },
      { upsert: true }
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
