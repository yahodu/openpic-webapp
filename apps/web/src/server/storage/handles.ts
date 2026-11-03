import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { ConfigError } from "@/server/config/env";
import { AppError } from "@/server/http/app-error";
import { isStorageLocationKey, type StorageLocationKey } from "@/server/storage/locations";

/**
 * The opaque upload handle service (OP-112, ADR-0520 §5).
 *
 * The multipart API hands Uppy a `key` it passes back on every later call, so
 * the handle is the *only* thing that crosses the client boundary. It is a
 * signed, tamper-evident token bound to the user and upload session that own
 * it — a handle leak is **not** a key leak, because the object key and the
 * logical location behind it are unrecoverable from the token itself.
 *
 * The token is `payload.signature` (a JWT-segment shape): the payload is the
 * base64url of a claim set carrying the issuing `userId`, `uploadSessionId`
 * and a random nonce — never the object key — and the signature is an
 * HMAC-SHA256 of the exact payload bytes under the service's secret. Every
 * refusal is the same observable: `resolveHandle` **throws `AppError`** rather
 * than answering a location it cannot prove the presenter owns.
 *
 * The object key cannot live inside the token (its opacity is the point), so
 * the service resolves it from a per-instance registry keyed by the issued
 * token. A later lane that needs handles to survive a process restart moves
 * this registry behind a shared store (Redis); the refusal surface is
 * identical either way.
 */

/** The claims a handle's payload carries (all non-secret, all client-safe). */
interface HandleClaims {
  /** The issuing user — the presentation is checked against this. */
  readonly sub: string;
  /** The upload session the handle was minted for. */
  readonly usid: string;
  /** The logical location the object lives in (§11.2). */
  readonly loc: string;
  /** A per-issue random nonce, so two issues never mint the same token. */
  readonly jti: string;
}

/** What the registry holds for a token: the claims' server-side truth. */
interface StoredHandle {
  readonly locationKey: string;
  readonly objectKey: string;
  readonly uploadSessionId: string;
  readonly userId: string;
}

/** What `issueHandle` accepts. */
export interface IssueHandleInput {
  readonly locationKey: StorageLocationKey;
  readonly objectKey: string;
  readonly uploadSessionId: string;
  readonly userId: string;
}

/** What a verified resolution answers — exactly three neutral keys. */
export interface ResolvedHandle {
  readonly locationKey: string;
  readonly objectKey: string;
  readonly uploadSessionId: string;
}

/** The service surface. */
export interface HandleService {
  /** Mint a handle; throws `ConfigError` for a location outside §11.2. */
  issueHandle(input: IssueHandleInput): string;
  /** Verify the handle and the presenter's right to it; else throws `AppError`. */
  resolveHandle(handle: string, presentingUserId: string): ResolvedHandle;
}

/** The one refusal observable in the contract: a `bad_request` `AppError`. */
const INVALID_HANDLE_CODE = "bad_request" as const;

/** Base64url-encode a JSON value, the JWT payload segment. */
function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/**
 * Create a handle service bound to one signing secret.
 *
 * @param secret - The HMAC key every issued token is signed with. A handle
 * presented to a service with a different secret is refused.
 * @returns The service.
 */
export function createHandleService({ secret }: { readonly secret: string }): HandleService {
  const registry = new Map<string, StoredHandle>();

  /** The MAC over the exact payload bytes (constant-time verified on resolve). */
  function mac(payloadSegment: string): Buffer {
    return createHmac("sha256", secret).update(payloadSegment, "utf8").digest();
  }

  return {
    issueHandle(input) {
      // Widen before the guard so a refused location is still nameable: the
      // type predicate narrows `locationKey` to `never` on its falsy branch,
      // and the ConfigError must name the offending value.
      const locationKey: string = input.locationKey;
      if (!isStorageLocationKey(locationKey)) {
        // A handle is never minted for a location that cannot resolve to a
        // bucket (ADR-0520 §5): `videos` is not a §11.2 location.
        throw new ConfigError([`storage.location.${locationKey}`]);
      }
      const claims: HandleClaims = {
        sub: input.userId,
        usid: input.uploadSessionId,
        loc: locationKey,
        jti: randomBytes(18).toString("base64url"),
      };
      const payloadSegment = encodeSegment(claims);
      const token = `${payloadSegment}.${mac(payloadSegment).toString("base64url")}`;
      registry.set(token, {
        locationKey: input.locationKey,
        objectKey: input.objectKey,
        uploadSessionId: input.uploadSessionId,
        userId: input.userId,
      });
      return token;
    },

    resolveHandle(handle, presentingUserId) {
      // A non-string is never a handle.
      if (typeof handle !== "string") {
        throw new AppError(INVALID_HANDLE_CODE);
      }
      const separator = handle.indexOf(".");
      // A handle is exactly `payload.signature`; anything else is refused, so
      // a random string cannot be coerced into a resolution.
      if (separator === -1) {
        throw new AppError(INVALID_HANDLE_CODE);
      }
      const payloadSegment = handle.slice(0, separator);
      const signatureSegment = handle.slice(separator + 1);
      if (payloadSegment.length === 0 || signatureSegment.length === 0) {
        throw new AppError(INVALID_HANDLE_CODE);
      }

      // Verify the MAC over the exact payload bytes *before* trusting anything
      // in the token — an edit to the trailing signature character must be
      // refused even though the payload is intact.
      const expected = mac(payloadSegment);
      const provided = Buffer.from(signatureSegment, "base64url");
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        throw new AppError(INVALID_HANDLE_CODE);
      }

      const stored = registry.get(handle);
      // A handle this service never issued (including one signed with another
      // secret) has no registry entry.
      if (stored === undefined) {
        throw new AppError(INVALID_HANDLE_CODE);
      }
      // The token is bound to the issuing user; a different presenter is
      // refused rather than served the object key.
      if (stored.userId !== presentingUserId) {
        throw new AppError(INVALID_HANDLE_CODE);
      }

      return {
        locationKey: stored.locationKey,
        objectKey: stored.objectKey,
        uploadSessionId: stored.uploadSessionId,
      };
    },
  };
}
