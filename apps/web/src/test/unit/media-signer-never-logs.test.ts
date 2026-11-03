import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger, memoryTransport, setLogger, type MemoryTransport } from "@/server/logging";
import { createMediaSigner } from "@/server/media/signer";
import { fixedClock } from "@/server/runtime/clock";

import {
  TEST_MEDIA_CONTENT_HASH,
  TEST_MEDIA_SIGNING_SECRET_CURRENT,
  makeSignMediaInput,
} from "../factories/media";

/**
 * OP-113 round-1 follow-up (ADR-0585) — the pure signer **itself** logs
 * nothing, so no signed URL can leave it through a sink.
 *
 * ADR-0582/ADR-0583 require "never log full signed URLs; log counts of URLs
 * signed at debug". The module that mints the URL is the innermost place that
 * could break that property, and today it has no logging seam at all: this
 * spec pins the absence behaviourally (no entry through the process logging
 * port, no `console.*` call) rather than by reading the source, so a future
 * refactor that adds a logger in any shape — barrel, child logger, console —
 * reddens the pin.
 *
 * The route-level half of the property lives in
 * `test/integration/media-signed-url-never-logged.test.ts` (the branding
 * upload route, the composition boundary that signs today), and the lint half
 * in `test/unit/eslint/media-signer-no-logging-lint.test.ts`.
 */

const T0 = new Date("2026-10-26T00:00:00.000Z");

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Install a `debug`-floored memory logger as the process logger.
 *
 * @returns The sink every entry the port emits lands in.
 */
function captureLogs(): MemoryTransport {
  const sink = memoryTransport();
  setLogger(
    createLogger({
      level: "debug",
      transports: [sink],
      service: "openpic-web",
      env: "test",
      version: "test-sha",
    })
  );
  return sink;
}

describe("the media signer never logs (OP-113 follow-up, ADR-0585)", () => {
  it("emits no log entry through the process logging port while signing and verifying", () => {
    // Arrange — a live, debug-floored capture.
    const sink = captureLogs();
    const signer = createMediaSigner({
      currentSecret: TEST_MEDIA_SIGNING_SECRET_CURRENT,
      clock: fixedClock(T0),
    });

    // Act — every derivative kind, and both verify outcomes.
    const signed = [
      signer.sign(makeSignMediaInput({ kind: "thumbnail" })),
      signer.sign(makeSignMediaInput({ kind: "original" })),
      signer.sign(makeSignMediaInput({ kind: "preview" })),
      signer.sign(makeSignMediaInput({ kind: "export" })),
    ];
    const verified = signed.map(({ url }) => signer.verify(url));
    signer.verify("https://pic.openpic.in/t/tampered.jpg?exp=1&sig=nope");

    // Assert — the signer really signed and verified, and nothing was logged.
    expect(verified).toEqual([true, true, true, true]);
    expect(sink.entries).toEqual([]);
  });

  it("writes nothing to the console while signing", () => {
    // Arrange — every console sink a leak could reach.
    const consoleSinks = (["log", "info", "warn", "error", "debug", "trace"] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => undefined)
    );
    const signer = createMediaSigner({
      currentSecret: TEST_MEDIA_SIGNING_SECRET_CURRENT,
      clock: fixedClock(T0),
    });

    // Act
    const { url } = signer.sign(
      { kind: "original", contentHash: TEST_MEDIA_CONTENT_HASH, ext: "jpg" },
      300
    );
    signer.verify(url);

    // Assert — no console method received the URL (or anything else).
    for (const spy of consoleSinks) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
