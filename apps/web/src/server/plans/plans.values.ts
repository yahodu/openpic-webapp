import type { Entitlement, Plan, PlanPrice } from "./plans";

/**
 * The seeded `plans` catalogue (OP-83, schema §14.1, contract §3.1).
 *
 * `SEED_PLANS` is the four documented tiers — `free`, `starter`,
 * `professional`, `enterprise` — as **data**: self-describing entitlements and
 * embedded prices, so pricing and limits change without a deploy.
 *
 * ## Value provenance
 *
 * Values marked `DOCUMENTED` are transcribed from the design docs; values
 * marked `TODO(product)` are **unconfirmed product inputs** and must be
 * replaced before launch (card §3 / ADR-0014 "Seed values"). Only the
 * invariants are test-pinned (integer money, the feature gate, unique
 * `tierRank`, vendor confinement, version semantics); the amounts themselves
 * are deliberately left to the product owner.
 *
 * A vendor name (`cashfree`) appears **only** inside `prices[].externalRefs`
 * (U5) — it must never be added to any other field.
 */

/** The instant every seeded price becomes valid. */
const SEED_PRICE_VALID_FROM = new Date("2026-01-01T00:00:00.000Z");

/** Build one self-describing entitlement spec. */
function entitlement(
  limit: number | null,
  resetPeriod: Entitlement["resetPeriod"],
  scope: Entitlement["scope"],
  enforcement: Entitlement["enforcement"],
  enabled?: boolean
): Entitlement {
  return { limit, resetPeriod, scope, enforcement, ...(enabled === undefined ? {} : { enabled }) };
}

/** Build one embedded price (money is always integer minor units). */
function price(priceKey: string, amountMinor: number, externalRefId: string | null): PlanPrice {
  return {
    priceKey,
    billingCycle: "monthly",
    amountMinor,
    currency: "INR",
    taxBehavior: "inclusive",
    trialDays: 0,
    active: true,
    validFrom: SEED_PRICE_VALID_FROM,
    validUntil: null,
    externalRefs:
      externalRefId === null
        ? []
        : [{ provider: "cashfree", env: "production", kind: "plan", id: externalRefId }],
  };
}

/**
 * The four seeded plans, ordered by `tierRank`.
 *
 * `free`/`starter` values follow contract §3.1 and the schema §14.1 worked
 * example; `enterprise` follows the contract's "not self-serve, no embedded
 * prices" example (U4). `professional`'s event ceiling (28) is the one
 * professional limit documented in the subscription flow.
 */
export const SEED_PLANS: readonly Plan[] = [
  {
    key: "free",
    name: "Free",
    description: "For trying OpenPic out.", // TODO(product): confirm marketing copy
    marketingFeatures: [
      "1 active event / month",
      "2 GB storage",
      "500 images per event",
      "7-day gallery",
    ],
    tierRank: 0,
    selfServe: true,
    salesAssisted: false,
    active: true,
    version: 1,
    prices: [],
    entitlements: {
      "events.active": entitlement(1, "monthly", "tenant", "hard"), // DOCUMENTED (contract §3.1)
      "events.duration_days": entitlement(7, "none", "event", "hard"), // TODO(product)
      "storage.bytes": entitlement(2_147_483_648, "lifetime", "tenant", "hard"), // DOCUMENTED — 2 GB
      "images.per_event": entitlement(500, "none", "event", "hard"), // DOCUMENTED
      "gallery.retention_days": entitlement(7, "none", "event", "policy"), // DOCUMENTED
      "originals.download": entitlement(null, "none", "event", "feature", false), // DOCUMENTED
    },
  },
  {
    key: "starter",
    name: "Starter",
    description: "For small events.", // TODO(product): confirm marketing copy
    marketingFeatures: [
      "7 active events / month",
      "100 GB storage",
      "5,000 images per event",
      "90-day gallery",
      "Original downloads",
    ],
    tierRank: 1,
    selfServe: true,
    salesAssisted: false,
    active: true,
    version: 1,
    prices: [price("starter-monthly-inr", 49_900, "STARTER_MONTHLY_V1")], // DOCUMENTED — ₹499
    entitlements: {
      "events.active": entitlement(7, "monthly", "tenant", "hard"), // DOCUMENTED
      "events.duration_days": entitlement(7, "none", "event", "hard"), // DOCUMENTED
      "events.post_upload_days": entitlement(7, "none", "event", "hard"), // TODO(product)
      "storage.bytes": entitlement(107_374_182_400, "lifetime", "tenant", "hard"), // DOCUMENTED — 100 GB
      "images.per_event": entitlement(5_000, "none", "event", "hard"), // DOCUMENTED
      "coorganizers.per_event": entitlement(3, "none", "event", "hard"), // TODO(product)
      "selfies.per_attendee": entitlement(3, "none", "attendee", "hard"), // TODO(product)
      "gallery.retention_days": entitlement(90, "none", "event", "policy"), // TODO(product)
      "originals.download": entitlement(null, "none", "event", "feature", true), // TODO(product)
    },
  },
  {
    key: "professional",
    name: "Professional",
    description: "For teams running many events.", // TODO(product): confirm marketing copy
    marketingFeatures: [
      "28 active events / month",
      "500 GB storage",
      "20,000 images per event",
      "1-year gallery",
      "Original downloads",
    ],
    tierRank: 2,
    selfServe: true,
    salesAssisted: false,
    active: true,
    version: 1,
    prices: [price("professional-monthly-inr", 999_900, "PROFESSIONAL_MONTHLY_V1")], // DOCUMENTED — ₹9,999
    entitlements: {
      "events.active": entitlement(28, "monthly", "tenant", "hard"), // DOCUMENTED (subscription flow)
      "events.duration_days": entitlement(30, "none", "event", "hard"), // TODO(product)
      "events.post_upload_days": entitlement(30, "none", "event", "hard"), // TODO(product)
      "storage.bytes": entitlement(536_870_912_000, "lifetime", "tenant", "hard"), // TODO(product) — 500 GB
      "images.per_event": entitlement(20_000, "none", "event", "hard"), // TODO(product)
      "coorganizers.per_event": entitlement(10, "none", "event", "hard"), // TODO(product)
      "selfies.per_attendee": entitlement(10, "none", "attendee", "hard"), // TODO(product)
      "gallery.retention_days": entitlement(365, "none", "event", "policy"), // TODO(product)
      "originals.download": entitlement(null, "none", "event", "feature", true), // TODO(product)
    },
  },
  {
    key: "enterprise",
    name: "Enterprise",
    description: "Negotiated terms with a dedicated contact.", // TODO(product): confirm marketing copy
    marketingFeatures: [
      "Unlimited events",
      "Unlimited storage",
      "Priority support",
      "Custom terms",
    ],
    tierRank: 3,
    selfServe: false, // DOCUMENTED — sales-assisted (U4)
    salesAssisted: true, // DOCUMENTED
    active: true,
    version: 1,
    prices: [], // DOCUMENTED — no self-serve checkout (U4)
    entitlements: {
      // Enterprise limits are negotiated per contract; the seed expresses the
      // ceiling as "unlimited" and the sales team grants overrides.
      "events.active": entitlement(null, "monthly", "tenant", "hard"), // TODO(product)
      "events.duration_days": entitlement(null, "none", "event", "hard"), // TODO(product)
      "events.post_upload_days": entitlement(null, "none", "event", "hard"), // TODO(product)
      "storage.bytes": entitlement(null, "lifetime", "tenant", "hard"), // TODO(product)
      "images.per_event": entitlement(null, "none", "event", "hard"), // TODO(product)
      "coorganizers.per_event": entitlement(null, "none", "event", "hard"), // TODO(product)
      "selfies.per_attendee": entitlement(null, "none", "attendee", "hard"), // TODO(product)
      "gallery.retention_days": entitlement(null, "none", "event", "policy"), // TODO(product)
      "originals.download": entitlement(null, "none", "event", "feature", true), // TODO(product)
    },
  },
];
