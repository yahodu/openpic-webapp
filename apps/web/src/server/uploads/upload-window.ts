/**
 * Upload-window enforcement (OP-124, contract §5.2 / §5.3, ADR-0721 A7).
 *
 * The window (`events.uploadWindowEndsAt`) is a deadline for **starting** an
 * upload, not for finishing one: a session created before the close may still
 * complete inside `platformSettings.upload.inflightGraceMinutes`, while a
 * session that would start after the close is refused. OP-123 pinned the
 * refusal shape for the pre-check; this module is the one place the rule is
 * decided, so `batch-resolve`, `uploads/params` and `complete` cannot drift.
 */

/** The `details` payload of `409 upload_window_closed` (contract §5.2). */
export interface UploadWindowClosed {
  /** The stored window deadline, as an RFC 3339 instant. */
  readonly uploadWindowEndsAt: string;
  /** Whether the caller may move the deadline (an organizer may). */
  readonly canExtend: boolean;
}

/** The inputs {@link uploadWindowClosed} reasons about. */
export interface UploadWindowInput {
  /** The event's `uploadWindowEndsAt`, or `null` for an event with no deadline. */
  readonly windowEndsAt: Date | null;
  /** The current instant. */
  readonly now: Date;
  /** Whether the caller may extend the window. */
  readonly canExtend: boolean;
  /**
   * The instant the session being completed started. When supplied, a session
   * that started before the close is judged against the grace instead of the
   * deadline.
   */
  readonly startedAt?: Date;
  /** The in-flight grace, in minutes (`platformSettings.upload.inflightGraceMinutes`). */
  readonly graceMinutes?: number;
}

/**
 * Decide whether an upload action is refused by a closed window.
 *
 * @param input - The deadline, the instant, the caller's capability and, for a
 *   completion, when the session started.
 * @returns The `409 upload_window_closed` details, or `null` when the action
 *   is still inside the window (or its grace).
 */
export function uploadWindowClosed(input: UploadWindowInput): UploadWindowClosed | null {
  if (input.windowEndsAt === null) {
    return null;
  }
  const closesAtMs = input.windowEndsAt.getTime();
  const startedBeforeClose =
    input.startedAt !== undefined && input.startedAt.getTime() <= closesAtMs;
  const deadlineMs = startedBeforeClose
    ? closesAtMs + (input.graceMinutes ?? 0) * 60_000
    : closesAtMs;

  if (input.now.getTime() <= deadlineMs) {
    return null;
  }
  return {
    uploadWindowEndsAt: input.windowEndsAt.toISOString(),
    canExtend: input.canExtend,
  };
}
