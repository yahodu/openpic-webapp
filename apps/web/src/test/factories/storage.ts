/**
 * Object-storage fixtures (OP-112, CONVENTIONS §3).
 *
 * The R2 adapter takes an **explicit** {@link R2ObjectStorageConfig} rather than
 * reading the environment (the `createCashfreeProvider` shape, OP-105), so a spec
 * can build one with no process env at all. The literals here are deliberately
 * low-entropy test strings — never a credential shape the secret scanner
 * (`gitleaks`, `secret-scan` in `ci.yml`) would flag.
 *
 * The bucket names are **not** the logical `locationKey`s on purpose: the whole
 * point of §11.2 is that a stored document names `"originals"` while the
 * physical bucket is a deployment detail that can move. A bucket called
 * `openpic-originals` would make the "the logical key never reaches the URL"
 * assertion vacuous, so the mapping is deliberately opaque.
 */
import type { R2ObjectStorageConfig } from "@/server/adapters/r2/r2-object-storage";

/** The S3-compatible endpoint every R2 fixture talks to (MSW intercepts it). */
export const TEST_STORAGE_ENDPOINT = "https://r2.test.invalid";

/** The HMAC secret every handle fixture is keyed with. Low entropy, on purpose. */
export const TEST_HANDLE_SECRET = "test-handle-signing-secret";

/** The user a fixture handle is bound to. */
export const TEST_HANDLE_USER_ID = "user_handle_owner_001";

/** A different user — the one a bound handle must refuse. */
export const TEST_OTHER_USER_ID = "user_handle_other_002";

/** One upload session id, shared by the handle fixtures. */
export const TEST_UPLOAD_SESSION_ID = "6705cc0000000000000000aa";

/** A lowercase hex SHA-256 — the only content-hash shape the key builder admits. */
export const TEST_CONTENT_HASH = "3f2c1d8899aa55bb66cc77dd88ee99ff00112233445566778899aabbccddeeff";

/** The logical location → physical bucket map every fixture resolves through. */
export const TEST_STORAGE_BUCKETS: Readonly<Record<string, string>> = {
  originals: "bkt-a1",
  thumbnails: "bkt-b2",
  exports: "bkt-c3",
  branding: "bkt-d4",
};

/**
 * The exact `ObjectStorage` port surface, sorted (OP-112, GREEN card §1 plus the
 * `getObjectRange` addition).
 *
 * Both adapters must expose **exactly** these methods as own enumerable keys of a
 * plain object (the `createCashfreeProvider` / `memoryMessageTransport` shape), so
 * swapping R2 for S3 is a new adapter plus config and never a port change. A
 * method that no current spec drives still belongs here: a later lane
 * (multipart signing, aborts, deletes) depends on the port being complete.
 */
export const STORAGE_PORT_METHODS: readonly string[] = [
  "abortMultipart",
  "completeMultipart",
  "createMultipart",
  "deleteObject",
  "getObject",
  "getObjectRange",
  "getObjectStream",
  "headObject",
  "listParts",
  "presignPart",
  "presignPut",
  "putObject",
];

/**
 * Build an R2 adapter configuration for the mock S3 endpoint.
 *
 * @param overrides - Fields to replace on the fixture default.
 * @returns A valid {@link R2ObjectStorageConfig}.
 */
export function makeR2ObjectStorageConfig(
  overrides: Partial<R2ObjectStorageConfig> = {}
): R2ObjectStorageConfig {
  return {
    endpoint: TEST_STORAGE_ENDPOINT,
    region: "auto",
    credentials: { accessKeyId: "test-access-key", secretAccessKey: "test-secret-key" },
    buckets: TEST_STORAGE_BUCKETS,
    ...overrides,
  };
}
