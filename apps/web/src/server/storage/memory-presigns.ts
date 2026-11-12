/**
 * The in-memory adapter's presigned-PUT registry (OP-124, ADR-0721 D6).
 *
 * The port has no "redeem a presign" method and must not gain one: this
 * registry is the adapter's private bookkeeping, kept in its own module so the
 * test-only `PUT` route can redeem a token without importing an adapter (route
 * handlers depend on services, not adapters — the import boundary in
 * `eslint.config.mjs`). Each entry holds a write-back closure into the store
 * that minted the token, so instances stay isolated from one another.
 */

/** A minted presigned PUT: how it writes, and when it stops. */
interface PresignedWriteback {
  readonly expiresAtMs: number;
  /** Writes the client's bytes into the store that minted the token. */
  readonly write: (bytes: Uint8Array) => void;
}

/** Presigned PUTs awaiting a client, keyed by their opaque token. */
const presignedWrites = new Map<string, PresignedWriteback>();

/**
 * Record a presigned PUT so its token can be redeemed once.
 *
 * @param token - The opaque token the URL carries.
 * @param writeback - The expiry and the store's writer.
 */
export function registerMemoryPresign(
  token: string,
  writeback: {
    readonly expiresAtMs: number;
    readonly write: (bytes: Uint8Array) => void;
  }
): void {
  presignedWrites.set(token, writeback);
}

/**
 * Redeem a presigned-PUT token.
 *
 * @param token - The opaque token from the presigned URL's last path segment.
 * @returns The store's writer, or `null` for an unknown, already-redeemed or
 *   expired token (the route answers `404`, exactly as an expired S3 signature
 *   does).
 */
export function claimMemoryPresign(token: string): ((bytes: Uint8Array) => void) | null {
  const entry = presignedWrites.get(token);
  if (entry === undefined) {
    return null;
  }
  presignedWrites.delete(token);
  if (entry.expiresAtMs <= Date.now()) {
    return null;
  }
  return entry.write;
}
