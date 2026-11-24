/**
 * The notification action endpoint's two pure rules (OP-140, contract §7.3;
 * notification design §7).
 *
 * `POST /me/notifications/{id}/actions/{actionKey}` owns no state: a
 * notification row is a pointer, and the `actionTarget`'s own document owns the
 * outcome. Two decisions make that endpoint more than a switch statement, and
 * both are pinned without Mongo:
 *
 * - **Which service handles a `(kind, actionKey)` pair** — {@link
 *   resolveActionDelegation} is the §7.3 table in one place. An unlisted pair is
 *   not answerable, so the endpoint refuses it (`422`) instead of guessing.
 * - **What a delegated service's answer means on the wire** — {@link
 *   mapActionOutcome} projects the delegated result onto the endpoint's six
 *   outcome keys and never invents a fact the service did not report.
 */

/** The seven §7.3 rows' delegated services, in the table's own order. */
export const NOTIFICATION_ACTION_SERVICES = [
  "invitation_decision",
  "retry_charge",
  "checkout_url",
  "reprocess_failed",
  "policy_acknowledge",
  "extend_upload_window",
  "selfie_redirect",
] as const;

/** One delegated service named by the §7.3 table. */
export type NotificationActionService = (typeof NOTIFICATION_ACTION_SERVICES)[number];

/** What one §7.3 `(kind, actionKey)` pair delegates to. */
export interface NotificationActionDelegation {
  /** The domain service that owns the transition. */
  readonly service: NotificationActionService;
  /** The invitation decision the pair names (`invitation_decision` only). */
  readonly decision?: "accept" | "reject";
}

/**
 * The §7.3 dispatch table: target kind → action key → delegation.
 *
 * A `Map` (not a plain object) because a hostile `kind` such as `toString` must
 * resolve to nothing rather than to an inherited member.
 */
const DISPATCH_TABLE: ReadonlyMap<
  string,
  ReadonlyMap<string, NotificationActionDelegation>
> = new Map([
  [
    "invitation",
    new Map<string, NotificationActionDelegation>([
      ["accept", { service: "invitation_decision", decision: "accept" }],
      ["reject", { service: "invitation_decision", decision: "reject" }],
    ]),
  ],
  [
    "subscription",
    new Map<string, NotificationActionDelegation>([
      ["pay_now", { service: "retry_charge" }],
      ["complete_mandate", { service: "checkout_url" }],
    ]),
  ],
  [
    "upload_batch",
    new Map<string, NotificationActionDelegation>([
      ["retry_failed", { service: "reprocess_failed" }],
    ]),
  ],
  [
    "policy",
    new Map<string, NotificationActionDelegation>([
      ["acknowledge", { service: "policy_acknowledge" }],
    ]),
  ],
  [
    "event",
    new Map<string, NotificationActionDelegation>([
      ["extend_upload_window", { service: "extend_upload_window" }],
    ]),
  ],
  [
    "selfie",
    new Map<string, NotificationActionDelegation>([["retry", { service: "selfie_redirect" }]]),
  ],
]);

/**
 * The action keys the §7.3 table offers for one target kind, in table order.
 *
 * The fan-out derives what it may emit from this one table (ADR-0942 §4.3); the
 * target's own stored state decides which of the keys is live.
 *
 * @param kind - A stored `actionTarget.kind` (`unknown`: a row is unvalidated
 *   input here).
 * @returns The keys, or an empty list for an unknown or non-string kind.
 */
export function actionKeysForKind(kind: unknown): readonly string[] {
  return typeof kind === "string" ? [...(DISPATCH_TABLE.get(kind)?.keys() ?? [])] : [];
}

/**
 * Resolve the delegated service for one `(kind, actionKey)` pair (§7.3).
 *
 * @param input - The row's `actionTarget.kind` and the clicked `actionKey`
 *   (both `unknown`: a stored row is unvalidated input here).
 * @returns The delegation, or `null` when §7.3 does not list the pair — an
 *   unknown kind, an unknown key, or a non-string input.
 */
export function resolveActionDelegation(input: {
  readonly kind: unknown;
  readonly actionKey: unknown;
}): NotificationActionDelegation | null {
  if (typeof input.kind !== "string" || typeof input.actionKey !== "string") {
    return null;
  }
  return DISPATCH_TABLE.get(input.kind)?.get(input.actionKey) ?? null;
}

/** What a delegated service reported, before it is projected onto the wire. */
export interface DelegateResult {
  /** The transition the service performed (or refused to perform). */
  readonly outcome: "applied" | "already_resolved" | "unavailable";
  /** The owning document's state after the call. */
  readonly targetState: string;
  /** The channel that won, when the service names one. */
  readonly resolvedVia?: string;
  /** Where the client should go next, when the service names one. */
  readonly redirectUrl?: string;
}

/** One §7.3 outcome body, projected for the service's caller. */
export interface ActionOutcomeView {
  /** The transition the service performed. */
  readonly outcome: "applied" | "already_resolved" | "unavailable";
  /** `true` only for `already_resolved` (a replay, never a first click). */
  readonly alreadyResolved: boolean;
  /** The channel that won, or `null` when the service named none. */
  readonly resolvedVia: string | null;
  /** The owning document's state after the call. */
  readonly targetState: string;
  /** Where the client should go next, or `null`. */
  readonly redirectUrl: string | null;
  /** A user-facing sentence that tells a first click and a replay apart. */
  readonly message: string;
}

/** The sentence each outcome answers with. */
const OUTCOME_MESSAGES: Readonly<Record<ActionOutcomeView["outcome"], string>> = {
  applied: "Done — the action was applied.",
  already_resolved: "This action was already resolved.",
  unavailable: "This action is not available right now.",
};

/**
 * Project a delegated result onto the endpoint's six outcome keys.
 *
 * Never invents a fact: a result with no `resolvedVia` maps to `null` rather
 * than to a default channel, and `alreadyResolved` is `true` only for a replay.
 *
 * @param result - What the delegated service reported.
 * @returns The six-key outcome view.
 */
export function mapActionOutcome(result: DelegateResult): ActionOutcomeView {
  return {
    outcome: result.outcome,
    alreadyResolved: result.outcome === "already_resolved",
    resolvedVia: result.resolvedVia ?? null,
    targetState: result.targetState,
    redirectUrl: result.redirectUrl ?? null,
    message: OUTCOME_MESSAGES[result.outcome],
  };
}
