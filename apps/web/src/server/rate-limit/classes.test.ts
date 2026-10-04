import { describe, expect, it } from "vitest";

import {
  RATE_LIMIT_BYPASS_CLASSES,
  RATE_LIMIT_CLASSES,
  isRateLimitBypassed,
  rateLimitFailurePolicy,
  type RateLimitClass,
} from "@/server/rate-limit";

/**
 * U4 + U5 — the class table, failure policy and webhook bypass (contract §0.11).
 *
 * The class table is the executable copy of the §0.11 table: every class in the
 * contract is configured, with the documented limit and window. The failure
 * policy is per class: abuse-prone auth/selfie/liveness classes fail closed,
 * ordinary read/write classes fail open. Webhooks are never limited.
 */

const CONTRACT_CLASSES: readonly RateLimitClass[] = [
  "auth.otp",
  "auth.verify",
  "read.hot",
  "read.normal",
  "write.normal",
  "upload.resolve",
  "upload.sign",
  "upload.complete",
  "selfie.submit",
  "liveness.challenge",
  "public.gallery",
  "media.sign",
  "admin",
  "webhook",
  "internal",
];

describe("rate-limit class table (contract §0.11)", () => {
  it("configures every class named in the contract and no others", () => {
    expect(Object.keys(RATE_LIMIT_CLASSES).sort()).toEqual([...CONTRACT_CLASSES].sort());
  });

  it("configures write.normal at 60 / minute keyed by the principal", () => {
    expect(RATE_LIMIT_CLASSES["write.normal"]).toEqual([
      { scope: "user", limit: 60, windowSeconds: 60 },
    ]);
  });

  it("configures auth.otp as contact 5 / hour and IP 15 / hour", () => {
    expect(RATE_LIMIT_CLASSES["auth.otp"]).toEqual([
      { scope: "contact", limit: 5, windowSeconds: 3600 },
      { scope: "ip", limit: 15, windowSeconds: 3600 },
    ]);
  });

  it("configures selfie.submit as attendee 6 / hour and IP 20 / hour", () => {
    expect(RATE_LIMIT_CLASSES["selfie.submit"]).toEqual([
      { scope: "attendee", limit: 6, windowSeconds: 3600 },
      { scope: "ip", limit: 20, windowSeconds: 3600 },
    ]);
  });

  it("configures upload.sign at the deliberately high 900 / minute", () => {
    expect(RATE_LIMIT_CLASSES["upload.sign"]).toEqual([
      { scope: "user", limit: 900, windowSeconds: 60 },
    ]);
  });
});

describe("failure policy", () => {
  it.each<RateLimitClass>(["auth.otp", "auth.verify", "selfie.submit", "liveness.challenge"])(
    "U4: %s fails closed",
    (classKey) => {
      expect(rateLimitFailurePolicy(classKey)).toBe("fail-closed");
    }
  );

  it.each<RateLimitClass>([
    "read.hot",
    "read.normal",
    "write.normal",
    "public.gallery",
    "internal",
  ])("U4: %s fails open", (classKey) => {
    expect(rateLimitFailurePolicy(classKey)).toBe("fail-open");
  });
});

describe("webhook bypass", () => {
  it("U5: marks the webhook class as bypassed", () => {
    expect(isRateLimitBypassed("webhook")).toBe(true);
    expect(RATE_LIMIT_BYPASS_CLASSES.has("webhook")).toBe(true);
  });

  it("U5: does not bypass any other class", () => {
    expect(isRateLimitBypassed("write.normal")).toBe(false);
    expect(RATE_LIMIT_BYPASS_CLASSES.size).toBe(1);
  });
});
