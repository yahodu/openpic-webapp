import { describe, expect, it } from "vitest";

import { formatBytes, formatEntitlementDisplay } from "@/server/plans/plan-display";

import { makeEntitlement } from "../../test/factories/plan";

/**
 * Unit contract — the public-plans `display` formatter (OP-102, contract §3.1,
 * ADR-0320).
 *
 * The pricing page renders `plans.entitlements` **verbatim from the DB plus an
 * added `display` string** (contract §3.1): the stored entitlement has no copy,
 * so the `GET /plans` projection must synthesise one. That projection is a pure
 * function of the entitlement key and its stored spec — it must never switch on
 * a hard-coded key list, because "adding an entitlement key is a data edit with
 * zero API change" and clients "must render unknown keys generically from
 * `display`". These specs pin the four generic classes that cover every stored
 * entitlement: byte quantities, counts, unlimited limits and boolean feature
 * gates.
 *
 * ## Contract expected of the implementation
 *
 * `@/server/plans/plan-display` exports:
 *
 *   formatBytes(bytes: number): string
 *     Binary byte quantity rendered in GB (`1024**3`, not `1000**3`), at most
 *     one decimal place, with a trailing `.0` removed — `2147483648` → `"2 GB"`.
 *   formatEntitlementDisplay(key: string, spec: Entitlement): string
 *     Resolved in this order, so a `feature` spec with `limit: null` renders as
 *     a gate and never as "Unlimited":
 *       1. `enforcement === "feature"` → `"Included"` when `enabled === true`,
 *          else `"Not included"`;
 *       2. `limit === null`           → `"Unlimited"`;
 *       3. a `*.bytes` key            → `formatBytes(limit)`;
 *       4. otherwise                  → the bare integer, `String(limit)`
 *          (locale-independent: no thousands separators).
 *
 * The count branch deliberately does **not** locale-format, so a runner's
 * default locale can never change the served copy.
 */
describe("formatBytes — binary byte quantities in GB", () => {
  it.each([
    [0, "0 GB"],
    [1_073_741_824, "1 GB"],
    [2_147_483_648, "2 GB"],
    [107_374_182_400, "100 GB"],
    [536_870_912_000, "500 GB"],
    [536_870_912, "0.5 GB"],
  ])("renders %i bytes as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

describe("formatEntitlementDisplay — the §3.1 entitlement display classes", () => {
  it("renders a byte entitlement as a GB quantity", () => {
    const spec = makeEntitlement({ limit: 2_147_483_648, resetPeriod: "lifetime" });

    expect(formatEntitlementDisplay("storage.bytes", spec)).toBe("2 GB");
  });

  it("renders a counted entitlement as a plain integer", () => {
    const spec = makeEntitlement({ limit: 5000, resetPeriod: "none", scope: "event" });

    expect(formatEntitlementDisplay("images.per_event", spec)).toBe("5000");
  });

  it("renders a null hard limit as unlimited", () => {
    const spec = makeEntitlement({ limit: null, resetPeriod: "none", scope: "event" });

    expect(formatEntitlementDisplay("events.active", spec)).toBe("Unlimited");
  });

  it("renders an enabled feature gate as Included", () => {
    const spec = makeEntitlement({
      limit: null,
      resetPeriod: "none",
      scope: "event",
      enforcement: "feature",
      enabled: true,
    });

    expect(formatEntitlementDisplay("originals.download", spec)).toBe("Included");
  });

  it("renders a disabled feature gate as Not included", () => {
    const spec = makeEntitlement({
      limit: null,
      resetPeriod: "none",
      scope: "event",
      enforcement: "feature",
      enabled: false,
    });

    expect(formatEntitlementDisplay("originals.download", spec)).toBe("Not included");
  });

  it("renders a feature gate as a gate even though its limit is null", () => {
    const spec = makeEntitlement({
      limit: null,
      resetPeriod: "none",
      scope: "event",
      enforcement: "feature",
      enabled: true,
    });

    expect(formatEntitlementDisplay("some.new_feature", spec)).not.toBe("Unlimited");
  });

  it("still renders a display string for an entitlement key it does not know", () => {
    const spec = makeEntitlement({ limit: 42, resetPeriod: "none", scope: "event" });

    expect(formatEntitlementDisplay("brand.new_metric", spec)).toBe("42");
  });
});
