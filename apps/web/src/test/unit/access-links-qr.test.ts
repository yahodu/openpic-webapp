import { describe, expect, it } from "vitest";

import { AppError } from "@/server/http/app-error";
import {
  buildAccessLinkShareUrl,
  buildQrPayloadUrl,
  parseQrQuery,
} from "@/server/events/access-links";

/**
 * Unit — the access-link URL builders and the QR query validator (OP-118 U1/U2,
 * contract §4.2, schema §15.1).
 *
 * ## Contract expected of the implementation
 *
 * `@/server/events/access-links` exports:
 *
 * - `buildAccessLinkShareUrl(baseUrl: string, slug: string): string` — the
 *   public event link `${baseUrl}/e/${slug}` (the `shareUrl` the rotate answer
 *   and the Event DTO carry).
 * - `buildQrPayloadUrl(baseUrl: string, slug: string): string` — the string the
 *   generated QR image encodes. It is the **public** share link (the attendee
 *   scans it with a phone camera), so it is built from the app's configured
 *   `APP_BASE_URL` — never from a hardcoded host and never from the request's
 *   own origin.
 * - `parseQrQuery(searchParams: URLSearchParams): { format, size }` — the
 *   `?format=png|svg|pdf&size=256..2048` validator; a value outside the
 *   contract's domain throws `AppError("validation_failed")` (422) with
 *   `details.fields[].path` naming the offending query parameter.
 *
 * Both builders must tolerate a trailing slash on the configured base URL
 * (`APP_BASE_URL` is an absolute URL; `https://openpic.in/` is a legal value)
 * so the public link never contains `//e/`.
 *
 * ## Assumptions (ADR-0620 §Assumptions)
 *
 * - A1 — the two builders take the base URL as an **argument**; reading
 *   `getConfig()` inside them is not pinned here because the integration suite
 *   observes the configuration wiring on the wire (`shareUrl`).
 * - A2 — the QR payload is exactly the share URL today. The separate function
 *   is the seam a later per-channel tracking parameter would use; pinning them
 *   equal keeps one public link, not two.
 * - A3 — both query parameters are **optional** with `format=png` and
 *   `size=1024` defaults, mirroring the contract's own example
 *   (`?format=png&size=1024`). Only bounds and membership are pinned below.
 */

/** Capture whatever `run` throws, so the assertion names the real failure. */
function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw, but it returned");
}

/** The `details.fields[].path` values of a thrown validation refusal. */
function fieldPaths(error: unknown): string[] {
  if (!(error instanceof AppError)) {
    throw new Error(
      `expected an AppError, received ${error === null ? "null" : typeof error}: ${String(error)}`
    );
  }
  const fields = error.details?.fields;
  if (!Array.isArray(fields)) {
    return [];
  }
  return fields.map((entry: unknown): string => {
    if (entry !== null && typeof entry === "object" && "path" in entry) {
      const path: unknown = entry.path;
      return typeof path === "string" ? path : "";
    }
    return "";
  });
}

/** Assert the refusal is the 422 that names `field`. */
function expectFieldRefusal(run: () => unknown, field: string): void {
  const error = caught(run);
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ code: "validation_failed", status: 422 });
  expect(fieldPaths(error)).toContain(field);
}

describe("U1 — the QR payload builder uses the configured public base URL", () => {
  it("U1: builds the public share link from the base URL it is given", () => {
    expect(buildQrPayloadUrl("https://openpic.in", "k7m2xq9p")).toBe(
      "https://openpic.in/e/k7m2xq9p"
    );
  });

  it("U1: uses the configured host verbatim rather than a hardcoded origin", () => {
    expect(buildQrPayloadUrl("https://staging.openpic.test:8443", "k7m2xq9p")).toBe(
      "https://staging.openpic.test:8443/e/k7m2xq9p"
    );
  });

  it("U1: a trailing slash on the base URL does not produce a doubled separator", () => {
    expect(buildQrPayloadUrl("https://openpic.in/", "k7m2xq9p")).toBe(
      "https://openpic.in/e/k7m2xq9p"
    );
  });

  it("U1: the QR payload is the same public link the shareUrl carries", () => {
    expect(buildQrPayloadUrl("https://openpic.in", "p9z4nn2k")).toBe(
      buildAccessLinkShareUrl("https://openpic.in", "p9z4nn2k")
    );
  });
});

describe("U2 — the QR size/format validator", () => {
  it.each([
    ["png", 256],
    ["svg", 512],
    ["pdf", 1024],
    ["png", 2048],
  ])("U2: accepts format=%s at the in-range size %i", (format, size) => {
    expect(parseQrQuery(new URLSearchParams({ format, size: String(size) }))).toEqual({
      format,
      size,
    });
  });

  it("U2: an absent format and size default to png at 1024", () => {
    expect(parseQrQuery(new URLSearchParams())).toEqual({ format: "png", size: 1024 });
  });

  it("U2: rejects size 4096 (above the 2048 ceiling) as 422 naming size", () => {
    expectFieldRefusal(
      () => parseQrQuery(new URLSearchParams({ format: "png", size: "4096" })),
      "size"
    );
  });

  it("U2: rejects size 255 (below the 256 floor) as 422 naming size", () => {
    expectFieldRefusal(
      () => parseQrQuery(new URLSearchParams({ format: "png", size: "255" })),
      "size"
    );
  });

  it.each([
    ["a fractional size", "512.5"],
    ["a non-numeric size", "large"],
  ])("U2: rejects %s as 422 naming size", (_label, size) => {
    expectFieldRefusal(() => parseQrQuery(new URLSearchParams({ size })), "size");
  });

  it("U2: rejects an unsupported format as 422 naming format", () => {
    expectFieldRefusal(
      () => parseQrQuery(new URLSearchParams({ format: "gif", size: "1024" })),
      "format"
    );
  });
});
