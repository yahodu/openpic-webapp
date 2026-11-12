import { UPLOAD_FORMATS } from "@/server/settings/upload-guards";

/**
 * The upload pre-check's pure decision (OP-123, contract §5.1 / §5.2,
 * schema §16.1–§16.3; ADR-0700, ADR-0701).
 *
 * `POST …/events/{eventId}/uploads/batch-resolve` answers, per content hash, one
 * of four wire states — `completed` (skip the transfer), `in_progress` (resume
 * the parts already stored), `not_found` (fresh upload) and `rejected` (never
 * attempt). {@link resolutionFor} folds one hash's stored observations into
 * exactly one of them, so the route is left with nothing but reads.
 *
 * The rejection table is the upload guards' own {@link UPLOAD_FORMATS}
 * (ADR-0009), which is what makes `.NEF` + `image/tiff` and `.heic` +
 * `image/heif` pass: RAW containers share the TIFF MIME, and one format admits
 * several MIME values. No magic-byte check runs here — the pre-check has no
 * bytes yet.
 */

/** The §5.1 ceiling on one `batch-resolve` call. */
export const MAX_BATCH_FILES = 500;

/** The §5.1 upload tunables the decision reads (from `platformSettings.upload`). */
export interface UploadPolicy {
  readonly multipartThresholdBytes: number;
  readonly maxFileBytes: number;
  readonly supportedMimeTypes: readonly string[];
}

/** One client claim about a file: identity, size and the two type claims. */
export interface BatchFileClaim {
  readonly hash: string;
  readonly size: number;
  readonly mimeType: string;
  readonly fileName?: string | undefined;
}

/** One hash's stored observations, as the route read them. */
export interface ResolutionInput {
  readonly claim: BatchFileClaim;
  readonly policy: UploadPolicy;
  /** The tenant-scoped `media_assets` row, or `null`. */
  readonly asset: { readonly id: string; readonly bytes: number } | null;
  /** The `event_images` link row's id for *this* event, or `null`. */
  readonly eventImageId: string | null;
  /** The caller's `upload_sessions` row, or `null`. */
  readonly session: {
    readonly mode: "single" | "multipart";
    readonly uploadId: string | null;
  } | null;
  /** The live `ListParts` answer, or `null` when no resume was attempted. */
  readonly parts: readonly { readonly PartNumber: number; readonly Size: number }[] | null;
}

/** The per-file wire state (§5.2). */
export type UploadResolution =
  | {
      readonly state: "completed";
      readonly assetId: string;
      readonly eventImageId: string | null;
      readonly linked: boolean;
      readonly bytes: number;
    }
  | {
      readonly state: "in_progress";
      readonly uploadId: string;
      readonly mode: "multipart";
      readonly uploadedPartNumbers: readonly number[];
      readonly uploadedBytes: number;
    }
  | { readonly state: "not_found"; readonly mode: "single" | "multipart" }
  | { readonly state: "rejected"; readonly reason: string; readonly message: string };

/** The four reasons a claim is refused, with their pinned user-facing copy (A1). */
const REJECTION_MESSAGES = {
  unsupported_mime_type:
    "This file type is not supported. Upload a JPEG, PNG, WebP, AVIF, HEIC or TIFF image.",
  unsupported_extension: "The file name has no supported image extension.",
  extension_mime_mismatch: "The file name says one image type and the declared type says another.",
  file_too_large: "This file is larger than the 100 MB limit for one image.",
} as const;

/** The reasons {@link REJECTION_MESSAGES} keys on. */
type RejectionReason = keyof typeof REJECTION_MESSAGES;

/** A 24-hex id (any case) — one of the two admitted `batchId` shapes (§5.2). */
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/** A version-4 UUID (any case) — the other admitted `batchId` shape (§5.2). */
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Whether a client-generated batch id is one the contract admits (§5.2).
 *
 * @param value - The `batchId` the client sent.
 * @returns `true` for a 24-hex id or a UUIDv4, either case.
 */
export function isValidBatchId(value: string): boolean {
  return OBJECT_ID_PATTERN.test(value) || UUID_V4_PATTERN.test(value);
}

/**
 * The advisory quota arithmetic behind `quota.storage` / `quota.images`.
 *
 * It never refuses anything: enforcement stays `consumeEntitlement` at
 * completion time (ADR-0340), so `sufficient: false` is information for the
 * client, not an error. A `null` allowance is the §14.2 "no limit" sentinel.
 *
 * @param input - The remaining allowance and the batch's request.
 * @returns The wire block the route lifts into `quota`.
 */
export function quotaSufficiency(input: {
  readonly remaining: number | null;
  readonly requested: number;
}): { remaining: number | null; requested: number; sufficient: boolean } {
  return {
    remaining: input.remaining,
    requested: input.requested,
    sufficient: input.remaining === null || input.remaining >= input.requested,
  };
}

/** The lower-cased extension (with its dot) of a file name, or `""`. */
function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot).toLowerCase();
}

/** The one rejection shape, with the pinned copy for `reason`. */
function rejected(reason: RejectionReason): UploadResolution {
  return { state: "rejected", reason, message: REJECTION_MESSAGES[reason] };
}

/**
 * Refuse a claim the pre-check can already rule out, in contract order:
 * declared MIME, then file-name extension agreement, then the size ceiling.
 *
 * @param claim - The client's claim about one file.
 * @param policy - The upload tunables.
 * @returns The rejection, or `null` when the claim is acceptable.
 */
function rejectionFor(claim: BatchFileClaim, policy: UploadPolicy): UploadResolution | null {
  if (!policy.supportedMimeTypes.includes(claim.mimeType)) {
    return rejected("unsupported_mime_type");
  }

  if (claim.fileName !== undefined) {
    const extension = extensionOf(claim.fileName);
    const format = UPLOAD_FORMATS.find((candidate) => candidate.extensions.includes(extension));
    if (format === undefined) {
      return rejected("unsupported_extension");
    }
    if (!format.mimeTypes.includes(claim.mimeType)) {
      return rejected("extension_mime_mismatch");
    }
  }

  if (claim.size > policy.maxFileBytes) {
    return rejected("file_too_large");
  }
  return null;
}

/**
 * Fold one hash's observations into exactly one wire state.
 *
 * Precedence is fixed (ADR-0700 D2): a **stored asset wins** (the bytes are
 * already accepted, so no type claim can invalidate them), then a **refused
 * claim**, then a **resumable multipart session**, then a fresh upload. A
 * `single`-mode session and a `multipart` session with no provider id carry
 * nothing to resume, so both resolve `not_found`.
 *
 * @param input - The claim, the policy and the stored observations.
 * @returns The single resolution for this hash.
 */
export function resolutionFor(input: ResolutionInput): UploadResolution {
  const { claim, policy, asset, eventImageId, session, parts } = input;

  if (asset !== null) {
    return {
      state: "completed",
      assetId: asset.id,
      eventImageId,
      linked: eventImageId !== null,
      bytes: asset.bytes,
    };
  }

  const refusal = rejectionFor(claim, policy);
  if (refusal !== null) {
    return refusal;
  }

  if (session !== null && session.mode === "multipart" && session.uploadId !== null) {
    const listed = parts ?? [];
    return {
      state: "in_progress",
      uploadId: session.uploadId,
      mode: "multipart",
      uploadedPartNumbers: listed.map((part) => part.PartNumber),
      uploadedBytes: listed.reduce((total, part) => total + part.Size, 0),
    };
  }

  return {
    state: "not_found",
    mode: claim.size >= policy.multipartThresholdBytes ? "multipart" : "single",
  };
}
