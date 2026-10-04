import { describe, expect, it } from "vitest";

import { rateLimitHeaders, rateLimitKey, strictestRateLimitResult } from "@/server/rate-limit";

/**
 * U2 + U3 — strictest-of-multiple resolution and contract headers (§0.11).
 *
 * A class can be keyed by more than one identity (e.g. auth.otp is keyed by the
 * contact *and* the IP); the stricter of the listed limits applies, so the
 * outcome is driven by the visit with the fewest remaining tokens. The wire
 * headers are a fixed shape so a client can branch on them without guessing.
 */

describe("strictestRateLimitResult", () => {
  it("U2: picks the result with the fewest remaining tokens", () => {
    const strictest = strictestRateLimitResult([
      { success: true, limit: 15, remaining: 3, resetSeconds: 40 },
      { success: false, limit: 5, remaining: 0, resetSeconds: 37 },
    ]);

    expect(strictest).toEqual({ success: false, limit: 5, remaining: 0, resetSeconds: 37 });
  });

  it("U2: reports success only when every contributing result succeeded", () => {
    const strictest = strictestRateLimitResult([
      { success: true, limit: 60, remaining: 10, resetSeconds: 30 },
      { success: true, limit: 300, remaining: 200, resetSeconds: 30 },
    ]);

    expect(strictest.success).toBe(true);
    expect(strictest.remaining).toBe(10);
    expect(strictest.limit).toBe(60);
  });

  it("U2: denies when the minimum-remaining result is allowed but another result is denied", () => {
    // The binding constraint (fewest remaining) happens to be the *allowed* key
    // here, while a second key is already denied. Success must still be the AND
    // over every key, so the request is denied; the numbers still describe the
    // minimum-remaining key, not the denied one.
    const strictest = strictestRateLimitResult([
      { success: true, limit: 5, remaining: 0, resetSeconds: 12 },
      { success: false, limit: 15, remaining: 5, resetSeconds: 40 },
    ]);

    expect(strictest).toEqual({ success: false, limit: 5, remaining: 0, resetSeconds: 12 });
  });
});

describe("rateLimitHeaders", () => {
  it("U3: formats the success headers exactly per contract §0.11", () => {
    expect(rateLimitHeaders({ success: true, limit: 60, remaining: 59, resetSeconds: 37 })).toEqual(
      {
        "RateLimit-Limit": "60",
        "RateLimit-Remaining": "59",
        "RateLimit-Reset": "37",
      }
    );
  });

  it("U3: adds Retry-After for a denied result", () => {
    expect(rateLimitHeaders({ success: false, limit: 60, remaining: 0, resetSeconds: 37 })).toEqual(
      {
        "RateLimit-Limit": "60",
        "RateLimit-Remaining": "0",
        "RateLimit-Reset": "37",
        "Retry-After": "37",
      }
    );
  });
});

describe("rateLimitKey", () => {
  it("U2: namespaces the key by class and scope so two scopes never collide", () => {
    const key = rateLimitKey("write.normal", "user", "abc123");

    expect(key).toBe("write.normal:user:abc123");
    expect(rateLimitKey("write.normal", "ip", "abc123")).not.toBe(key);
  });
});
