import { describe, expect, it } from "vitest";

import { resolveStatus } from "@/server/attendee/status-detail";

/**
 * Unit contract — the profile status and its `statusDetail`
 * (OP-133 U3; contract §6.4 `status`/`statusDetail`; ADR-0793 §3).
 *
 * **Why this exists.** `status` alone cannot be rendered: `ready` with nothing
 * found and `failed` because the photo had no face look identical in the
 * status code but need opposite screens. §6.4 therefore fixes a second field,
 * `statusDetail`, and this spec is its mapping — including the rule that the
 * detail is only ever populated for the two states that need words
 * (`no_match`, `failed`).
 *
 * **Contract pinned here.**
 *
 * ```
 * resolveStatus({
 *   status,                 // the stored profile status (§15.3)
 *   matchCount,             // the cached count (§15.3)
 *   rejectionReason?,       // selfies.quality.rejectionReason (§16.4)
 *   lastErrorCode?,         // processing.lastError.code (§18.2)
 * }): { status, statusDetail: StatusDetail | null }
 * ```
 *
 * - A `ready` profile with **no** matches is reported as `no_match` with
 *   `statusDetail.code === "no_matches_yet"` — the client must not render an
 *   empty gallery as a success.
 * - `failed` maps the stored reason to one of four stable codes
 *   (`no_face_detected`, `multiple_faces`, `low_quality`, `liveness_failed`);
 *   anything unrecognised collapses to `processing_failed`, so an internal
 *   model string is never handed to a browser.
 * - The §6.4 example's copy for `no_face_detected` is pinned verbatim; every
 *   other detail only has to carry a non-empty `message` and `remedy`, because
 *   §6.4 fixes neither.
 * - `canRetry` is `true` for both populated states: a new selfie is the
 *   attendee's only remedy and §14.1 bounds the attempts.
 */
describe("resolveStatus", () => {
  it("reports no_selfie with no detail", () => {
    expect(resolveStatus({ status: "no_selfie", matchCount: 0 })).toEqual({
      status: "no_selfie",
      statusDetail: null,
    });
  });

  it("reports selfie_pending with no detail", () => {
    expect(resolveStatus({ status: "selfie_pending", matchCount: 0 })).toEqual({
      status: "selfie_pending",
      statusDetail: null,
    });
  });

  it("reports processing with no detail", () => {
    expect(resolveStatus({ status: "processing", matchCount: 0 })).toEqual({
      status: "processing",
      statusDetail: null,
    });
  });

  it("keeps a ready profile that found matches free of detail", () => {
    expect(resolveStatus({ status: "ready", matchCount: 5 })).toEqual({
      status: "ready",
      statusDetail: null,
    });
  });

  it("reports a ready profile with no matches as no_match carrying no_matches_yet", () => {
    const resolved = resolveStatus({ status: "ready", matchCount: 0 });

    expect(resolved.status).toBe("no_match");
    expect(resolved.statusDetail?.code).toBe("no_matches_yet");
    expect(resolved.statusDetail?.canRetry).toBe(true);
    expect(String(resolved.statusDetail?.message).length).toBeGreaterThan(0);
    expect(String(resolved.statusDetail?.remedy).length).toBeGreaterThan(0);
  });

  it("keeps an explicit no_match status even when the cached count disagrees", () => {
    const resolved = resolveStatus({ status: "no_match", matchCount: 0, rejectionReason: null });

    expect(resolved.status).toBe("no_match");
    expect(resolved.statusDetail?.code).toBe("no_matches_yet");
  });

  it("maps a no-face rejection to the §6.4 example detail verbatim", () => {
    expect(
      resolveStatus({ status: "failed", matchCount: 0, rejectionReason: "no_face_detected" })
    ).toEqual({
      status: "failed",
      statusDetail: {
        code: "no_face_detected",
        message: "We couldn't find a face in your photo.",
        remedy: "Try a photo taken in better light, facing the camera.",
        canRetry: true,
      },
    });
  });

  it.each<readonly [string, string]>([
    ["multiple_faces", "multiple_faces"],
    ["low_quality", "low_quality"],
  ])("maps the selfie rejection %s to the stable code %s", (rejectionReason, expectedCode) => {
    const resolved = resolveStatus({ status: "failed", matchCount: 0, rejectionReason });

    expect(resolved.status).toBe("failed");
    expect(resolved.statusDetail?.code).toBe(expectedCode);
    expect(resolved.statusDetail?.canRetry).toBe(true);
    expect(String(resolved.statusDetail?.message).length).toBeGreaterThan(0);
    expect(String(resolved.statusDetail?.remedy).length).toBeGreaterThan(0);
  });

  it("maps a liveness failure recorded on the pipeline to liveness_failed", () => {
    const resolved = resolveStatus({
      status: "failed",
      matchCount: 0,
      rejectionReason: null,
      lastErrorCode: "liveness_failed",
    });

    expect(resolved.statusDetail?.code).toBe("liveness_failed");
    expect(resolved.statusDetail?.canRetry).toBe(true);
  });

  it("collapses an unrecognised rejection reason to processing_failed", () => {
    // Never echo an internal model/worker string back to a browser.
    const resolved = resolveStatus({
      status: "failed",
      matchCount: 0,
      rejectionReason: "arcface_r100_512_threshold_0.41",
    });

    expect(resolved.statusDetail?.code).toBe("processing_failed");
    expect(resolved.statusDetail?.canRetry).toBe(true);
    expect(String(resolved.statusDetail?.message)).not.toContain("arcface");
  });

  it("collapses a failure with no recorded reason to processing_failed", () => {
    const resolved = resolveStatus({ status: "failed", matchCount: 0 });

    expect(resolved.statusDetail?.code).toBe("processing_failed");
  });

  it("reports withdrawn with no detail", () => {
    expect(resolveStatus({ status: "withdrawn", matchCount: 0 })).toEqual({
      status: "withdrawn",
      statusDetail: null,
    });
  });

  it("only ever carries the four documented detail keys", () => {
    const detail = resolveStatus({
      status: "failed",
      matchCount: 0,
      rejectionReason: "no_face_detected",
    }).statusDetail;

    expect(detail === null ? [] : Object.keys(detail).sort()).toEqual([
      "canRetry",
      "code",
      "message",
      "remedy",
    ]);
  });
});
