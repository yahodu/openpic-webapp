import { describe, expect, it } from "vitest";

import { resolveClientIp } from "@/server/rate-limit";

/**
 * Unit pins for the client-IP trust model (OP-85 follow-up, ADR-0024).
 *
 * `resolveClientIp` picks the rate-limit IP identity from forwarding headers.
 * An IP-keyed limit is only as strong as the IP it is keyed by, and
 * `x-forwarded-for` is a comma-separated, **client-writable** list — a caller
 * can rotate or prepend to it. The durable fix is to name a header the trusted
 * fronting layer *overwrites* (e.g. `cf-connecting-ip`, `x-real-ip`) via
 * `TRUSTED_CLIENT_IP_HEADER`; when such a header is configured it is the ONLY
 * source consulted, and when it is configured but absent the resolver must
 * fail safe (`undefined`) rather than silently fall back to the forgeable list.
 *
 * These specs pin that contract directly on the resolver, independent of the
 * deployment wiring in `getTrustedClientIpHeader()`.
 */

const TRUSTED = "cf-connecting-ip";

describe("resolveClientIp — configured trusted header precedence (ADR-0024)", () => {
  it("returns the configured trusted header value and ignores x-forwarded-for", () => {
    const headers = new Headers({
      "cf-connecting-ip": "203.0.113.7",
      // A client-forged / rotating list that must never win.
      "x-forwarded-for": "198.51.100.9, 203.0.113.7",
      "x-real-ip": "192.0.2.1",
    });

    expect(resolveClientIp(headers, TRUSTED)).toBe("203.0.113.7");
  });

  it("trims surrounding whitespace from the configured trusted header value", () => {
    const headers = new Headers({
      "cf-connecting-ip": "  203.0.113.7  ",
      "x-forwarded-for": "198.51.100.9",
    });

    expect(resolveClientIp(headers, TRUSTED)).toBe("203.0.113.7");
  });
});

describe("resolveClientIp — configured-but-absent trusted header fails safe", () => {
  it("returns undefined when the configured trusted header is absent, never the forgeable list", () => {
    const headers = new Headers({
      // Both fallback sources are present and would be trusted without the
      // configured knob — the resolver must ignore them entirely.
      "x-forwarded-for": "198.51.100.9, 10.0.0.1",
      "x-real-ip": "192.0.2.1",
    });

    expect(resolveClientIp(headers, TRUSTED)).toBeUndefined();
  });

  it("returns undefined when the configured trusted header is blank", () => {
    const headers = new Headers({
      "cf-connecting-ip": "   ",
      "x-forwarded-for": "198.51.100.9",
      "x-real-ip": "192.0.2.1",
    });

    expect(resolveClientIp(headers, TRUSTED)).toBeUndefined();
  });
});
