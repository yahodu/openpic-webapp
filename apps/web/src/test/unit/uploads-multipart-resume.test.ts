import { describe, expect, it } from "vitest";

import { reuseUploadDecision } from "@/server/uploads/multipart";

/**
 * Unit — the `existingUploadId` reuse decision (OP-125 U3, contract §5.4,
 * ADR-0740).
 *
 * Uppy sends `existingUploadId` on `createMultipartUpload` when it is resuming
 * an interrupted file. The server may **reuse** that upload only when every
 * fact makes the reuse safe; otherwise it must call the provider's
 * `CreateMultipartUpload` and start over. Two failure modes are expensive in
 * opposite directions:
 *
 * - reusing an upload that is **not** the caller's live one drops a resuming
 *   client into someone else's (or a finished) upload;
 * - creating a new upload when a live one exists leaks an unfinished multipart
 *   series into storage on every retry, until the provider's lifecycle rule
 *   aborts it a week later.
 *
 * The observation handed in is scoped to the caller and the content hash by
 * the route's query (only a `pending` session of *this* user for *this* hash
 * is even visible), so the pure rule decides the remaining three facts: the
 * observed session is the one named, it is still `pending`, and it has not
 * passed its `expireAt`.
 *
 * Contract the implementation owes:
 *
 * ```ts
 * // @/server/uploads/multipart
 * export function reuseUploadDecision(input: {
 *   readonly existingUploadId: string | undefined;
 *   readonly session: {
 *     readonly uploadId: string;
 *     readonly status: string;
 *     readonly expireAt: Date;
 *   } | null;
 *   readonly now: Date;
 * }): "reuse" | "create";
 * ```
 */

/** A fixed instant, so the expiry comparisons are deterministic. */
const NOW = new Date("2026-09-25T09:00:00.000Z");

/** One minute in milliseconds. */
const MINUTE_MS = 60_000;

/** The observation the decision reads: the caller's session for one hash. */
interface ObservedSession {
  readonly uploadId: string;
  readonly status: string;
  readonly expireAt: Date;
}

/** The caller's own pending multipart session. */
function liveSession(overrides: Partial<ObservedSession> = {}): ObservedSession {
  return {
    uploadId: "up-live",
    status: "pending",
    expireAt: new Date(NOW.getTime() + 5 * 24 * 60 * MINUTE_MS),
    ...overrides,
  };
}

describe("reuseUploadDecision (U3, contract §5.4)", () => {
  it("reuses the upload when the caller's own pending session is the one named", () => {
    expect(
      reuseUploadDecision({
        existingUploadId: "up-live",
        session: liveSession(),
        now: NOW,
      })
    ).toBe("reuse");
  });

  it("creates when the client names no existing upload", () => {
    // A first attempt for this file: there is nothing to reuse even though an
    // unrelated session may be visible to the same user.
    expect(
      reuseUploadDecision({ existingUploadId: undefined, session: liveSession(), now: NOW })
    ).toBe("create");
  });

  it("creates when the caller has no session for this content hash", () => {
    expect(reuseUploadDecision({ existingUploadId: "up-live", session: null, now: NOW })).toBe(
      "create"
    );
  });

  it("creates when the visible session is a different upload than the one named", () => {
    // The named id must be the observed one: trusting the path id alone would
    // let a client address an upload this query cannot vouch for.
    expect(
      reuseUploadDecision({
        existingUploadId: "up-other",
        session: liveSession(),
        now: NOW,
      })
    ).toBe("create");
  });

  it.each([
    ["a completed session", "completed"],
    ["an aborted session", "aborted"],
  ])("creates rather than resuming %s", (_label, status) => {
    expect(
      reuseUploadDecision({
        existingUploadId: "up-live",
        session: liveSession({ status }),
        now: NOW,
      })
    ).toBe("create");
  });

  it("creates once the session's expireAt has been reached", () => {
    // The boundary is exclusive: at exactly `expireAt` the provider's lifecycle
    // rule may already have aborted the series, so the upload is not reusable.
    expect(
      reuseUploadDecision({
        existingUploadId: "up-live",
        session: liveSession({ expireAt: new Date(NOW) }),
        now: NOW,
      })
    ).toBe("create");
  });

  it("reuses a session one millisecond short of its expireAt", () => {
    expect(
      reuseUploadDecision({
        existingUploadId: "up-live",
        session: liveSession({ expireAt: new Date(NOW.getTime() + 1) }),
        now: NOW,
      })
    ).toBe("reuse");
  });
});
