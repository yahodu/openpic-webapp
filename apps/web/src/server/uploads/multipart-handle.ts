import { getConfig } from "@/server/config/env";
import { AppError } from "@/server/http/app-error";
import { appError } from "@/server/http/errors";
import {
  createHandleService,
  type HandleService,
  type ResolvedHandle,
} from "@/server/storage/handles";

/**
 * The multipart surface's handle binding (OP-125 U2, contract §5.4; ADR-0741).
 *
 * Every call after `create` carries the opaque `key` the create answer minted,
 * and the handle service already verifies its signature and its user binding.
 * Two things are left to the surface: the token must be bound to **one upload
 * session** (without it a client holding two uploads could sign parts into the
 * other upload's object key), and every refusal must be `404`, never the
 * service's `400` — a token that does not prove ownership has to be
 * indistinguishable from an upload id that does not exist, or the endpoint
 * becomes an oracle for which ids are real.
 */

/** The secret the surface's handles are signed with (the media signer's own). */
export function getHandleService(): HandleService {
  // Memoized: the service's registry is what turns an opaque token back into an
  // object key, so `create` and a later `sign` must share one instance.
  cachedHandleService ??= createHandleService({
    secret: getConfig().media.signingSecretCurrent,
  });
  return cachedHandleService;
}

/** The one instance a process resolves handles through. */
let cachedHandleService: HandleService | undefined;

/** The inputs one resolution reads. */
export interface ResolveMultipartHandleInput {
  /** The handle service the deployment signs with. */
  readonly service: HandleService;
  /** The opaque `key` the client presented. */
  readonly handle: string;
  /** The authenticated caller presenting it. */
  readonly presentingUserId: string;
  /** **Our** upload session id, not the provider's upload id. */
  readonly uploadSessionId: string;
}

/**
 * Verify a multipart handle against its presenter and its session.
 *
 * @param input - The service, the token, the presenter and the session.
 * @returns The neutral `{ locationKey, objectKey, uploadSessionId }` resolution.
 * @throws {AppError} `not_found` (404) for every refusal — a foreign presenter,
 *   an edited signature, a token from another secret, a malformed token or a
 *   token minted for a different session.
 */
export function resolveMultipartHandle(input: ResolveMultipartHandleInput): ResolvedHandle {
  let resolved: ResolvedHandle;
  try {
    resolved = input.service.resolveHandle(input.handle, input.presentingUserId);
  } catch (error: unknown) {
    // The service refuses with `bad_request`; the multipart surface publishes
    // one uniform `404`, so an unknown id and a forged token look the same.
    if (error instanceof AppError) {
      throw appError("not_found");
    }
    throw error;
  }
  if (resolved.uploadSessionId !== input.uploadSessionId) {
    throw appError("not_found");
  }
  return resolved;
}
