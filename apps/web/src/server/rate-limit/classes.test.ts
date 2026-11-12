import { describe, expect, it } from "vitest";

import {
  RATE_LIMIT_BYPASS_CLASSES,
  RATE_LIMIT_CLASSES,
  isRateLimitBypassed,
  rateLimitFailurePolicy,
  type RateLimitClass,
  type RateLimitFailurePolicy,
  type RateLimitRule,
} from "@/server/rate-limit";

/**
 * U4 + U5 — the class table, failure policy and webhook bypass (contract §0.11).
 *
 * The class table is the executable copy of the §0.11 table: every class in the
 * contract is configured, with the documented limit and window. The failure
 * policy is per class: abuse-prone auth/selfie/liveness classes fail closed,
 * ordinary read/write classes fail open. Webhooks are never limited.
 *
 * Every class and every rule is pinned exactly (not presence-only) so a class
 * can neither gain, lose nor drift a limit without failing this suite.
 *
 * `attendee.session` is the OP-129 follow-up row (finding F1, ADR-0787) and it is
 * part of the production union: ADR-0786 added the member, so the class table
 * (`RATE_LIMIT_CLASSES`, `Readonly<Record<RateLimitClass, readonly RateLimitRule[]>>`)
 * and the two policy sets (`FAIL_CLOSED_CLASSES` and `RATE_LIMIT_BYPASS_CLASSES`,
 * both `ReadonlySet<RateLimitClass>`) are typed on it. This suite names the row
 * with a `RateLimitClass` key, so no name is asserted into the union with a cast:
 * a rename or a removal of the member is a `tsc` error, not a silent string
 * mismatch. What stops drift is the exact pin, not the row's presence: the lane rule is
 * asserted with `toEqual` as `{ scope: "ip", limit: 60, windowSeconds: 3600 }` and
 * the fail-closed membership is asserted class by class, so the row can neither
 * gain, lose nor drift a limit — nor flip its failure policy — without failing this
 * suite.
 */

const CONTRACT_CLASSES: readonly string[] = [
  "auth.otp",
  "auth.verify",
  "read.hot",
  "read.normal",
  "write.normal",
  "upload.resolve",
  "upload.sign",
  "upload.complete",
  "attendee.session",
  "selfie.submit",
  "liveness.challenge",
  "public.gallery",
  "media.sign",
  "admin",
  "webhook",
  "internal",
];

/**
 * The exact §0.11 rules for every class, as executable expectations. A class
 * may be keyed by more than one scope (e.g. `auth.otp` is contact *and* IP);
 * the stricter limit then wins at evaluation time. `webhook` is present with
 * no rules because it is never limited.
 */
const CONTRACT_RULES: ReadonlyArray<readonly [RateLimitClass, readonly RateLimitRule[]]> = [
  [
    "auth.otp",
    [
      { scope: "contact", limit: 5, windowSeconds: 3600 },
      { scope: "ip", limit: 15, windowSeconds: 3600 },
    ],
  ],
  ["auth.verify", [{ scope: "contact", limit: 10, windowSeconds: 600 }]],
  ["read.hot", [{ scope: "user", limit: 60, windowSeconds: 60 }]],
  ["read.normal", [{ scope: "user", limit: 300, windowSeconds: 60 }]],
  ["write.normal", [{ scope: "user", limit: 60, windowSeconds: 60 }]],
  ["upload.resolve", [{ scope: "user", limit: 60, windowSeconds: 60 }]],
  ["upload.sign", [{ scope: "user", limit: 900, windowSeconds: 60 }]],
  ["upload.complete", [{ scope: "user", limit: 600, windowSeconds: 60 }]],
  [
    "selfie.submit",
    [
      { scope: "attendee", limit: 6, windowSeconds: 3600 },
      { scope: "ip", limit: 20, windowSeconds: 3600 },
    ],
  ],
  ["liveness.challenge", [{ scope: "attendee", limit: 12, windowSeconds: 3600 }]],
  [
    "public.gallery",
    [
      { scope: "attendee", limit: 120, windowSeconds: 60 },
      { scope: "ip", limit: 600, windowSeconds: 60 },
    ],
  ],
  ["media.sign", [{ scope: "user", limit: 120, windowSeconds: 60 }]],
  ["admin", [{ scope: "user", limit: 300, windowSeconds: 60 }]],
  ["webhook", []],
  ["internal", [{ scope: "user", limit: 600, windowSeconds: 60 }]],
];

/**
 * The §0.11 rows this lane adds to the executable table (OP-129 F1).
 *
 * The row is keyed by its `RateLimitClass` name, so the compiler holds it to the
 * production union: a renamed or removed member fails `tsc` instead of silently
 * missing the table. It carries the same exact `toEqual` assertion
 * `CONTRACT_RULES` does, so neither the limit nor the window can drift.
 */
const LANE_RULES: ReadonlyArray<readonly [RateLimitClass, readonly RateLimitRule[]]> = [
  ["attendee.session", [{ scope: "ip", limit: 60, windowSeconds: 3600 }]],
];

/**
 * The rules configured for a class, by its §0.11 name.
 *
 * @param classKey - The class name as the contract spells it.
 * @returns The configured rules.
 * @throws {Error} When the class is absent from the executable table.
 */
function rulesOf(classKey: RateLimitClass): readonly RateLimitRule[] {
  const entry = Object.entries(RATE_LIMIT_CLASSES).find(([name]) => name === classKey);
  if (entry === undefined) {
    throw new Error(`contract §0.11 class ${classKey} is missing from RATE_LIMIT_CLASSES`);
  }
  return entry[1];
}

/**
 * The failure policy for a class, by its §0.11 name.
 *
 * The parameter is the production `RateLimitClass`, so the name is checked
 * against the union at compile time and reaches `rateLimitFailurePolicy` with no
 * cast. `it.each` supplies union-typed keys, so a class the union does not carry
 * cannot be named here.
 *
 * @param classKey - The class name as the contract spells it.
 * @returns `"fail-closed"` or `"fail-open"`.
 */
function policyOf(classKey: RateLimitClass): RateLimitFailurePolicy {
  return rateLimitFailurePolicy(classKey);
}

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

  it.each(CONTRACT_RULES)("configures %s with exactly its §0.11 rules", (classKey, rules) => {
    expect(RATE_LIMIT_CLASSES).toHaveProperty(classKey, rules);
  });

  it.each(LANE_RULES)("configures %s with exactly its §0.11 rules", (classKey, rules) => {
    expect(rulesOf(classKey)).toEqual(rules);
  });
});

describe("failure policy", () => {
  /**
   * Classes that must deny when the limiter is unavailable.
   *
   * `attendee.session` is here for the reason the auth classes are: it is
   * unauthenticated and every allowed call writes a 30-day `attendeeSessions`
   * row, so an unavailable limiter must not degrade into an unbounded mint
   * (`auth.otp`, `selfie.submit` are the precedent — ADR-0787 §Decision).
   */
  const FAIL_CLOSED: readonly RateLimitClass[] = [
    "auth.otp",
    "auth.verify",
    "selfie.submit",
    "liveness.challenge",
    "attendee.session",
  ];

  const FAIL_OPEN: readonly RateLimitClass[] = [
    "read.hot",
    "read.normal",
    "write.normal",
    "upload.resolve",
    "upload.sign",
    "upload.complete",
    "media.sign",
    "public.gallery",
    "admin",
    "internal",
    "webhook",
  ];

  it("U4: assigns a policy to every contract class (none can be added unpoliced)", () => {
    expect([...FAIL_CLOSED, ...FAIL_OPEN].sort()).toEqual([...CONTRACT_CLASSES].sort());
  });

  it.each(FAIL_CLOSED)("U4: %s fails closed", (classKey) => {
    expect(policyOf(classKey)).toBe("fail-closed");
  });

  it.each(FAIL_OPEN)("U4: %s fails open", (classKey) => {
    expect(policyOf(classKey)).toBe("fail-open");
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
