import { describe, expect, it } from "vitest";

import {
  mapActionOutcome,
  resolveActionDelegation,
  type DelegateResult,
} from "@/server/notifications/notification-actions";

/**
 * Unit — the notification action endpoint's two pure rules (OP-140 U1/U2,
 * contract §7.3, notification design §7).
 *
 * `POST /me/notifications/{id}/actions/{actionKey}` **owns no state**: the
 * notification is a pointer and the `actionTarget`'s own document owns the
 * outcome. Two decisions make that endpoint more than a switch statement, and
 * both are pure enough to pin without Mongo:
 *
 * 1. **Which service handles a `(kind, actionKey)` pair** — the §7.3 table, in
 *    one place. An unlisted pair is not answerable, so the endpoint must refuse
 *    it (`422`) instead of guessing a delegate.
 * 2. **What a delegated service's answer means on the wire** — every delegated
 *    call reports one of three outcomes, and the endpoint's `outcome` /
 *    `alreadyResolved` / `resolvedVia` / `targetState` / `redirectUrl` /
 *    `message` keys are a projection of it (never of the notification row).
 *
 * ## Contract expected of the implementation
 *
 * ```
 * @/server/notifications/notification-actions
 *
 *   export const NOTIFICATION_ACTION_SERVICES:
 *     readonly ["invitation_decision", "retry_charge", "checkout_url",
 *               "reprocess_failed", "policy_acknowledge",
 *               "extend_upload_window", "selfie_redirect"]
 *
 *   export interface NotificationActionDelegation {
 *     readonly service: NotificationActionService;      // one of the above
 *     readonly decision?: "accept" | "reject";          // invitation only
 *   }
 *
 *   export function resolveActionDelegation(input: {
 *     readonly kind: unknown;
 *     readonly actionKey: unknown;
 *   }): NotificationActionDelegation | null
 *
 *   export interface DelegateResult {
 *     readonly outcome: "applied" | "already_resolved" | "unavailable";
 *     readonly targetState: string;             // the owning document's state
 *     readonly resolvedVia?: string;            // the channel that won, if any
 *     readonly redirectUrl?: string;            // where the client should go
 *   }
 *
 *   export interface ActionOutcomeView {
 *     readonly outcome: "applied" | "already_resolved" | "unavailable";
 *     readonly alreadyResolved: boolean;
 *     readonly resolvedVia: string | null;
 *     readonly targetState: string;
 *     readonly redirectUrl: string | null;
 *     readonly message: string;
 *   }
 *
 *   export function mapActionOutcome(result: DelegateResult): ActionOutcomeView
 * ```
 *
 * `resolveActionDelegation` maps **only** the seven §7.3 rows; anything else —
 * an unknown kind, an unknown key, a non-string input — is `null`.
 * `mapActionOutcome` never invents a fact the service did not report: a result
 * with no `resolvedVia` maps to `resolvedVia: null`, not to a default channel,
 * and `alreadyResolved` is `true` only for `already_resolved`.
 */

/** The delegated service named by one §7.3 row, in the table's own order. */
const NON_INVITATION_ROWS: readonly (readonly [string, string, string])[] = [
  ["subscription", "pay_now", "retry_charge"],
  ["subscription", "complete_mandate", "checkout_url"],
  ["upload_batch", "retry_failed", "reprocess_failed"],
  ["policy", "acknowledge", "policy_acknowledge"],
  ["event", "extend_upload_window", "extend_upload_window"],
  ["selfie", "retry", "selfie_redirect"],
];

describe("resolveActionDelegation — the §7.3 dispatch table", () => {
  it.each([...NON_INVITATION_ROWS])(
    "U1: maps %s + %s onto the %s service",
    (kind, actionKey, service) => {
      expect(resolveActionDelegation({ kind, actionKey })).toEqual({ service });
    }
  );

  it("U1: maps an invitation accept onto the invitation decision service, as an accept", () => {
    expect(resolveActionDelegation({ kind: "invitation", actionKey: "accept" })).toEqual({
      service: "invitation_decision",
      decision: "accept",
    });
  });

  it("U1: maps an invitation reject onto the invitation decision service, as a reject", () => {
    expect(resolveActionDelegation({ kind: "invitation", actionKey: "reject" })).toEqual({
      service: "invitation_decision",
      decision: "reject",
    });
  });

  it.each([
    ["invitation", "pay_now"],
    ["subscription", "accept"],
    ["policy", "reject"],
    ["upload_batch", "retry"],
    ["selfie", "retry_failed"],
    ["event", "acknowledge"],
  ])("U1: refuses the pair %s + %s, which §7.3 does not list", (kind, actionKey) => {
    expect(resolveActionDelegation({ kind, actionKey })).toBeNull();
  });

  it("U1: refuses an unknown action target kind", () => {
    expect(resolveActionDelegation({ kind: "event_link", actionKey: "accept" })).toBeNull();
  });

  it.each([
    ["an absent action key", { kind: "invitation", actionKey: undefined }],
    ["a non-string action key", { kind: "invitation", actionKey: 7 }],
    ["an absent kind", { kind: undefined, actionKey: "accept" }],
    ["a non-string kind", { kind: 7, actionKey: "accept" }],
  ])("U1: refuses %s instead of guessing a delegate", (_label, input) => {
    expect(resolveActionDelegation(input)).toBeNull();
  });
});

describe("mapActionOutcome — what a delegated result means on the wire", () => {
  it("U2: maps an applied result onto the §7.3 keys it reported", () => {
    const result: DelegateResult = {
      outcome: "applied",
      targetState: "accepted",
      resolvedVia: "in_app",
      redirectUrl: "/events/6702ff/images",
    };

    const view = mapActionOutcome(result);

    expect(view.outcome).toBe("applied");
    expect(view.alreadyResolved).toBe(false);
    expect(view.resolvedVia).toBe("in_app");
    expect(view.targetState).toBe("accepted");
    expect(view.redirectUrl).toBe("/events/6702ff/images");
  });

  it("U2: maps an already_resolved result onto alreadyResolved true and keeps the winning channel", () => {
    const view = mapActionOutcome({
      outcome: "already_resolved",
      targetState: "accepted",
      resolvedVia: "email",
    });

    expect(view.outcome).toBe("already_resolved");
    expect(view.alreadyResolved).toBe(true);
    expect(view.resolvedVia).toBe("email");
    expect(view.targetState).toBe("accepted");
  });

  it("U2: maps an unavailable result onto no channel and no redirect", () => {
    const view = mapActionOutcome({ outcome: "unavailable", targetState: "revoked" });

    expect(view.outcome).toBe("unavailable");
    expect(view.alreadyResolved).toBe(false);
    expect(view.resolvedVia).toBeNull();
    expect(view.redirectUrl).toBeNull();
    expect(view.targetState).toBe("revoked");
  });

  it("U2: never invents a channel an applied result did not report", () => {
    const view = mapActionOutcome({ outcome: "applied", targetState: "charge_initiated" });

    expect(view.resolvedVia).toBeNull();
    expect(view.redirectUrl).toBeNull();
  });

  it("U2: answers exactly the six §7.3 outcome keys, and nothing else", () => {
    const view = mapActionOutcome({
      outcome: "applied",
      targetState: "accepted",
      resolvedVia: "in_app",
      redirectUrl: "/events/6702ff/images",
    });

    expect(Object.keys(view).sort()).toEqual([
      "alreadyResolved",
      "message",
      "outcome",
      "redirectUrl",
      "resolvedVia",
      "targetState",
    ]);
  });

  it.each<["applied" | "already_resolved" | "unavailable"]>([
    ["applied"],
    ["already_resolved"],
    ["unavailable"],
  ])("U2: gives the %s outcome a non-empty message", (outcome) => {
    const view = mapActionOutcome({ outcome, targetState: "accepted" });

    expect(typeof view.message).toBe("string");
    expect(view.message.trim().length).toBeGreaterThan(0);
  });

  it("U2: tells a first click and a replay apart in the message", () => {
    const applied = mapActionOutcome({ outcome: "applied", targetState: "accepted" });
    const replay = mapActionOutcome({ outcome: "already_resolved", targetState: "accepted" });

    expect(applied.message).not.toBe(replay.message);
  });
});
