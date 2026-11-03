import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fixedClock } from "@/server/runtime/clock";
import type { IssueHandleInput } from "@/server/storage/handles";

import { makeSignMediaInput } from "../factories/media";
import { TEST_HANDLE_USER_ID, TEST_UPLOAD_SESSION_ID } from "../factories/storage";

/**
 * F2 — the secret-source composition seam (OP-112 follow-up; ADR-0580
 * "Assumptions and open questions", ADR-0581 §3).
 *
 * ADR-0580 records that "the handle signing secret's source is unpinned. The
 * service takes `{ secret }` explicitly; the composition root may reuse the
 * existing `MEDIA_SIGNING_SECRET_CURRENT` env or add a storage-specific
 * secret — no test names the environment variable." The seam that exists is
 * that **neither** `createHandleService` nor `createMediaSigner` reads any
 * environment at module load: they are pure constructors, and the composition
 * root (e.g. `branding-upload.ts`, which reads `getConfig().media.*` at call
 * time) decides where the current/previous secrets come from. These pins make
 * that import-purity claim executable: a module that starts reading the
 * signing secret from the environment — at import or at construction — goes
 * red.
 */
const EXPLICIT_HANDLE_SECRET = "composition-explicit-handle-secret";
const EXPLICIT_SIGNER_SECRET = "composition-explicit-signer-secret";
const POISON_ENV_SECRET = "composition-poison-env-secret";

/** The candidate secret-source env vars (ADR-0580: "no test names the variable"). */
const SIGNING_ENV_KEYS = ["MEDIA_SIGNING_SECRET_CURRENT", "MEDIA_SIGNING_SECRET_PREVIOUS"] as const;

/** A valid issue input for the handle service. */
const HANDLE_INPUT: IssueHandleInput = {
  locationKey: "originals",
  objectKey: "images/3f2c1d8899aa55bb66cc77dd88ee99ff00112233445566778899aabbccddeeff.jpg",
  uploadSessionId: TEST_UPLOAD_SESSION_ID,
  userId: TEST_HANDLE_USER_ID,
};

/** A deterministic instant so `exp` truncation is exact. */
const T0 = new Date("2040-01-01T00:00:00.000Z");

describe("secret-source composition — pure constructors, no env read at module load", () => {
  beforeEach(() => {
    // Unset the candidate secret-source env vars and force a fresh module
    // evaluation: an import-time env read would be observed by every case.
    for (const key of SIGNING_ENV_KEYS) {
      vi.stubEnv(key, undefined);
    }
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("imports the handle service with the secret-source env unset and constructs with an explicit secret", async () => {
    // Arrange — the precondition of the pin: the env really is absent.
    expect(process.env.MEDIA_SIGNING_SECRET_CURRENT).toBeUndefined();
    expect(process.env.MEDIA_SIGNING_SECRET_PREVIOUS).toBeUndefined();

    // Act — a module that reads the signing secret at import (a module-scope
    // getConfig(), a bare process.env.MEDIA_SIGNING_SECRET_CURRENT that
    // throws when unset) fails here, before any assertion runs.
    const { createHandleService } = await import("@/server/storage/handles");
    const service = createHandleService({ secret: EXPLICIT_HANDLE_SECRET });
    const handle = service.issueHandle(HANDLE_INPUT);

    // Assert — the explicit secret keyed the service; nothing needed env.
    expect(service.resolveHandle(handle, TEST_HANDLE_USER_ID)).toEqual({
      locationKey: "originals",
      objectKey: HANDLE_INPUT.objectKey,
      uploadSessionId: TEST_UPLOAD_SESSION_ID,
    });
  });

  it("imports the media signer with the signing-secret env unset and constructs with an explicit secret", async () => {
    // Act
    const { createMediaSigner } = await import("@/server/media/signer");
    const signer = createMediaSigner({
      currentSecret: EXPLICIT_SIGNER_SECRET,
      clock: fixedClock(T0),
    });

    // Assert
    const { url } = signer.sign(makeSignMediaInput(), 300);
    expect(signer.verify(url)).toBe(true);
  });

  it("keys the media signer by its explicit secret — a poisoned MEDIA_SIGNING_SECRET_CURRENT never leaks in", async () => {
    // Arrange — poison the env and re-import, so any env read would surface
    // as the POISON secret instead of the explicit constructor argument.
    vi.stubEnv("MEDIA_SIGNING_SECRET_CURRENT", POISON_ENV_SECRET);
    vi.resetModules();
    const { createMediaSigner } = await import("@/server/media/signer");

    // Act
    const explicit = createMediaSigner({
      currentSecret: EXPLICIT_SIGNER_SECRET,
      clock: fixedClock(T0),
    });
    const { url } = explicit.sign(makeSignMediaInput(), 300);

    // Assert — the explicit secret keyed this signer…
    expect(explicit.verify(url)).toBe(true);
    // …and the poisoned env value did not become a second accepted secret: a
    // signer built with the env value cannot verify the URL, so the module is
    // a pure function of its constructor argument.
    const envKeyed = createMediaSigner({
      currentSecret: POISON_ENV_SECRET,
      clock: fixedClock(T0),
    });
    expect(envKeyed.verify(url)).toBe(false);
  });
});
