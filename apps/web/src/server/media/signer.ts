/**
 * The path-bound HMAC media URL signer (OP-113; API Contract §5.6–§5.7, media
 * doc §8).
 *
 * The media data plane (`pic.openpic.in`) is a Cloudflare Worker kept out of
 * the byte path of the control plane: the platform signs a URL here and the
 * Worker authorizes delivery purely from the URL. The signature scheme (§5.7)
 * is
 *
 * ```
 * payload   = METHOD + "\n" + PATH + "\n" + EXPIRY
 * signature = base64url(HMAC-SHA256(secret, payload))
 * ```
 *
 * where `PATH` is the URL **pathname** only (never the query) and `EXPIRY` is
 * the decimal `?exp=` value verbatim, so a one-character change to the path, a
 * token replayed on the wrong derivative segment, a changed method or an
 * expired `exp` all recompute to a different signature.
 *
 * This module is **pure**: it reads no environment at import. Secrets and the
 * clock are injected through {@link createMediaSigner}; the composition root
 * decides where the current/previous secrets come from.
 */
import { hmacSha256Base64Url, timingSafeEqualStr } from "@/server/runtime/crypto";
import { systemClock, type Clock } from "@/server/runtime/clock";

/** The closed vocabulary of derivable media forms the signer knows. */
export type MediaDerivativeKind = "thumbnail" | "original" | "export" | "preview";

/** The inputs that uniquely identify one deliverable path on the data plane. */
export interface SignMediaInput {
  readonly kind: MediaDerivativeKind;
  readonly contentHash: string;
  readonly ext: string;
}

/** The §5.6 envelope a `sign` call returns. */
export interface SignedMediaUrl {
  readonly url: string;
  readonly expiresAt: string;
}

/** Injection points for {@link createMediaSigner}. */
export interface MediaSignerConfig {
  readonly currentSecret: string;
  readonly previousSecret?: string;
  readonly clock?: Clock;
}

/** The sign/verify surface used to mint and authorize media delivery URLs. */
export interface MediaSigner {
  sign(input: SignMediaInput, ttlSeconds?: number): SignedMediaUrl;
  verify(url: string, method?: string): boolean;
}

/** Default URL lifetimes per derivative kind (§5.6, media doc §8). */
export const MEDIA_URL_TTL_SECONDS: Readonly<Record<MediaDerivativeKind, number>> = {
  thumbnail: 24 * 60 * 60, // 24 h — never inverted with original
  original: 15 * 60, // 15 min
  preview: 2 * 60 * 60, // strictly between thumbnail and original
  export: 15 * 60, // full-size output; the card names no export TTL
};

/** The fixed data-plane base (§5.7 — precisely one host the Worker fronts). */
const BASE_URL = "https://pic.openpic.in";

interface KindDerivative {
  /** The single-letter data-plane path segment for this kind. */
  readonly segment: string;
  /** This kind's default URL lifetime, when `sign` omits an explicit TTL. */
  readonly ttlSeconds: number;
}

/**
 * Resolve the data-plane segment and default TTL for a derivative kind.
 *
 * §5.7 defines exactly `{t|o}`; preview sits on `/p/` and export shares the
 * originals segment (there is no `/e/`).
 *
 * @param kind - A derivative kind. Anything outside the closed vocabulary is
 *   rejected by the thrown error rather than silently mis-signed.
 * @returns The segment and default TTL.
 */
function derivativeForKind(kind: MediaDerivativeKind): KindDerivative {
  switch (kind) {
    case "thumbnail":
      return { segment: "t", ttlSeconds: MEDIA_URL_TTL_SECONDS.thumbnail };
    case "original":
      return { segment: "o", ttlSeconds: MEDIA_URL_TTL_SECONDS.original };
    case "export":
      return { segment: "o", ttlSeconds: MEDIA_URL_TTL_SECONDS.export };
    case "preview":
      return { segment: "p", ttlSeconds: MEDIA_URL_TTL_SECONDS.preview };
  }
}

/** `GET` is the only method the data plane serves (§5.7). */
const DEFAULT_METHOD = "GET";

/**
 * Build a media URL signer.
 *
 * @param config - The injected secrets, optional previous (rotating) secret and
 *   optional clock. `clock` defaults to {@link systemClock}.
 * @returns A {@link MediaSigner} bound to the given secrets and clock.
 */
export function createMediaSigner(config: MediaSignerConfig): MediaSigner {
  const { currentSecret, previousSecret } = config;
  const clock = config.clock ?? systemClock;

  /**
   * Compute the exact signature for a path/method/expiry under one secret.
   *
   * @param secret - The key to HMAC with.
   * @param method - The HTTP method in the preimage.
   * @param path - The URL pathname.
   * @param exp - The decimal `?exp=` value.
   * @returns The base64url HMAC-SHA256 signature.
   */
  const signWith = (secret: string, method: string, path: string, exp: string): string =>
    hmacSha256Base64Url(secret, `${method}\n${path}\n${exp}`);

  return {
    sign(input, ttlSeconds) {
      const kind = input.kind;
      if (!(kind in MEDIA_URL_TTL_SECONDS)) {
        throw new Error(`unknown media derivative kind: ${kind}`);
      }

      const { segment, ttlSeconds: kindDefaultTtl } = derivativeForKind(kind);
      const ttl = ttlSeconds ?? kindDefaultTtl;
      const exp = Math.floor(clock.now().getTime() / 1000) + ttl;
      const path = `/${segment}/${input.contentHash}.${input.ext}`;
      const expStr = String(exp);
      const sig = signWith(currentSecret, DEFAULT_METHOD, path, expStr);

      return {
        url: `${BASE_URL}${path}?exp=${expStr}&sig=${sig}`,
        expiresAt: new Date(exp * 1000).toISOString(),
      };
    },

    verify(url, method = DEFAULT_METHOD) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return false;
      }

      const expParam = parsed.searchParams.get("exp");
      const sigParam = parsed.searchParams.get("sig");
      if (expParam === null || sigParam === null) {
        return false;
      }

      const exp = Number(expParam);
      if (!Number.isFinite(exp)) {
        return false;
      }

      const nowSeconds = Math.floor(clock.now().getTime() / 1000);
      if (nowSeconds >= exp) {
        return false;
      }

      const path = parsed.pathname;
      const expectedCurrent = signWith(currentSecret, method, path, expParam);
      const matchesProvided = timingSafeEqualStr(expectedCurrent, sigParam);
      if (matchesProvided) {
        return true;
      }

      if (previousSecret !== undefined) {
        const expectedPrevious = signWith(previousSecret, method, path, expParam);
        return timingSafeEqualStr(expectedPrevious, sigParam);
      }

      return false;
    },
  };
}
