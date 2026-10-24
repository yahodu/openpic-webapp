import { hashCatalogueTag } from "./catalogue-tag";

/**
 * The `GET /plans` catalogue entity tag (OP-102 follow-up, contract
 * §3.1/§0.10, ADR-0323; supersedes the `(key, version)`-only tag of ADR-0320).
 *
 * `GET /plans` is `public, max-age=300` and supports a conditional request, so
 * the tag must identify the **served representation**: a client that
 * revalidates with `If-None-Match` may be told `304` only when the bytes it
 * holds are the bytes this request would serve. The served body varies with
 * more than a plan's `version`:
 *
 *   - the `currency`/`billingCycle` query filters `prices`, so a
 *     `?currency=USD` revalidation must not be answered off an `ETag` minted
 *     for `?currency=INR`; and
 *   - a copy (`name`, `description`, `marketingFeatures`) or price
 *     (`amountMinor`) edit changes the representation without bumping
 *     `version` (`seedPlans` bumps it only on an entitlement change — ADR-0014
 *     §6), and a `304` would refresh `max-age` and pin the stale copy.
 *
 * The tag is therefore a content digest of the served plans themselves. The
 * input is canonically ordered: the route serves the plans ascending by
 * `tierRank`, and each plan goes through the strict §3.1 projection schemas
 * (ADR-0320), so both the plan order and every object's key order are fixed.
 * Every own enumerable property of each entry is hashed, so a caller that wants
 * representation identity must pass the full served plan; the minimal
 * `(key, version)` shape is what the unit contract passes, and is a strict
 * subset of it. The tag's shape (hash vs join, weak vs strong) is an
 * implementation detail: only the invariants are contractual — two requests
 * whose bodies differ never share a tag, and an unchanged representation
 * revalidates to `304`.
 */

/**
 * The identity a plan entry must carry to be tagged. Any object with a `key`
 * and a `version` satisfies it; the served plan is the production input, and
 * its full content is what the digest covers.
 */
export interface CatalogueTagEntry {
  readonly key: string;
  readonly version: number;
}

/**
 * Compute the `GET /plans` entity tag from the served plans.
 *
 * @param entries - The served plans, in served order. Any object carrying the
 *   plan's `(key, version)` identity is accepted, but every own enumerable
 *   property is hashed, so the full served plan is required for the tag to
 *   identify the representation.
 * @returns A strong `ETag` header value, stable for the same served plans and
 *   distinct for any change to them (and non-empty for an empty catalogue).
 */
export function planCatalogueETag(entries: readonly CatalogueTagEntry[]): string {
  return hashCatalogueTag(JSON.stringify(entries));
}
