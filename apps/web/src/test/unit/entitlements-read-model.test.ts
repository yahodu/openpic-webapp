import { describe, expect, it } from "vitest";

import { blockReasonFor, resetsAtFor } from "@/server/services/entitlements";

/**
 * Unit contract — the entitlements read model (OP-104, contract §3.5, schema
 * §14.2/§14.3).
 *
 * The `GET /tenants/{t}/entitlements` response exists so the UI can grey out
 * actions and show quota bars (contract §0.14). Two pieces of it are pure
 * functions of data the endpoint already resolved, so they are pinned here
 * rather than through a booted app:
 *
 *   - {@link resetsAtFor} — the next reset boundary a quota bar's countdown
 *     counts to; a function of the cadence alone.
 *   - {@link blockReasonFor} — the global banner's reason; a function of the
 *     subscription status and the resolved entitlement rows.
 *
 * The endpoint itself (the read, the role checks, the section shape) is pinned
 * against a replica set in `src/test/integration/entitlements-endpoints.test.ts`.
 *
 * ## Contract expected of the implementation
 *
 * ```
 * @/server/services/entitlements   (the existing barrel — re-export the two)
 *   resetsAtFor(resetPeriod: ResetPeriod, now: Date): Date | null
 *   blockReasonFor(
 *     subscriptionStatus: SubscriptionStatus,
 *     entitlements: readonly EntitlementQuota[]
 *   ): "plan_limit" | "payment_downgrade" | null
 * ```
 *
 * `ResetPeriod` is the stored `plans.entitlements[key].resetPeriod`
 * (`"monthly" | "yearly" | "lifetime" | "none"`).
 *
 * `EntitlementQuota` is the slice of a served entitlement row the banner needs:
 *
 * ```ts
 * interface EntitlementQuota {
 *   readonly enforcement: "hard" | "soft" | "policy" | "feature";
 *   readonly effectiveLimit: number | null;   // null = unlimited
 *   readonly used?: number | null;            // absent for event/attendee scope
 * }
 * ```
 *
 * `SubscriptionStatus` is the `subscriptions.status` enum plus `"none"` for a
 * tenant with no live subscription row (`"none" | "incomplete" | "active" |
 * "past_due" | "downgraded" | "cancelled" | "expired"`).
 *
 * ## Assumptions recorded in the handoff (ADR-0360)
 *
 * - `resetsAt` is the **start of the next UTC period** (`monthly` →
 *   `YYYY-(MM+1)-01T00:00:00.000Z`, `yearly` → `YYYY+1-01-01T00:00:00.000Z`),
 *   mirroring the UTC `periodKey` cadence OP-103 pinned; `lifetime` and `none`
 *   have no boundary (`null`).
 * - Only an **exhausted `hard` limit** derives `plan_limit`; `soft`/`policy`
 *   limits allow the overage (schema §14.1), `feature` rows are boolean gates
 *   and an unlimited row can never be exhausted.
 * - `payment_downgrade` mirrors the enforcement split exactly: only a
 *   `downgraded` subscription produces it (schema §14.2 pseudo-code:
 *   `status === "downgraded" ? "payment_downgrade" : "plan_limit"`). A
 *   `past_due` tenant that still has room is therefore **not** blocked — the
 *   subscription endpoint's banner (§3.2) carries the past-due warning.
 * - `payment_downgrade` outranks `plan_limit` when both apply.
 */

/** A quota row as {@link blockReasonFor} consumes it. */
interface QuotaRow {
  readonly enforcement: "hard" | "soft" | "policy" | "feature";
  readonly effectiveLimit: number | null;
  readonly used?: number | null;
}

/** Build a quota row; the baseline is an exhausted hard monthly limit. */
function quota(overrides: Partial<QuotaRow> = {}): QuotaRow {
  return { enforcement: "hard", effectiveLimit: 7, used: 7, ...overrides };
}

describe("resetsAtFor — the next reset boundary per cadence", () => {
  it.each([
    ["monthly", "2026-09-15T10:00:00.000Z", "2026-10-01T00:00:00.000Z"],
    ["monthly", "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"],
    ["monthly", "2026-09-30T23:59:59.999Z", "2026-10-01T00:00:00.000Z"],
    ["monthly", "2026-12-31T23:59:59.999Z", "2027-01-01T00:00:00.000Z"],
    ["yearly", "2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"],
    ["yearly", "2026-09-15T10:00:00.000Z", "2027-01-01T00:00:00.000Z"],
    ["yearly", "2026-12-31T23:59:59.999Z", "2027-01-01T00:00:00.000Z"],
  ] as const)("U1: %s at %s -> %s", (resetPeriod, at, expected) => {
    expect(resetsAtFor(resetPeriod, new Date(at))?.toISOString()).toBe(expected);
  });

  it("U1: a lifetime entitlement has no reset boundary", () => {
    expect(resetsAtFor("lifetime", new Date("2026-09-15T10:00:00.000Z"))).toBeNull();
  });

  it("U1: a `none` entitlement has no reset boundary", () => {
    expect(resetsAtFor("none", new Date("2026-09-15T10:00:00.000Z"))).toBeNull();
  });
});

describe("blockReasonFor — why the global banner shows", () => {
  it("U2: an active subscription under every limit has no block reason", () => {
    expect(blockReasonFor("active", [quota({ effectiveLimit: 7, used: 5 })])).toBeNull();
  });

  it("U2: a tenant with no live subscription and room has no block reason", () => {
    expect(blockReasonFor("none", [])).toBeNull();
  });

  it("U2: a downgraded subscription blocks with payment_downgrade", () => {
    expect(blockReasonFor("downgraded", [])).toBe("payment_downgrade");
  });

  it("U2: an exhausted hard limit blocks with plan_limit", () => {
    expect(blockReasonFor("active", [quota({ effectiveLimit: 7, used: 7 })])).toBe("plan_limit");
  });

  it("U2: payment_downgrade takes precedence over an exhausted limit", () => {
    expect(blockReasonFor("downgraded", [quota({ effectiveLimit: 7, used: 12 })])).toBe(
      "payment_downgrade"
    );
  });

  it("U2: a `soft` or `policy` limit at its ceiling does not block", () => {
    expect(
      blockReasonFor("active", [
        quota({ enforcement: "soft", effectiveLimit: 7, used: 7 }),
        quota({ enforcement: "policy", effectiveLimit: 90, used: 400 }),
      ])
    ).toBeNull();
  });

  it("U2: an unlimited or feature row never reports plan_limit", () => {
    expect(
      blockReasonFor("active", [
        quota({ effectiveLimit: null, used: 1_000_000 }),
        quota({ enforcement: "feature", effectiveLimit: null, used: null }),
      ])
    ).toBeNull();
  });

  it("U2: an event/attendee-scoped row without a `used` count never reports plan_limit", () => {
    expect(blockReasonFor("active", [quota({ effectiveLimit: 3, used: null })])).toBeNull();
  });

  it("U2: a past_due subscription with room is not a payment block (the 402 split is downgraded-only)", () => {
    expect(blockReasonFor("past_due", [quota({ effectiveLimit: 7, used: 1 })])).toBeNull();
  });
});
