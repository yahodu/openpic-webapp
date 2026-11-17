import { describe, expect, it } from "vitest";

import {
  decideExistingSubscription,
  isAllowedReturnUrl,
  type ExistingSubscriptionFacts,
} from "@/server/services/subscriptions/checkout";

/**
 * Unit contract — the checkout decisions (OP-107 RED, contract §3.3; ADR-0420).
 *
 * `POST /tenants/{tenantId}/billing/checkout` is the one place a workspace turns
 * into a paying one, so the two decisions it makes before touching a provider
 * are pure functions here, pinned away from Mongo and from the HTTP pipeline:
 *
 *   - **U1** `isAllowedReturnUrl` — a `returnUrl` is accepted only when its
 *     **origin** is on the allow-list. A `startsWith`-style comparison is the
 *     classic open-redirect bug: `https://app.openpic.in.evil.com` and
 *     `https://app.openpic.in@evil.com` both share the allow-listed prefix while
 *     resolving somewhere else entirely, and `http:` downgrades the scheme. A
 *     URL carrying credentials is refused outright — no legitimate return URL
 *     has any.
 *   - **U2** `decideExistingSubscription` — the decision table §3.3 describes:
 *     no document (or a terminal one) starts a checkout, a live row is `409`
 *     `subscription_already_active`, and an `incomplete` row is *reused* while
 *     its hosted link is still valid and *restarted* (the stale row is expired,
 *     then a fresh one begins) once it is not.
 *
 * The table is exhaustive: every stored status the schema can hold appears, plus
 * the four boundary shapes of an `incomplete` row (valid link, expired link,
 * no link, link expiring exactly now).
 */

/** The origin allow-list the app serves its own billing return page on. */
const ALLOWED_ORIGINS: readonly string[] = ["https://app.openpic.in", "https://openpic.in"];

/** A `returnUrl` and whether the allow-list must accept it. */
type ReturnUrlCase = readonly [description: string, returnUrl: string, allowed: boolean];

const RETURN_URL_CASES: readonly ReturnUrlCase[] = [
  ["an allow-listed origin", "https://app.openpic.in/billing/return", true],
  [
    "an allow-listed origin with a query string",
    "https://app.openpic.in/billing/return?state=abc",
    true,
  ],
  ["a second allow-listed origin", "https://openpic.in/billing/return", true],
  [
    "a plain-http downgrade of an allow-listed origin",
    "http://app.openpic.in/billing/return",
    false,
  ],
  [
    "a look-alike suffix host (`app.openpic.in.evil.com`)",
    "https://app.openpic.in.evil.com/billing/return",
    false,
  ],
  [
    "userinfo that hides the real host (`app.openpic.in@evil.com`)",
    "https://app.openpic.in@evil.com/billing/return",
    false,
  ],
  [
    "credentials on an allow-listed host",
    "https://user:secret@app.openpic.in/billing/return",
    false,
  ],
  ["a non-allow-listed subdomain", "https://evil.openpic.in/billing/return", false],
  ["a different port on an allow-listed host", "https://app.openpic.in:8443/billing/return", false],
  ["an unrelated host", "https://evil.example.com/billing/return", false],
  ["a relative path", "/billing/return", false],
  ["a `javascript:` URL", "javascript:alert(1)", false],
  ["an empty string", "", false],
];

/** The instant every decision case is measured from. */
const NOW = new Date("2026-10-25T10:00:00.000Z");

/** The id of the stored row every case is about. */
const SUBSCRIPTION_ID = "65f0000000000000000000aa";

/** The stored-row fields a decision case may vary. */
interface FactsOverrides {
  readonly subscriptionId?: string;
  readonly status?: ExistingSubscriptionFacts["status"];
  readonly cancelledAt?: ExistingSubscriptionFacts["cancelledAt"];
  readonly checkout?: ExistingSubscriptionFacts["checkout"];
}

/** The hosted-mandate link a healthy `incomplete` row carries. */
const STORED_CHECKOUT = {
  url: "https://psp.example.com/checkout/abc",
  expiresAt: new Date("2026-10-25T10:15:00.000Z"),
} as const;

/** Build the stored-row facts the decision reads, with any field overridden. */
function existing(overrides: FactsOverrides = {}): ExistingSubscriptionFacts {
  return {
    subscriptionId: overrides.subscriptionId ?? SUBSCRIPTION_ID,
    status: overrides.status ?? "incomplete",
    cancelledAt: overrides.cancelledAt ?? null,
    // `null` is a *fact* here ("the row stores no hosted link"), not "not
    // supplied": `??` would swallow it and hand back the default valid link, so
    // the "no stored link" case would be value-identical to the "link is still
    // valid" case and no implementation could satisfy both decisions.
    checkout: overrides.checkout === undefined ? STORED_CHECKOUT : overrides.checkout,
  };
}

/** The expected decision `kind` for a row shape. */
type DecisionCase = readonly [description: string, facts: ExistingSubscriptionFacts, kind: string];

const DECISION_CASES: readonly DecisionCase[] = [
  [
    "a cancelled row",
    existing({
      status: "cancelled",
      cancelledAt: new Date("2026-10-01T00:00:00.000Z"),
      checkout: null,
    }),
    "start",
  ],
  ["an expired row", existing({ status: "expired", checkout: null }), "start"],
  ["an `incomplete` row whose hosted link is still valid", existing(), "reuse"],
  [
    "an `incomplete` row whose hosted link has already expired",
    existing({
      checkout: {
        url: "https://psp.example.com/checkout/abc",
        expiresAt: new Date("2026-10-25T09:45:00.000Z"),
      },
    }),
    "restart",
  ],
  [
    "an `incomplete` row whose hosted link expires exactly now",
    existing({ checkout: { url: "https://psp.example.com/checkout/abc", expiresAt: NOW } }),
    "restart",
  ],
  ["an `incomplete` row with no stored link", existing({ checkout: null }), "restart"],
  ["an `active` row", existing({ status: "active" }), "blocked"],
  ["a `past_due` row", existing({ status: "past_due" }), "blocked"],
  ["a `downgraded` row", existing({ status: "downgraded" }), "blocked"],
];

describe("isAllowedReturnUrl", () => {
  it.each(RETURN_URL_CASES)("accepts %s only on its origin", (_description, returnUrl, allowed) => {
    expect(isAllowedReturnUrl(returnUrl, ALLOWED_ORIGINS)).toBe(allowed);
  });

  it("rejects every URL when the allow-list is empty", () => {
    expect(isAllowedReturnUrl("https://app.openpic.in/billing/return", [])).toBe(false);
  });
});

describe("decideExistingSubscription", () => {
  it("starts a fresh checkout when the workspace has no subscription document at all", () => {
    expect(decideExistingSubscription(null, NOW).kind).toBe("start");
  });

  it.each(DECISION_CASES)("decides `%s` as %s", (_description, facts, kind) => {
    expect(decideExistingSubscription(facts, NOW).kind).toBe(kind);
  });

  it("reuses the stored link and echoes the workspace's existing subscription id", () => {
    const decision = decideExistingSubscription(existing(), NOW);

    expect(decision).toEqual({
      kind: "reuse",
      subscriptionId: SUBSCRIPTION_ID,
      checkout: {
        url: "https://psp.example.com/checkout/abc",
        expiresAt: new Date("2026-10-25T10:15:00.000Z"),
      },
    });
  });

  it("names the stale row to retire when restarting a checkout", () => {
    const decision = decideExistingSubscription(existing({ checkout: null }), NOW);

    expect(decision).toEqual({ kind: "restart", subscriptionId: SUBSCRIPTION_ID });
  });

  it("reports the blocking row's id and status when a live subscription exists", () => {
    const decision = decideExistingSubscription(existing({ status: "active" }), NOW);

    expect(decision).toEqual({
      kind: "blocked",
      subscriptionId: SUBSCRIPTION_ID,
      status: "active",
    });
  });
});
