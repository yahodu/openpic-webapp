/**
 * The attendee's `status` + `statusDetail` mapping (OP-133; contract §6.4;
 * ADR-0794 §3).
 *
 * A bare `status` cannot be rendered: `ready` with nothing found and `failed`
 * because the photo had no face need opposite screens. §6.4 fixes a second field
 * for exactly that, and this table is it — including the rule that a detail is
 * only ever populated for the two states that need words.
 */

/** The stable detail codes §6.4 lets a browser see. */
export type StatusDetailCode =
  | "no_matches_yet"
  | "no_face_detected"
  | "multiple_faces"
  | "low_quality"
  | "liveness_failed"
  | "processing_failed";

/** One populated `statusDetail` (§6.4) — exactly four keys. */
export interface StatusDetail {
  readonly code: StatusDetailCode;
  readonly message: string;
  readonly remedy: string;
  /** A new selfie is the attendee's only remedy (§14.1 bounds the attempts). */
  readonly canRetry: boolean;
}

/** Every status the mapping may answer (schema §15.3). */
export type ProfileStatus =
  "no_selfie" | "selfie_pending" | "processing" | "ready" | "no_match" | "failed" | "withdrawn";

/** The facts the mapping reads. */
export interface StatusInput {
  /** The stored profile status (schema §15.3). */
  readonly status: ProfileStatus;
  /** The cached match count (schema §15.3). */
  readonly matchCount: number;
  /** `selfies.quality.rejectionReason` (schema §16.4). */
  readonly rejectionReason?: string | null;
  /** `processing.lastError.code` (schema §18.2). */
  readonly lastErrorCode?: string | null;
}

/** The status and its optional detail. */
export interface ResolvedStatus {
  readonly status: ProfileStatus;
  readonly statusDetail: StatusDetail | null;
}

/** The §6.4 copy for a selfie that found nothing. */
const NO_MATCHES: StatusDetail = {
  code: "no_matches_yet",
  message: "We haven't found you in any photos yet.",
  remedy: "New photos appear here as the event goes on. Check back later.",
  canRetry: true,
};

/** The selfie rejection reasons that have their own code and copy (§6.4). */
const REJECTION_DETAILS: Readonly<Record<string, StatusDetail>> = {
  no_face_detected: {
    code: "no_face_detected",
    message: "We couldn't find a face in your photo.",
    remedy: "Try a photo taken in better light, facing the camera.",
    canRetry: true,
  },
  multiple_faces: {
    code: "multiple_faces",
    message: "We found more than one face in your photo.",
    remedy: "Try a photo of just you, with nobody else in the frame.",
    canRetry: true,
  },
  low_quality: {
    code: "low_quality",
    message: "Your photo was too blurry to use.",
    remedy: "Try a sharp, well-lit photo of your face.",
    canRetry: true,
  },
};

/** The pipeline's liveness refusal (§18.2). */
const LIVENESS_FAILED: StatusDetail = {
  code: "liveness_failed",
  message: "We couldn't confirm your photo was taken live.",
  remedy: "Try again, holding the camera steady and following the prompt.",
  canRetry: true,
};

/**
 * The fallback for a failure whose reason is unknown — an internal model or
 * worker string must never reach a browser.
 */
const PROCESSING_FAILED: StatusDetail = {
  code: "processing_failed",
  message: "We couldn't process your photo.",
  remedy: "Try a new selfie.",
  canRetry: true,
};

/**
 * Map a stored profile to the §6.4 `status`/`statusDetail` pair.
 *
 * @param input - The stored status, the cached count and the failure reasons.
 * @returns The status to render and, for `no_match`/`failed`, its detail.
 */
export function resolveStatus(input: StatusInput): ResolvedStatus {
  if (input.status === "failed") {
    const code = input.rejectionReason;
    const known = code === null || code === undefined ? undefined : REJECTION_DETAILS[code];
    return {
      status: "failed",
      statusDetail:
        known ?? (input.lastErrorCode === "liveness_failed" ? LIVENESS_FAILED : PROCESSING_FAILED),
    };
  }
  if (input.status === "no_match" || (input.status === "ready" && input.matchCount === 0)) {
    // An empty gallery is not a success: the client must render "nothing yet".
    return { status: "no_match", statusDetail: NO_MATCHES };
  }
  return { status: input.status, statusDetail: null };
}
