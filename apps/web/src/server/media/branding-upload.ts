import { createHash } from "node:crypto";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { appError } from "@/server/http/errors";
import { requestLogger } from "@/server/logging";
import { createMediaSigner } from "@/server/media/signer";
import { platformRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { getConfig } from "@/server/config/env";
import { getObjectStorage } from "@/server/storage/get-object-storage";
import { buildObjectKey } from "@/server/storage/object-key";

import {
  BRANDING_KIND_VALUES,
  type BrandingKind,
  type BrandingUploadResponse,
} from "./branding-schema";
import { detectBrandingUpload } from "./branding-type";
import { sanitizeSvg } from "./sanitize-svg";

/**
 * The branding upload service (OP-114, API contract §2.1).
 *
 * The one byte-accepting endpoint's shared mechanics, used by both the
 * tenant-scoped route (`POST /tenants/{tenantId}/assets/branding`, owner|admin)
 * and the event-scoped twin (`POST /events/{eventId}/assets/branding`,
 * organizer-backed). The caller has already resolved *who* may upload and
 * *which tenant* the asset is attributed to; this service performs the
 * upload-side contract:
 *
 *   1. the multipart `file` field is streamed with a 2 MiB cap — a larger file
 *      is refused as `413 file_too_large` with the exact `{ maxBytes,
 *      actualBytes }` (never buffering unbounded data);
 *   2. the format is detected from the **bytes** (never the client's name or
 *      declared type); an undetectable file is `415 unsupported_media_type`
 *      listing the four branding MIME types;
 *   3. an SVG is stored sanitized (scripts/foreign objects/event handlers/
 *      `javascript:` URIs stripped) while the content hash stays that of the
 *      **original** bytes (schema §16.1);
 *   4. the object is stored content-addressed under the `branding` location
 *      and the `mediaAssets` row is upserted on the unique
 *      `{ tenantId, contentHash }` — a re-upload of the same bytes answers
 *      with the same `assetId`;
 *   5. the answer is `201 { assetId, kind, url, bytes }` with a signed
 *      `/t/` (thumbnail) media URL over the original content hash.
 *
 * Every refusal logs `warn` as `upload.rejected` with the reason and never the
 * file contents.
 */

/** The 2 MiB branding ceiling (assumption A1, ADR-0540). */
export const MAX_BRANDING_BYTES = 2 * 1024 * 1024;

/** The four MIME types the endpoint accepts (contract §2.1 / Appendix A.2). */
export const SUPPORTED_BRANDING_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
] as const;

/** Inputs the two routes resolve before handing the upload to the service. */
export interface AcceptBrandingUploadInput {
  /** The tenant the asset is stored and billed under. */
  readonly tenantId: string;
  /** The inbound request whose multipart body carries the upload. */
  readonly request: Request;
  /** The matched route template, for the request-scoped logger. */
  readonly route: string;
}

/** The exact byte content of one file, with its streamed total length. */
interface ReadFileResult {
  /** At most `cap` bytes (the file when it fits, else the capped prefix). */
  readonly bytes: Uint8Array;
  /** The file's true streamed length, whatever the cap. */
  readonly actualBytes: number;
}

/**
 * Stream a `File` body into memory, enforcing `cap` without buffering more.
 *
 * The whole stream is still consumed so `actualBytes` is exact (the `413`
 * details pin it to the true length); only the first `cap` bytes are retained.
 *
 * @param file - The multipart `file` entry.
 * @param cap - The enforced ceiling in bytes.
 * @returns The retained prefix and the true length.
 */
async function readFileWithCap(file: File, cap: number): Promise<ReadFileResult> {
  const reader = file.stream().getReader();
  const chunks: Uint8Array[] = [];
  let retained = 0;
  let actualBytes = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    actualBytes += value.byteLength;
    if (retained < cap) {
      const room = cap - retained;
      chunks.push(room >= value.byteLength ? value : value.slice(0, room));
      retained = Math.min(cap, retained + value.byteLength);
    }
  }

  const bytes = new Uint8Array(retained);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, actualBytes };
}

/** Read the `kind` form field; omitted → `event_logo`, unknown → 422. */
function parseKind(value: FormDataEntryValue | null): BrandingKind {
  if (value === null || (typeof value === "string" && value === "")) {
    return "event_logo";
  }
  if (typeof value === "string" && (BRANDING_KIND_VALUES as readonly string[]).includes(value)) {
    return value as BrandingKind;
  }
  throw appError("validation_failed", {
    details: {
      fields: [
        {
          path: "kind",
          code: "invalid",
          message: `Must be one of: ${BRANDING_KIND_VALUES.join(", ")}.`,
        },
      ],
    },
  });
}

/**
 * Accept one branding upload and persist it under the given tenant.
 *
 * @param input - The attributed tenant, the inbound request and the route.
 * @returns The `201` envelope: `{ assetId, kind, url, bytes }`.
 * @throws {AppError} `413 file_too_large`, `415 unsupported_media_type` or a
 *   `422 validation_failed` for a broken multipart envelope.
 */
export async function acceptBrandingUpload(
  input: AcceptBrandingUploadInput
): Promise<BrandingUploadResponse> {
  const logger = requestLogger(input.request, { route: input.route });
  const form = await input.request.formData();

  const fileEntry = form.get("file");
  if (!(fileEntry instanceof File)) {
    throw appError("validation_failed", {
      details: {
        fields: [{ path: "file", code: "invalid", message: "A file field is required." }],
      },
    });
  }

  const { bytes, actualBytes } = await readFileWithCap(fileEntry, MAX_BRANDING_BYTES);

  // The size refusal precedes type detection: an oversized PNG is a 413, not a
  // 415 (I1), and the refusal is total — nothing is hashed, stored or written.
  if (actualBytes > MAX_BRANDING_BYTES) {
    logger.warn("branding upload rejected", {
      event: "upload.rejected",
      reason: "file_too_large",
      tenantId: input.tenantId,
    });
    throw appError("file_too_large", {
      details: { maxBytes: MAX_BRANDING_BYTES, actualBytes },
    });
  }

  const detected = detectBrandingUpload({
    bytes,
    fileName: fileEntry.name,
    declaredMimeType: fileEntry.type,
  });
  if (!detected.ok) {
    logger.warn("branding upload rejected", {
      event: "upload.rejected",
      reason: detected.reason,
      tenantId: input.tenantId,
    });
    throw appError("unsupported_media_type", {
      details: { supportedMimeTypes: SUPPORTED_BRANDING_MIME_TYPES },
    });
  }

  const kind = parseKind(form.get("kind"));

  // The content hash is of the ORIGINAL bytes (schema §16.1); the object is
  // the sanitized copy for SVG, the original otherwise (ADR-0540 §3).
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const storedBytes =
    detected.format === "svg"
      ? new TextEncoder().encode(sanitizeSvg(new TextDecoder().decode(bytes)))
      : bytes;

  const storage = getObjectStorage();
  const key = buildObjectKey(contentHash, detected.extension);
  await storage.putObject("branding", key, storedBytes, detected.mimeType);

  // Upsert on the unique {tenantId, contentHash} identity: a re-upload of the
  // same bytes answers with the same assetId and never a second row (I6).
  const now = systemClock.now();
  const row = await platformRepo(getDb())
    .collection(COLLECTIONS.mediaAssets)
    .findOneAndUpdate(
      { tenantId: input.tenantId, contentHash },
      { $setOnInsert: { tenantId: input.tenantId, contentHash, kind, createdAt: now } },
      { upsert: true, returnDocument: "after" }
    );
  if (row === null) {
    throw appError("internal_error");
  }

  // The signed URL mints the thumbnail derivative (`/t/`, 24 h) — the
  // contract's own `https://pic.openpic.in/t/...` response example (A3).
  const config = getConfig();
  const signer = createMediaSigner({
    currentSecret: config.media.signingSecretCurrent,
    ...(config.media.signingSecretPrevious === undefined
      ? {}
      : { previousSecret: config.media.signingSecretPrevious }),
  });
  const { url } = signer.sign({
    kind: "thumbnail",
    contentHash,
    ext: detected.extension,
  });

  return {
    assetId: row._id.toHexString(),
    kind,
    url,
    bytes: storedBytes.length,
  };
}
