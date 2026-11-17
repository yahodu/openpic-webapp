import { describe, expect, it } from "vitest";

import { AppError } from "@/server/http/app-error";
import { createHandleService, type IssueHandleInput } from "@/server/storage/handles";

import {
  TEST_HANDLE_SECRET,
  TEST_HANDLE_USER_ID,
  TEST_UPLOAD_SESSION_ID,
} from "../factories/storage";

/**
 * F1 — the handle registry's cross-restart durability boundary (OP-112
 * follow-up; ADR-0581 §3, ADR-0580 §5).
 *
 * ADR-0581 §3 records that `resolveHandle` only answers for the life of the
 * issuing process: the object key is unrecoverable from the token, so the
 * service resolves it from a **per-instance** registry keyed by the issued
 * token, and "a deployment that must resolve handles across restarts or
 * instances moves this map behind a shared store (the existing Upstash
 * Redis) — the refusal surface is identical." That durability statement is an
 * *open item* for the upload-route lane, but the boundary itself is pinned
 * here: a fresh service instance holding the **same secret** must refuse a
 * handle it did not issue, with the same `bad_request` `AppError` every other
 * refusal throws. The future shared-store lane turns these pins red by
 * design.
 */
const OBJECT_KEY = "images/3f2c1d8899aa55bb66cc77dd88ee99ff00112233445566778899aabbccddeeff.jpg";

/** The one valid issue input every case starts from. */
const ISSUE_INPUT: IssueHandleInput = {
  locationKey: "originals",
  objectKey: OBJECT_KEY,
  uploadSessionId: TEST_UPLOAD_SESSION_ID,
  userId: TEST_HANDLE_USER_ID,
};

/**
 * Return the value `run` throws, failing the test if it does not throw.
 *
 * @param run - The call that must throw.
 * @returns The thrown value.
 */
function captureThrow(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

describe("handle registry durability boundary (ADR-0581 §3)", () => {
  it("refuses a handle issued by a different service instance that shares the same secret", () => {
    // Arrange — two independent services keyed with the *same* secret: the
    // HMAC over the token is indistinguishable, so only the registry can
    // refuse the cross-instance presentation.
    const issuer = createHandleService({ secret: TEST_HANDLE_SECRET });
    const freshInstance = createHandleService({ secret: TEST_HANDLE_SECRET });
    const handle = issuer.issueHandle(ISSUE_INPUT);

    // Act / Assert — the fresh instance never issued this token, so it must
    // refuse it even though the signature is valid under its own secret.
    expect(() => freshInstance.resolveHandle(handle, TEST_HANDLE_USER_ID)).toThrow(AppError);
  });

  it("answers the documented bad_request AppError when a fresh instance resolves a handle it did not issue", () => {
    // Arrange
    const issuer = createHandleService({ secret: TEST_HANDLE_SECRET });
    const freshInstance = createHandleService({ secret: TEST_HANDLE_SECRET });
    const handle = issuer.issueHandle(ISSUE_INPUT);

    // Act
    const thrown = captureThrow(() => freshInstance.resolveHandle(handle, TEST_HANDLE_USER_ID));

    // Assert — ADR-0581 §3: "the refusal surface is identical", i.e. the same
    // `bad_request` `AppError` (400, non-retryable) every other handle refusal
    // throws, never a different error type.
    expect(thrown).toBeInstanceOf(AppError);
    if (!(thrown instanceof AppError)) {
      throw new Error(`expected an AppError, got ${String(thrown)}`);
    }
    expect(thrown.code).toBe("bad_request");
    expect(thrown.status).toBe(400);
    expect(thrown.retryable).toBe(false);
  });

  it("still resolves the handle on the issuing instance — the boundary is the registry, not the token", () => {
    // Arrange — the control: the very token the fresh instance refused must
    // still resolve on the instance that issued it, proving the refusal is
    // instance-scoped (the per-instance registry), not a broken token.
    const issuer = createHandleService({ secret: TEST_HANDLE_SECRET });
    const freshInstance = createHandleService({ secret: TEST_HANDLE_SECRET });
    const handle = issuer.issueHandle(ISSUE_INPUT);

    // Act / Assert
    expect(() => freshInstance.resolveHandle(handle, TEST_HANDLE_USER_ID)).toThrow(AppError);
    expect(issuer.resolveHandle(handle, TEST_HANDLE_USER_ID)).toEqual({
      locationKey: "originals",
      objectKey: OBJECT_KEY,
      uploadSessionId: TEST_UPLOAD_SESSION_ID,
    });
  });
});
