import { z } from "zod";

import type { SubscriptionStatus } from "./view";

/**
 * The checkout decisions and wire shapes (OP-107, contract §3.3, schema §14.3;
 * ADR-0420 / ADR-0421).
 *
 * `POST /tenants/{tenantId}/billing/checkout` is the one place a workspace turns
 * into a paying one, so the two decisions it makes **before** it touches a
 * payment provider are pure functions here, pinned away from Mongo and from the
 * HTTP pipeline:
 *
 *   - {@link isAllowedReturnUrl} — a `returnUrl` is accepted only when its
 *     **origin** is on the allow-list (a `startsWith` comparison is the classic
 *     open redirect: `https://app.openpic.in.evil.com` and
 *     `https://app.openpic.in@evil.com` both share the allow-listed prefix while
 *     resolving elsewhere, and an `http:` downgrade changes the origin), and
 *     only when the URL carries no credentials;
 *   - {@link decideExistingSubscription} — the §3.3 decision table: no document
 *     (or a terminal one) starts a checkout, a live row is the `409`
 *     `subscription_already_active`, and an `incomplete` row is *usable* only
 *     through a hosted link that has not expired yet — otherwise it is stale and
 *     a fresh checkout would have to replace it (the route refuses it instead:
 *     see ADR-0421 follow-up §1).
 *
 * The module holds no I/O: the route owns the reads, the writes and the
 * provider call, so these two functions are exercisable without a database.
 */

/**
 * The `returnUrl` predicates (contract §3.3).
 *
 * A URL is accepted only when it parses as an absolute http(s) URL, carries no
 * `username`/`password`, and its **origin** (scheme + host + port) is a member
 * of `allowedOrigins`. An empty allow-list accepts nothing (fail closed).
 *
 * @param returnUrl - The caller-supplied redirect target.
 * @param allowedOrigins - The permitted origins (e.g. `config.app.allowedOrigins`).
 * @returns `true` only for an allow-listed origin without credentials.
 */
export function isAllowedReturnUrl(returnUrl: string, allowedOrigins: readonly string[]): boolean {
  if (allowedOrigins.length === 0) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(returnUrl);
  } catch {
    // A relative path, an empty string or any other non-absolute value.
    return false;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return false;
  }

  // Credentials are never legitimate on a billing return URL, and `origin`
  // does not include them — `https://user:secret@app.openpic.in` would
  // otherwise match the allow-listed `https://app.openpic.in`.
  if (url.username !== "" || url.password !== "") {
    return false;
  }

  return allowedOrigins.some((origin) => originOf(origin) === url.origin);
}

/**
 * The normalized origin of an allow-list entry, or `null` when it is not an
 * absolute URL.
 *
 * @param entry - One configured origin.
 * @returns The entry's origin, or `null` when it does not parse.
 */
function originOf(entry: string): string | null {
  try {
    return new URL(entry).origin;
  } catch {
    return null;
  }
}

/** The hosted-mandate link a stored `incomplete` row carries. */
export interface ExistingCheckout {
  readonly url: string;
  readonly expiresAt: Date;
}

/**
 * The stored fields {@link decideExistingSubscription} reasons about
 * (schema §14.3).
 */
export interface ExistingSubscriptionFacts {
  /** The stored row's id, echoed when the checkout is blocked or reused. */
  readonly subscriptionId: string;
  /** The stored status. */
  readonly status: SubscriptionStatus;
  /** The instant a cancellation was recorded, or `null` while the row is live. */
  readonly cancelledAt: Date | null;
  /** The stored hosted link and its expiry, or `null` when none was stored. */
  readonly checkout: ExistingCheckout | null;
}

/**
 * What the checkout route must do about the workspace's current subscription.
 *
 * `start` is the one decision that lets a checkout through. Every other row the
 * table names is **live** — §3.3's `cancelledAt: null` plus a non-terminal
 * status — and the route answers the §3.3 `409 subscription_already_active` for
 * it instead of retiring a pending mandate whose user may be approving it right
 * now (ADR-0421 follow-up §1); `reuse` still carries the stored link and its
 * expiry, and `blocked` the status it read, so this value stays the single
 * description of the row.
 */
export type ExistingSubscriptionDecision =
  | { readonly kind: "start" }
  | { readonly kind: "restart"; readonly subscriptionId: string }
  | {
      readonly kind: "reuse";
      readonly subscriptionId: string;
      readonly checkout: ExistingCheckout;
    }
  | {
      readonly kind: "blocked";
      readonly subscriptionId: string;
      readonly status: SubscriptionStatus;
    };

/** The terminal statuses a row may hold without blocking a new checkout. */
const TERMINAL_STATUSES: ReadonlySet<SubscriptionStatus> = new Set<SubscriptionStatus>([
  "cancelled",
  "expired",
]);

/**
 * Classify the workspace's current subscription row (contract §3.3).
 *
 * A row is **live** when `cancelledAt === null` and its status is not
 * `cancelled`/`expired` — exactly the predicate the
 * `subscriptions_active_tenant_unique` partial index encodes. A live
 * `incomplete` row is reused while its hosted link has not yet expired
 * (the boundary instant itself is stale) and restarted otherwise; any other
 * live row blocks the checkout.
 *
 * @param facts - The stored row, or `null` when the workspace has none.
 * @param now - The instant the stored link's expiry is compared against.
 * @returns The decision the route acts on.
 */
export function decideExistingSubscription(
  facts: ExistingSubscriptionFacts | null,
  now: Date
): ExistingSubscriptionDecision {
  if (facts === null) {
    return { kind: "start" };
  }

  if (facts.cancelledAt !== null || TERMINAL_STATUSES.has(facts.status)) {
    return { kind: "start" };
  }

  if (facts.status === "incomplete") {
    const checkout = facts.checkout;
    if (checkout !== null && checkout.expiresAt.getTime() > now.getTime()) {
      return { kind: "reuse", subscriptionId: facts.subscriptionId, checkout };
    }
    return { kind: "restart", subscriptionId: facts.subscriptionId };
  }

  return { kind: "blocked", subscriptionId: facts.subscriptionId, status: facts.status };
}

/**
 * The `POST /billing/checkout` request body (contract §3.3).
 *
 * The customer is never client-supplied: the route derives it from the
 * workspace's own account and billing contact.
 */
export const checkoutRequestSchema = z.object({
  planKey: z.string().min(1),
  priceKey: z.string().min(1),
  returnUrl: z.string().min(1),
});

/** The parsed checkout request. */
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;

/** The payment-method kinds the checkout serves (schema §14.3). */
export const checkoutPaymentMethodKindSchema = z.enum([
  "mandate_upi",
  "mandate_bank_debit",
  "card",
  "invoice",
  "manual",
]);

/**
 * The §3.3 `201` checkout envelope.
 *
 * The bare single resource (§0.5): no `externalRefs`, no driver `_id` and
 * nothing shape-`<vendor>` ever reaches the client (§0.15) — `checkout.url` is
 * an opaque provider-hosted URL. It is also the route's **strict** response
 * schema, so a leaked field is a serialization failure rather than a wire
 * detail.
 */
export const checkoutEnvelopeSchema = z.object({
  subscriptionId: z.string().min(1),
  status: z.literal("incomplete"),
  checkout: z.object({
    kind: z.literal("redirect"),
    url: z.string().min(1),
    expiresAt: z.string().min(1),
  }),
  paymentMethodKind: checkoutPaymentMethodKindSchema,
  amountMinor: z.number().int(),
  currency: z.literal("INR"),
});

/** The §3.3 checkout envelope. */
export type CheckoutEnvelope = z.infer<typeof checkoutEnvelopeSchema>;
