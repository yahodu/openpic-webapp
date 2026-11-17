import { describe, expect, it } from "vitest";

import { ConfigError } from "@/server/config/env";
import { AppError } from "@/server/http/app-error";
import type { StorageLocationKey } from "@/server/storage/locations";
import { createHandleService, type IssueHandleInput } from "@/server/storage/handles";

import {
  TEST_HANDLE_SECRET,
  TEST_HANDLE_USER_ID,
  TEST_OTHER_USER_ID,
  TEST_UPLOAD_SESSION_ID,
} from "../factories/storage";

/**
 * U1 — the opaque upload handle (OP-112; contract §5.4, §0.15, schema §11.2).
 *
 * The multipart API hands Uppy a `key` it passes back on every later call, so the
 * handle is the *only* thing that crosses the client boundary: the R2 object key
 * and the logical `locationKey` behind it must never be recoverable from it
 * (§0.15 keeps both out of every response, and a plaintext handle would put the
 * object key straight into the client's hands).
 *
 * A handle is therefore a signed, tamper-evident token bound to **the user and
 * the upload session that own it**. All four refusals below are the same
 * observable: `resolveHandle` throws rather than answering a location it cannot
 * prove the caller owns.
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
 * Return `token` with the character at `index` replaced by a different one from
 * the token alphabet.
 *
 * @param token - A handle a service issued.
 * @param index - The character position to alter.
 * @returns A same-length, different handle.
 */
function alterAt(token: string, index: number): string {
  const existing = token.slice(index, index + 1);
  return `${token.slice(0, index)}${existing === "a" ? "b" : "a"}${token.slice(index + 1)}`;
}

describe("upload handle service", () => {
  it("U1: round-trips the location, object key and upload session it was issued for", () => {
    // Arrange
    const service = createHandleService({ secret: TEST_HANDLE_SECRET });

    // Act
    const handle = service.issueHandle(ISSUE_INPUT);
    const resolved = service.resolveHandle(handle, TEST_HANDLE_USER_ID);

    // Assert
    expect(resolved).toEqual({
      locationKey: "originals",
      objectKey: OBJECT_KEY,
      uploadSessionId: TEST_UPLOAD_SESSION_ID,
    });
    expect(Object.keys(resolved).sort()).toEqual(["locationKey", "objectKey", "uploadSessionId"]);
  });

  it("U1: the issued token is a base64url token, never the object key itself", () => {
    // Arrange
    const service = createHandleService({ secret: TEST_HANDLE_SECRET });

    // Act
    const handle = service.issueHandle(ISSUE_INPUT);

    // Assert
    expect(handle).not.toBe(OBJECT_KEY);
    expect(handle).not.toContain(OBJECT_KEY);
    // base64url segments, optionally joined by `.` (a JWT-shaped token) — no
    // `/`, `+`, `=` or raw JSON, so nothing about the payload is readable. The
    // single character class keeps the pattern ReDoS-free (the nested-quantifier
    // spelling trips `security/detect-unsafe-regex`).
    expect(handle).toMatch(/^[A-Za-z0-9_.-]+$/);
  });

  it.each([
    ["its first character", 0],
    ["a character in the middle", 8],
  ] as const)("U1: refuses a handle altered at %s", (_label, index) => {
    // Arrange
    const service = createHandleService({ secret: TEST_HANDLE_SECRET });
    const tampered = alterAt(service.issueHandle(ISSUE_INPUT), index);

    // Act / Assert
    expect(() => service.resolveHandle(tampered, TEST_HANDLE_USER_ID)).toThrow(AppError);
  });

  it("U1: refuses a handle whose trailing character was altered", () => {
    // Arrange — the last character of the token is part of whatever proves the
    // token was issued by us (a MAC segment, a checksum, a signature), and it is
    // the one position an edit cannot reach by corrupting the payload. A service
    // that only re-reads the (still intact) payload would accept this token and
    // hand back the object key, so this is the pin that proves the signature is
    // actually verified.
    const service = createHandleService({ secret: TEST_HANDLE_SECRET });
    const handle = service.issueHandle(ISSUE_INPUT);

    // Act / Assert
    expect(() =>
      service.resolveHandle(alterAt(handle, handle.length - 1), TEST_HANDLE_USER_ID)
    ).toThrow(AppError);
  });

  it("U1: refuses a handle presented by a different user", () => {
    // Arrange
    const service = createHandleService({ secret: TEST_HANDLE_SECRET });
    const handle = service.issueHandle(ISSUE_INPUT);

    // Act / Assert
    expect(() => service.resolveHandle(handle, TEST_OTHER_USER_ID)).toThrow(AppError);
  });

  it("U1: refuses a string that is not a handle at all", () => {
    // Arrange
    const service = createHandleService({ secret: TEST_HANDLE_SECRET });

    // Act / Assert
    expect(() => service.resolveHandle("not-a-handle", TEST_HANDLE_USER_ID)).toThrow(AppError);
  });

  it("U1: a handle signed with another secret is refused", () => {
    // Arrange
    const issuer = createHandleService({ secret: TEST_HANDLE_SECRET });
    const verifier = createHandleService({ secret: "some-other-signing-secret" });
    const handle = issuer.issueHandle(ISSUE_INPUT);

    // Act / Assert
    expect(() => verifier.resolveHandle(handle, TEST_HANDLE_USER_ID)).toThrow(AppError);
  });

  it("U1: refuses to issue a handle for a location outside the contract vocabulary", () => {
    // Arrange
    const service = createHandleService({ secret: TEST_HANDLE_SECRET });

    // Act / Assert — `videos` is not one of the §11.2 logical locations, so it
    // can never be resolved by config into a bucket.
    expect(() =>
      service.issueHandle({ ...ISSUE_INPUT, locationKey: "videos" as StorageLocationKey })
    ).toThrow(ConfigError);
  });
});
