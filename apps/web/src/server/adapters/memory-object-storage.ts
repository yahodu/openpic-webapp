import { randomUUID } from "node:crypto";

import { AppError } from "@/server/http/app-error";
import { registerMemoryPresign } from "@/server/storage/memory-presigns";
import type { ObjectHead, ObjectStorage, PresignedPut } from "@/server/storage/object-storage";

/**
 * The in-memory storage adapter (OP-112, ADR-0520 §6; OP-124, ADR-0721 D6).
 *
 * The adapter an e2e boot selects (CONVENTIONS §6 — dev/prod parity), and the
 * one place the port's byte-level contract can be pinned without a network:
 * what was written is what comes back, a range read returns exactly the
 * requested bytes, and a read of something the location does not hold is the
 * same `not_found` refusal the R2 adapter answers for a `HeadObject` 404.
 *
 * Each factory call returns a fresh, isolated store; the same object key in
 * another location is a different object. Undriven port methods refuse with
 * `AppError("not_implemented")` — the surface is complete, each behaviour
 * arrives with the lane's tests (ADR-0520 §2).
 *
 * A presigned `PUT` is an **opaque token** URL on the app's own origin: the
 * e2e client uploads from another process, so the URL must be `PUT`-able over
 * HTTP and must spell out no hash, bucket or key (§0.15). The token is
 * redeemed through `@/server/storage/memory-presigns` inside the test-support
 * route, which writes into the very store that minted it.
 */

/** One stored object's bytes and declared content type. */
interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/** Construction options for {@link memoryObjectStorage}. */
export interface MemoryObjectStorageOptions {
  /** The app origin a presigned PUT URL is minted on. */
  readonly baseUrl: string;
}

/** The `not_implemented` refusal for a port method no lane drives yet. */
function notImplemented(): Promise<never> {
  return Promise.reject(new AppError("not_implemented"));
}

/**
 * Build an isolated in-memory object store keyed by `(locationKey, objectKey)`.
 *
 * @param options - The app origin presigned PUT URLs are minted on. Without
 *   one the URLs are relative, which only a caller that never `PUT`s can use.
 * @returns A fresh `ObjectStorage` with no shared state.
 */
export function memoryObjectStorage(
  options: MemoryObjectStorageOptions = { baseUrl: "" }
): ObjectStorage {
  const store = new Map<string, StoredObject>();
  const storeKey = (locationKey: string, objectKey: string): string =>
    `${locationKey}\u0000${objectKey}`;

  return {
    presignPut(locationKey, objectKey, contentType, ttlSeconds): Promise<PresignedPut> {
      const token = randomUUID();
      const expiresAtMs = Date.now() + ttlSeconds * 1000;
      registerMemoryPresign(token, {
        contentType,
        expiresAtMs,
        write: (bytes) => store.set(storeKey(locationKey, objectKey), { bytes, contentType }),
      });
      return Promise.resolve({
        method: "PUT",
        url: `${options.baseUrl}/api/v1/test-support/storage/${token}`,
        headers: { "content-type": contentType },
        expiresAt: new Date(expiresAtMs).toISOString(),
      });
    },
    createMultipart: () => notImplemented(),
    presignPart: () => notImplemented(),
    listParts: () => notImplemented(),
    completeMultipart: () => notImplemented(),
    abortMultipart: () => notImplemented(),

    headObject(locationKey, objectKey): Promise<ObjectHead> {
      const entry = store.get(storeKey(locationKey, objectKey));
      if (entry === undefined) {
        return Promise.reject(new AppError("not_found"));
      }
      return Promise.resolve({
        bytes: entry.bytes.byteLength,
        contentType: entry.contentType,
        etag: `"${String(entry.bytes.byteLength)}"`,
      });
    },

    getObjectStream: () => notImplemented(),

    putObject(locationKey, objectKey, body, contentType): Promise<void> {
      store.set(storeKey(locationKey, objectKey), { bytes: body, contentType });
      return Promise.resolve();
    },

    deleteObject(locationKey, objectKey): Promise<void> {
      store.delete(storeKey(locationKey, objectKey));
      return Promise.resolve();
    },

    getObject(locationKey, objectKey): Promise<Uint8Array> {
      const entry = store.get(storeKey(locationKey, objectKey));
      if (entry === undefined) {
        return Promise.reject(new AppError("not_found"));
      }
      return Promise.resolve(entry.bytes);
    },

    getObjectRange(locationKey, objectKey, { start, end }): Promise<Uint8Array> {
      const entry = store.get(storeKey(locationKey, objectKey));
      if (entry === undefined) {
        return Promise.reject(new AppError("not_found"));
      }
      // S3 `Range: bytes=<start>-<end>` semantics: both ends are inclusive,
      // so `{ start: 2, end: 5 }` over `0123456789` is `2345`.
      return Promise.resolve(entry.bytes.slice(start, end + 1));
    },
  };
}
