/**
 * The §5.6 batch signed-media-URL policy (OP-128; API contract §5.6, media doc
 * §25).
 *
 * The endpoint answers per item: a 200-item refresh must not fail because one
 * image was hidden, so only an **all-denied** batch escalates to `403`
 * ({@link signedUrlBatchStatus}). The per-item question is
 * {@link authorizeSignedUrlItem} — a pure decision table so the route keeps the
 * I/O and this table stays readable:
 *
 * - `not_found` outranks every other denial, so an id that is not a live image
 *   of the scope event never reveals whether it exists (§0.4).
 * - `anonymous` has no identity to match, so `authentication_required` never
 *   aggregates into the batch `403` (ADR-0764 A1/D4).
 * - `original` needs the tenant plan's `originals.download` gate (§0.14, §6.6).
 * - an attendee is allowed only for an image they are matched in **and** that
 *   the organizer has not hidden (§5.6, ADR-0762 D5/A5).
 *
 * `SignedUrlDecision` keeps `code` optional — an allowed item carries no code and
 * a denied one always does, and the route refuses a denial without one rather
 * than inventing a code (ADR-0765 D1).
 */

/** The derivative a refresh item asks for (§5.6). */
export type SignedUrlKind = "thumbnail" | "original";

/** The caller classes the decision table splits on. */
export type SignedUrlCaller = "member" | "attendee" | "anonymous";

/** The stable denial codes the §5.6 answer carries. */
export type SignedUrlDenialCode =
  "authentication_required" | "forbidden" | "not_found" | "feature_not_available";

/** One item's verdict: allowed carries no code; a denial always carries one. */
export interface SignedUrlDecision {
  readonly allowed: boolean;
  readonly code?: SignedUrlDenialCode;
}

/** The facts the route resolves once per request, plus the item's kind. */
export interface SignedUrlAuthorizationInput {
  readonly kind: SignedUrlKind;
  readonly caller: SignedUrlCaller;
  /** The caller has a `face_matches` row for **this** image. */
  readonly matched: boolean;
  /** The tenant plan's `originals.download` gate. */
  readonly originalsAllowed: boolean;
  /** The live image in scope, or `null` when no live image carries the id. */
  readonly image: { readonly hidden: boolean } | null;
}

/**
 * Decide whether one refresh item may be signed (§5.6).
 *
 * @param input - The item's kind, the caller class, the match and plan facts
 *   and the live image (or `null`).
 * @returns The item's decision.
 */
export function authorizeSignedUrlItem(input: SignedUrlAuthorizationInput): SignedUrlDecision {
  const { image } = input;
  if (image === null) {
    return { allowed: false, code: "not_found" };
  }
  if (input.caller === "anonymous") {
    return { allowed: false, code: "authentication_required" };
  }
  if (input.kind === "original" && !input.originalsAllowed) {
    return { allowed: false, code: "feature_not_available" };
  }
  if (input.caller === "member") {
    return { allowed: true };
  }
  return input.matched && !image.hidden ? { allowed: true } : { allowed: false, code: "forbidden" };
}

/**
 * The status the whole batch answers (§5.6 "if every item is denied → 403").
 *
 * An all-denied batch escalates unless a denial is `authentication_required`:
 * an anonymous caller has nothing to be authorized *for*, so it learns per item
 * that it must sign in (ADR-0764 A1/D4). An empty batch stays `200`; the wire
 * validation refuses it before this rule runs.
 *
 * @param decisions - Every item's decision, in request order.
 * @returns `403` for an all-denied credentialed batch, else `200`.
 */
export function signedUrlBatchStatus(decisions: readonly SignedUrlDecision[]): 200 | 403 {
  const allDenied =
    decisions.length > 0 &&
    decisions.every((decision) => !decision.allowed) &&
    !decisions.some((decision) => decision.code === "authentication_required");
  return allDenied ? 403 : 200;
}
