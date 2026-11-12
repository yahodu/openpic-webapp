import { describe, expect, it } from "vitest";

import { createHandleService, type HandleService } from "@/server/storage/handles";
import { resolveMultipartHandle } from "@/server/uploads/multipart-handle";

import { TEST_HANDLE_SECRET } from "../factories/storage";

/**
 * Unit — the multipart handle binding (OP-125 U2, contract §5.4, ADR-0740).
 *
 * Every multipart call after the create answers with an **opaque handle** (the
 * contract's `key`), and Uppy sends it back on `listParts`, `signPart`,
 * `completeMultipartUpload` and `abortMultipartUpload`. The handle is the only
 * thing that crosses the client boundary, so it is also the only thing an
 * attacker can present. Three facts must hold together, and each of them is a
 * separate refusal:
 *
 * 1. the handle is **signed** — an edited signature is refused before any
 *    claim inside it is trusted;
 * 2. the handle is **bound to the presenter** — a second user who learns the
 *    token cannot address the first user's multipart upload;
 * 3. the handle is **bound to one upload session** — a token minted for
 *    session A must not address session B, even when the same user owns both.
 *    Without this, a client could sign parts into another upload's object key,
 *    which is the one way an upload API can corrupt a *different* file.
 *
 * The refusal the multipart surface publishes is **`404 not_found`** for all
 * three (contract §5.4: "tamper -> 404"), never the handle service's own
 * `400 bad_request`: a token that does not prove ownership must be
 * indistinguishable from an upload id that does not exist, or the endpoint
 * becomes an oracle for which ids are real.
 *
 * Contract the implementation owes:
 *
 * ```ts
 * // @/server/uploads/multipart-handle
 * export function resolveMultipartHandle(input: {
 *   readonly service: HandleService;
 *   readonly handle: string;
 *   readonly presentingUserId: string;
 *   readonly uploadSessionId: string;
 * }): ResolvedHandle; // throws AppError("not_found") on any refusal
 * ```
 */

/** The object key the handle is minted for (the content-addressed original). */
const OBJECT_KEY = "images/3f2c1d8899aa55bb66cc77dd88ee99ff00112233445566778899aabbccddeeff.jpg";

/** The user the handle is minted for. */
const OWNER_USER_ID = "user_handle_owner_001";

/** A second user — the one a bound handle must refuse. */
const OTHER_USER_ID = "user_handle_other_002";

/** The upload session the handle is minted for. */
const SESSION_A = "6705cc0000000000000000aa";

/** A second session of the same user — the one a session-bound handle must refuse. */
const SESSION_B = "6705cc0000000000000000bb";

/** A handle service keyed with the shared test secret. */
function handleService(secret: string = TEST_HANDLE_SECRET): HandleService {
  return createHandleService({ secret });
}

/** A handle minted for {@link SESSION_A} by {@link OWNER_USER_ID}. */
function mintedHandle(service: HandleService = handleService()): string {
  return service.issueHandle({
    locationKey: "originals",
    objectKey: OBJECT_KEY,
    uploadSessionId: SESSION_A,
    userId: OWNER_USER_ID,
  });
}

/**
 * Run a resolution and hand back whatever it threw.
 *
 * @param run - The resolution under test.
 * @returns The thrown value.
 * @throws When the resolution did **not** refuse, which would make a
 *   "refuses" assertion vacuous.
 */
function refusalOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected the multipart handle binding to refuse");
}

describe("resolveMultipartHandle (U2, contract §5.4)", () => {
  it("returns the object key and session of a handle the presenter owns", () => {
    // Arrange
    const service = handleService();
    const handle = mintedHandle(service);

    // Act
    const resolved = resolveMultipartHandle({
      service,
      handle,
      presentingUserId: OWNER_USER_ID,
      uploadSessionId: SESSION_A,
    });

    // Assert — exactly the three neutral keys the port's resolution carries;
    // the handle never spells the object key on the wire, the server resolves it.
    expect(Object.keys(resolved).sort()).toEqual(["locationKey", "objectKey", "uploadSessionId"]);
    expect(resolved).toEqual({
      locationKey: "originals",
      objectKey: OBJECT_KEY,
      uploadSessionId: SESSION_A,
    });
  });

  it("refuses another user's handle with 404 not_found, never 400", () => {
    // Arrange — the token is genuine; the presenter is not its owner.
    const service = handleService();
    const handle = mintedHandle(service);

    // Act
    const refusal = refusalOf(() =>
      resolveMultipartHandle({
        service,
        handle,
        presentingUserId: OTHER_USER_ID,
        uploadSessionId: SESSION_A,
      })
    );

    // Assert — the one observable: no object key is served, and the status is
    // the same 404 an unknown upload id earns.
    expect(refusal).toMatchObject({ code: "not_found", status: 404 });
  });

  it("refuses a handle minted for one session when presented for another", () => {
    // Arrange — the same user owns both sessions, so only the session binding
    // stands between this handle and the wrong object key.
    const service = handleService();
    const handle = mintedHandle(service);

    // Act
    const refusal = refusalOf(() =>
      resolveMultipartHandle({
        service,
        handle,
        presentingUserId: OWNER_USER_ID,
        uploadSessionId: SESSION_B,
      })
    );

    // Assert
    expect(refusal).toMatchObject({ code: "not_found", status: 404 });
  });

  it("refuses a handle whose signature was edited", () => {
    // Arrange — flip the last character of the signature segment.
    const service = handleService();
    const handle = mintedHandle(service);
    const separator = handle.indexOf(".");
    const signature = handle.slice(separator + 1);
    const lastCharacter = signature.slice(-1);
    const forged = `${handle.slice(0, separator + 1)}${lastCharacter === "A" ? "B" : "A"}`;

    // Act
    const refusal = refusalOf(() =>
      resolveMultipartHandle({
        service,
        handle: forged,
        presentingUserId: OWNER_USER_ID,
        uploadSessionId: SESSION_A,
      })
    );

    // Assert
    expect(refusal).toMatchObject({ code: "not_found", status: 404 });
  });

  it("refuses a handle signed by a different secret", () => {
    // Arrange — a token from another deployment's service is not a token.
    const foreignService = handleService("a-different-handle-signing-secret");
    const handle = mintedHandle(foreignService);

    // Act
    const refusal = refusalOf(() =>
      resolveMultipartHandle({
        service: handleService(),
        handle,
        presentingUserId: OWNER_USER_ID,
        uploadSessionId: SESSION_A,
      })
    );

    // Assert
    expect(refusal).toMatchObject({ code: "not_found", status: 404 });
  });

  it.each([
    ["an empty string", ""],
    ["a token with no signature segment", "payloadonly"],
    ["a token with an empty signature segment", "payload."],
    ["a token with an empty payload segment", ".signature"],
  ])("refuses %s as 404 not_found", (_label, handle) => {
    // Act
    const refusal = refusalOf(() =>
      resolveMultipartHandle({
        service: handleService(),
        handle,
        presentingUserId: OWNER_USER_ID,
        uploadSessionId: SESSION_A,
      })
    );

    // Assert
    expect(refusal).toMatchObject({ code: "not_found", status: 404 });
  });
});
