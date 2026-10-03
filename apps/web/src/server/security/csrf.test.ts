import { describe, expect, it } from "vitest";

import { decideCsrf } from "@/server/security/csrf";
import { ALLOWED_ORIGINS, makeCsrfFacts } from "@/test/factories/csrf";

/**
 * U1 — the CSRF + internal-route decision table (OP-78, edge security).
 *
 * `decideCsrf(facts, allowedOrigins)` is the pure heart of `src/middleware.ts`:
 * a single, side-effect-free function that says whether the edge gate lets a
 * request continue or rejects it. It is exercised directly so the whole rule
 * table is pinned without standing up a Next.js server.
 *
 * Contract:
 *   - Signals: `"allow"` lets the request continue; a deny carries the
 *     `reason` the middleware maps to a 403 `csrf_failed` (or, for an internal
 *     route, a 403 `forbidden`) envelope and a `security.csrf_failed` warn log.
 *   - Safe methods (GET/HEAD/OPTIONS) never change state, so they always pass.
 *   - A `Bearer` request is not driven by an ambient cookie, so it is exempt.
 *   - Exempt path classes: `/api/auth/**` (Better Auth has its own origin
 *     checks) and `/api/v1/webhooks/**` (signature-verified).
 *   - `/api/v1/internal/**` is server-to-server only: any browser `Origin`
 *     header is rejected, but a request with no `Origin` passes.
 *   - Every other state-changing request is only subject to CSRF when it is
 *     cookie-authenticated; then it needs an allowlisted `Origin` AND
 *     `X-Requested-With: XMLHttpRequest`.
 */
describe("decideCsrf — U1 decision table", () => {
  describe("cookie-authenticated state-changing requests", () => {
    it("allows a POST with an allowlisted Origin and the XMLHttpRequest header", () => {
      const decision = decideCsrf(makeCsrfFacts(), ALLOWED_ORIGINS);

      expect(decision).toEqual({ allowed: true });
    });

    it("denies a POST with an allowlisted Origin but no X-Requested-With header", () => {
      const decision = decideCsrf(makeCsrfFacts({ requestedWith: null }), ALLOWED_ORIGINS);

      expect(decision).toEqual({ allowed: false, reason: "missing_csrf_header" });
    });

    it("denies a POST with a foreign Origin even when the header is present", () => {
      const decision = decideCsrf(
        makeCsrfFacts({ origin: "https://evil.example" }),
        ALLOWED_ORIGINS
      );

      expect(decision).toEqual({ allowed: false, reason: "origin_not_allowed" });
    });

    it("denies a POST with no Origin header at all", () => {
      const decision = decideCsrf(makeCsrfFacts({ origin: null }), ALLOWED_ORIGINS);

      expect(decision).toEqual({ allowed: false, reason: "origin_not_allowed" });
    });

    it.each(["PUT", "PATCH", "DELETE"])("applies the same origin rule to %s", (method: string) => {
      const decision = decideCsrf(
        makeCsrfFacts({ method, origin: "https://evil.example" }),
        ALLOWED_ORIGINS
      );

      expect(decision).toEqual({ allowed: false, reason: "origin_not_allowed" });
    });
  });

  describe("exemptions", () => {
    it("allows a Bearer-authenticated POST without any CSRF signal", () => {
      const decision = decideCsrf(
        makeCsrfFacts({
          authorization: "Bearer opat_example-token",
          origin: null,
          requestedWith: null,
        }),
        ALLOWED_ORIGINS
      );

      expect(decision).toEqual({ allowed: true });
    });

    it.each(["GET", "HEAD", "OPTIONS"])("allows the safe method %s", (method: string) => {
      const decision = decideCsrf(
        makeCsrfFacts({ method, origin: null, requestedWith: null }),
        ALLOWED_ORIGINS
      );

      expect(decision).toEqual({ allowed: true });
    });

    it("allows a webhook POST with a foreign Origin and no CSRF header", () => {
      const decision = decideCsrf(
        makeCsrfFacts({
          path: "/api/v1/webhooks/stripe",
          origin: "https://evil.example",
          requestedWith: null,
        }),
        ALLOWED_ORIGINS
      );

      expect(decision).toEqual({ allowed: true });
    });

    it("allows an auth POST with a foreign Origin and no CSRF header", () => {
      const decision = decideCsrf(
        makeCsrfFacts({
          path: "/api/auth/sign-in/email",
          origin: "https://evil.example",
          requestedWith: null,
        }),
        ALLOWED_ORIGINS
      );

      expect(decision).toEqual({ allowed: true });
    });

    it("does not require CSRF signals for a non-cookie POST (no ambient authority)", () => {
      const decision = decideCsrf(
        makeCsrfFacts({
          hasSessionCookie: false,
          origin: "https://evil.example",
          requestedWith: null,
        }),
        ALLOWED_ORIGINS
      );

      expect(decision).toEqual({ allowed: true });
    });
  });

  describe("internal-route shielding", () => {
    it("denies an internal route called with a browser Origin header", () => {
      const decision = decideCsrf(
        makeCsrfFacts({
          path: "/api/v1/internal/jobs/reap",
          origin: "https://app.openpic.test",
        }),
        ALLOWED_ORIGINS
      );

      expect(decision).toEqual({ allowed: false, reason: "internal_origin" });
    });

    it("allows an internal route called without an Origin header (server-to-server)", () => {
      const decision = decideCsrf(
        makeCsrfFacts({
          path: "/api/v1/internal/jobs/reap",
          origin: null,
          requestedWith: null,
          hasSessionCookie: false,
        }),
        ALLOWED_ORIGINS
      );

      expect(decision).toEqual({ allowed: true });
    });
  });

  describe("exact-match details", () => {
    it("treats a lowercased header value as missing (case-sensitive per contract)", () => {
      const decision = decideCsrf(
        makeCsrfFacts({ requestedWith: "xmlhttprequest" }),
        ALLOWED_ORIGINS
      );

      expect(decision).toEqual({ allowed: false, reason: "missing_csrf_header" });
    });

    it("does not confuse an allowlisted prefix with an exact origin match", () => {
      const decision = decideCsrf(
        makeCsrfFacts({ origin: "http://localhost:3000.evil.example" }),
        ALLOWED_ORIGINS
      );

      expect(decision).toEqual({ allowed: false, reason: "origin_not_allowed" });
    });

    it("treats a lowercased GET as a safe method", () => {
      const decision = decideCsrf(makeCsrfFacts({ method: "get" }), ALLOWED_ORIGINS);

      expect(decision).toEqual({ allowed: true });
    });
  });
});
