/**
 * The multipart upload's two pure rules (OP-125, contract §5.1/§5.4; ADR-0741).
 *
 * Both answers are computed from values the caller already holds — the claim's
 * size and the session the resume query observed — so neither reads storage
 * nor the clock. Keeping them here means the route cannot drift from the
 * `partSizeBytes` that `GET /uploads/config` publishes, and the resume rule has
 * one place to be wrong.
 */

/**
 * The contract's fixed part size for the originals bucket (§5.1, §5.1.1).
 *
 * Published verbatim by `GET /uploads/config`; the create answer reports the
 * same number so Uppy slices the file into the parts the server will sign.
 */
export const PART_SIZE_BYTES = 8_388_608;

/** The claim whose shape the part count describes. */
export interface PartCountInput {
  /** The file's declared size in bytes. */
  readonly size: number;
  /** The parts' fixed size (§5.1) — an input, never a constant inside the rule. */
  readonly partSizeBytes: number;
}

/**
 * How many parts one file slices into: `ceil(size / partSizeBytes)`.
 *
 * A partial trailing part is still a part (one byte past a boundary needs the
 * next number) and an exact multiple adds nothing, so the client is never told
 * to sign a part that will not exist and never leaves the tail unsigned. An
 * empty claim has nothing to upload and answers `0`.
 *
 * @param input - The declared size and the part size.
 * @returns The part count, `0` for an empty file.
 */
export function partCountFor(input: PartCountInput): number {
  return Math.ceil(input.size / input.partSizeBytes);
}

/** The caller's own session a resume query observed for one content hash. */
export interface ObservedSession {
  /** The provider's multipart id recorded on the session. */
  readonly uploadId: string;
  /** The session's stored status (`pending`, `completed`, `aborted`). */
  readonly status: string;
  /** When the session stops being resumable (the schema's five-day TTL). */
  readonly expireAt: Date;
}

/** The inputs the reuse decision reads. */
export interface ReuseUploadDecisionInput {
  /** The provider id Uppy echoed back on a resume, or `undefined` for a fresh attempt. */
  readonly existingUploadId: string | undefined;
  /** The caller's own pending session for this hash, or `null` when there is none. */
  readonly session: ObservedSession | null;
  /** The current instant. */
  readonly now: Date;
}

/**
 * Whether `create` may reuse the upload the client named or must start over.
 *
 * Reuse needs all three facts to hold: the named id **is** the observed
 * session's, that session is still `pending`, and its `expireAt` is strictly in
 * the future (at exactly `expireAt` the provider's lifecycle rule may already
 * have aborted the series). Anything else creates a new upload — reusing an
 * upload the caller does not own would hand a resuming client someone else's
 * series.
 *
 * @param input - The named id, the observed session and the instant.
 * @returns `"reuse"` or `"create"`.
 */
export function reuseUploadDecision(input: ReuseUploadDecisionInput): "reuse" | "create" {
  const { existingUploadId, session, now } = input;
  if (existingUploadId === undefined || session === null) {
    return "create";
  }
  if (session.uploadId !== existingUploadId || session.status !== "pending") {
    return "create";
  }
  return session.expireAt.getTime() > now.getTime() ? "reuse" : "create";
}
