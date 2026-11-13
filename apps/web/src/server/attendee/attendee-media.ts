import { getConfig } from "@/server/config/env";
import { createMediaSigner, MEDIA_URL_TTL_SECONDS, type MediaSigner } from "@/server/media/signer";

/**
 * The attendee surface's media signing (OP-133; contract §5.6–§5.7, §6.5–§6.6;
 * ADR-0794 §4).
 *
 * Three routes (the gallery, the poll's selfie tile and the original/preview
 * requests) mint URLs against the same data plane, so the signer and the
 * extension rules live here once instead of three times.
 */

/** The subtype a content type maps to, where the data plane uses another one. */
const EXTENSION_ALIASES: Readonly<Record<string, string>> = { jpeg: "jpg" };

/** The derivative kinds an attendee image is signed as (§5.7). */
export type AttendeeMediaKind = "thumbnail" | "original" | "preview";

/** The `media_assets` fields a signed URL is built from (§16.1). */
export interface SignableAsset {
  readonly contentHash: string;
  readonly storage?: { readonly contentType?: string } | null;
  readonly derivatives?: { readonly thumbnail?: { readonly format?: string } } | null;
}

/**
 * A signer bound to the app's current (and, while rotating, previous) secret.
 *
 * @returns The media signer the attendee routes mint URLs with.
 */
export function attendeeMediaSigner(): MediaSigner {
  const config = getConfig();
  return createMediaSigner({
    currentSecret: config.media.signingSecretCurrent,
    ...(config.media.signingSecretPrevious === undefined
      ? {}
      : { previousSecret: config.media.signingSecretPrevious }),
  });
}

/**
 * The data-plane extension of one derivative.
 *
 * A thumbnail's recorded format is authoritative; an original or a preview
 * addresses the stored bytes, so its extension comes from the asset's content
 * type (`image/jpeg` is `.jpg` on the data plane).
 *
 * @param kind - The derivative being signed.
 * @param asset - The stored asset.
 * @returns The extension, never empty.
 */
export function attendeeMediaExtension(kind: AttendeeMediaKind, asset: SignableAsset): string {
  if (kind === "thumbnail") {
    return asset.derivatives?.thumbnail?.format ?? "webp";
  }
  const subtype = asset.storage?.contentType?.split("/")[1] ?? "jpg";
  return EXTENSION_ALIASES[subtype] ?? subtype;
}

/** The §6.6 signed-URL answer. */
export interface SignedUrlAnswer {
  readonly url: string;
  readonly expiresAt: string;
  readonly ttlSeconds: number;
}

/**
 * Sign one derivative and answer it in the §6.6 envelope.
 *
 * `?exp=` is whole Unix seconds and the shipped signer floors it (§5.7, pinned
 * by OP-128), so a token signed for exactly `ttlSeconds` can retire up to 999 ms
 * **before** the instant §6.6 promises the client. The token is therefore minted
 * one second longer while `ttlSeconds` keeps advertising the nominal life, so the
 * URL never dies before the `expiresAt` this answer states — and `expiresAt`
 * itself is `now + ttlSeconds`, the instant a client must refetch at (I5
 * brackets it against the request's own clock reads).
 *
 * @param kind - The derivative to sign.
 * @param asset - The stored asset.
 * @param now - The instant the answer is computed at.
 * @returns The URL, the stated expiry and the TTL it advertises.
 */
export function signAttendeeMedia(
  kind: AttendeeMediaKind,
  asset: SignableAsset,
  now: Date
): SignedUrlAnswer {
  const ttlSeconds = MEDIA_URL_TTL_SECONDS[kind];
  const signed = attendeeMediaSigner().sign(
    {
      kind,
      contentHash: asset.contentHash,
      ext: attendeeMediaExtension(kind, asset),
    },
    ttlSeconds + 1
  );
  return {
    url: signed.url,
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    ttlSeconds,
  };
}
