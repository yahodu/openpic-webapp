import type { PlanPrice } from "@/server/plans/plans";

/**
 * Add-on catalogue fixture builders (OP-102, ADR-0320).
 *
 * The public add-on catalogue (`GET /addons`) is stored policy-as-data, like
 * `plans`: an add-on is a top-up a tenant can buy (`POST
 * /tenants/{tenantId}/billing/addons` takes an `addonKey`), so its document is
 * self-describing — the entitlement key it tops up, the unit a quantity is
 * counted in, the orderable quantity bounds, and embedded prices.
 *
 * These are plain objects, **not parsed**: a spec that needs an inactive add-on
 * (the "an inactive add-on is excluded" pin) must be able to build one, which a
 * factory that parsed its own output could not. They mirror the shape the
 * server module `@/server/plans/addons` must own.
 */

/** The stored add-on document (`addons` collection, platform scope). */
export interface StoredAddon {
  /** Stable identity, referenced by `POST /billing/addons` (`addonKey`). */
  readonly addonKey: string;
  readonly name: string;
  readonly description: string;
  /** The entitlement this add-on grants (`delta`) when bought, e.g. `storage.bytes`. */
  readonly entitlementKey: string;
  /** The unit a `quantity` is counted in, e.g. `GB`. */
  readonly unit: string;
  /** Orderable quantity bounds (integer units). */
  readonly quantity: { readonly min: number; readonly max: number };
  /** Embedded prices; `externalRefs` lives here in storage and is never served. */
  readonly prices: readonly PlanPrice[];
  /** Retired add-ons stay for history but are hidden from the public catalogue. */
  readonly active: boolean;
}

/**
 * Build one embedded add-on price.
 *
 * @param overrides - Fields to replace on the baseline.
 * @returns A valid price.
 */
export function makeAddonPrice(overrides: Partial<PlanPrice> = {}): PlanPrice {
  return {
    priceKey: "storage-50gb-monthly-inr",
    billingCycle: "monthly",
    amountMinor: 19_900,
    currency: "INR",
    taxBehavior: "inclusive",
    trialDays: 0,
    active: true,
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
    validUntil: null,
    externalRefs: [
      { provider: "cashfree", env: "production", kind: "addon", id: "STORAGE_50GB_MONTHLY_V1" },
    ],
    ...overrides,
  };
}

/**
 * Build a complete add-on document.
 *
 * @param overrides - Fields to replace on the baseline.
 * @returns A valid stored add-on.
 */
export function makeAddon(overrides: Partial<StoredAddon> = {}): StoredAddon {
  return {
    addonKey: "storage-50gb",
    name: "50 GB storage",
    description: "Add 50 GB of storage to any plan.",
    entitlementKey: "storage.bytes",
    unit: "GB",
    quantity: { min: 1, max: 10 },
    prices: [makeAddonPrice()],
    active: true,
    ...overrides,
  };
}
