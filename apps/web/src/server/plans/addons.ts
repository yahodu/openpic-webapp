import { z } from "zod";

import { hashCatalogueTag } from "./catalogue-tag";
import { projectPrice, servedPriceSchema } from "./plan-projection";
import { priceSchema } from "./plans";

/**
 * The public add-on catalogue (OP-102, contract §3.6, ADR-0320).
 *
 * An add-on is a top-up an organizer can buy — catalogue-as-data, exactly like
 * a plan. Its identity is an `addonKey` (`POST
 * /tenants/{tenantId}/billing/addons` takes one), what it grants is an
 * entitlement delta (`entitlementKey`), a quantity is counted in `unit` between
 * `quantity.min` and `quantity.max`, and its price lives in the embedded
 * `prices[]`. No schema §14.x row exists for the `addons` collection, so
 * ADR-0320 is the schema of record.
 *
 * The stored document is never served whole: the embedded prices carry the
 * vendor refs (`externalRefs`) that the §0.15 never-return rule strips, and the
 * served item adds a `display` string. Only `active: true` add-ons reach the
 * public catalogue — a retired top-up stays for history but is hidden.
 */

/** Orderable quantity bounds of an add-on, in whole `unit`s. */
export const addonQuantitySchema = z.object({
  min: z.number().int().min(0),
  max: z.number().int().min(0),
});

/** The stored add-on document (`addons` collection, platform scope; ADR-0320). */
export const storedAddonSchema = z.object({
  addonKey: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  entitlementKey: z.string().min(1),
  /**
   * The entitlement delta one ordered `quantity` unit grants (OP-110, ADR-0480
   * §4). ADR-0320's schema of record named the entitlement and the orderable
   * quantity bounds but carried no amount, so a purchase could not be projected
   * into an `entitlementGrants.delta`; the grant a purchase writes is
   * `quantity × grantDelta`, in the entitlement's own unit.
   */
  grantDelta: z.number(),
  unit: z.string().min(1),
  quantity: addonQuantitySchema,
  prices: z.array(priceSchema),
  active: z.boolean(),
});

/** A stored add-on document (ADR-0320). */
export type StoredAddon = z.infer<typeof storedAddonSchema>;

/** One add-on as the §3.6 catalogue serves it. */
export const servedAddonSchema = z
  .object({
    addonKey: z.string(),
    name: z.string(),
    description: z.string(),
    entitlementKey: z.string(),
    unit: z.string(),
    quantity: z.object({ min: z.number().int(), max: z.number().int() }),
    prices: z.array(servedPriceSchema),
    display: z.string(),
    active: z.boolean(),
  })
  .strict();

/** The §3.6 `{ data }` envelope. */
export const servedAddonListSchema = z.object({ data: z.array(servedAddonSchema) });

/** A served add-on (contract §3.6). */
export type Addon = z.infer<typeof servedAddonSchema>;

/**
 * The human `display` string for one add-on.
 *
 * The exact copy is a product decision, not a contract (as with the
 * notification catalogue `label`): only its presence is pinned, so the
 * structural quantity range is rendered rather than a prose line.
 *
 * @param addon - The stored add-on.
 * @returns A non-empty display string, e.g. `"1-10 GB"`.
 */
export function addonDisplay(addon: StoredAddon): string {
  return `${String(addon.quantity.min)}-${String(addon.quantity.max)} ${addon.unit}`;
}

/**
 * Project one stored add-on onto the §3.6 served shape.
 *
 * @param addon - The validated stored add-on.
 * @param currency - The requested `currency` filter, or `null` when absent.
 * @returns The served add-on, with `externalRefs` never present.
 */
export function projectAddon(addon: StoredAddon, currency: string | null): Addon {
  return {
    addonKey: addon.addonKey,
    name: addon.name,
    description: addon.description,
    entitlementKey: addon.entitlementKey,
    unit: addon.unit,
    quantity: { min: addon.quantity.min, max: addon.quantity.max },
    prices: addon.prices
      .filter((price) => price.active && (currency === null || price.currency === currency))
      .map(projectPrice),
    display: addonDisplay(addon),
    active: addon.active,
  };
}

/**
 * Compute the `GET /addons` catalogue entity tag (contract §3.6, §0.10).
 *
 * The add-on catalogue has no `version` field, so — unlike
 * {@link planCatalogueETag} — the tag is a content hash of the served items:
 * any change to the served catalogue revalidates, and an unchanged catalogue
 * serves a stable tag.
 *
 * @param addons - The served add-ons, in served order.
 * @returns A strong `ETag` header value.
 */
export function addonCatalogueETag(addons: readonly Addon[]): string {
  return hashCatalogueTag(JSON.stringify(addons));
}
