import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeInvitationAffordance } from "@/server/collaboration/invitation-transition";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { closeActionAffordance } from "@/server/notifications/action-affordance";

import { startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { insertFeedRow } from "../helpers/notification-rows";

/**
 * Integration / contract — the shared close-affordance helper (OP-140, contract
 * §7.3 and §2.3 rule 3).
 *
 * The user story: *as a user, I should not be offered an action that has
 * already been applied.* §2.3 rule 3 states the structural promise:
 *
 * > After any successful transition the server runs the `notifications.updateMany`
 * > fan-out, so the same decision is closed in every channel and on every
 * > device on the next poll.
 *
 * "Any successful transition" is general, and the ticket that commissioned the
 * endpoint (`t_39c2bf80` §4) says the shared helper (OP-121) runs after it, so
 * the write is pinned here as one kind-generic rule rather than per target
 * kind. The closure is denormalised convenience only: `actionTarget`'s own
 * document stays the source of truth, which is why a cached `unavailable` may
 * never short-circuit a decision (pinned by `notification-actions.test.ts` I3).
 *
 * ## Contract expected of the implementation
 *
 * ```
 * @/server/notifications/action-affordance
 *   closeActionAffordance(
 *     db: Db,
 *     target: { readonly kind: string; readonly id: string },
 *     now: Date,
 *     options?: { readonly via?: string; readonly session?: ClientSession }
 *   ): Promise<void>
 * ```
 *
 * - One `updateMany` over `notifications`, filtered on the exact
 *   `actionTarget.kind` + `actionTarget.id` pair: a row of another kind, or of
 *   the same kind under another id, is never touched.
 * - `actions[].state` becomes `"unavailable"`, `actionTarget.state` becomes
 *   `"resolved"`, `actionResolvedAt` becomes the supplied instant and
 *   `updatedAt` moves.
 * - `actionResolvedVia` is written only when `via` is given: a transition that
 *   knows the instant but not a decision channel invents no channel.
 *
 * @/server/collaboration/invitation-transition
 *   closeInvitationAffordance(db, invitationId: string, now: Date,
 *                             via?: DecisionChannel, session?: ClientSession)
 *
 *   The OP-121 export keeps its signature and its behaviour; it is the
 *   invitation arm of the same write and gains `actionResolvedVia`.
 *
 * ## Assumptions
 *
 * - **A-1** — a closure is per `(kind, id)` pair, so the arms seed rows that
 *   differ only in one field: a sibling `subscription` row with another id
 *   catches an unfiltered update, and an `invitation` row catches a
 *   kind-only one.
 * - **A-2** — `closeInvitationAffordance` performs one `updateMany` on
 *   `notifications` and reads no `invitations` document, so its arm seeds the
 *   feed row the write targets. Sharing the implementation is not observable
 *   from outside; what is pinned is that both exports write the same closure
 *   fields for the same input.
 */

/** The stored instant every seeded row starts from, so `updatedAt` can move. */
const SEEDED_AT = new Date("2026-11-10T00:00:00.000Z");

/** The transition instant the closure is asked to write. */
const CLOSED_AT = new Date("2026-11-20T09:30:00.000Z");

/** The labels the seeded affordances carry (schema §19.4). */
const ACTION_LABELS: ReadonlyMap<string, string> = new Map([
  ["accept", "Accept"],
  ["reject", "Reject"],
  ["pay_now", "Pay now"],
  ["view_invoice", "View invoice"],
]);

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op140-affordance" });
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

beforeEach(async () => {
  await app.db.collection(COLLECTIONS.notifications).deleteMany({});
});

/** One seeded feed row and the target it points at. */
interface SeededRow {
  readonly id: ObjectId;
  readonly kind: string;
  readonly targetId: string;
}

/**
 * Seed one stored `notifications` row whose affordance is still available.
 *
 * @param input - The target kind, its id, the type key and the action keys.
 * @returns The row id and the target it names.
 */
async function seedRow(input: {
  readonly kind: string;
  readonly targetId: string;
  readonly typeKey: string;
  readonly actions: readonly string[];
}): Promise<SeededRow> {
  const id = await insertFeedRow(app.db, {
    userId: new ObjectId(),
    typeKey: input.typeKey,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    actionTarget: { kind: input.kind, id: input.targetId, state: "open" },
    actions: input.actions.map((key) => ({
      key,
      label: ACTION_LABELS.get(key) ?? key,
      style: "primary",
      state: "available",
    })),
  });
  return { id, kind: input.kind, targetId: input.targetId };
}

/**
 * Read one stored feed row, failing loudly when the seed is missing.
 *
 * @param id - The row's `_id`.
 * @returns The stored document.
 * @throws When no row is stored under `id`.
 */
async function requireStoredRow(id: ObjectId): Promise<Record<string, unknown>> {
  const row = await app.db.collection(COLLECTIONS.notifications).findOne({ _id: id });
  if (row === null) {
    throw new Error(`expected a stored notifications row for ${id.toHexString()}`);
  }
  return row;
}

/**
 * The stored fields a closure may write, as a comparable plain object.
 *
 * `_id` and the fixture's own envelope fields are left out: the pin is that the
 * closure writes none of these on a row it was not asked to close.
 *
 * @param row - The stored document.
 * @returns The comparable closure surface.
 */
function closureSurface(row: Record<string, unknown>): Record<string, unknown> {
  return {
    actionTarget: row.actionTarget ?? null,
    actions: row.actions ?? null,
    actionResolvedAt: row.actionResolvedAt ?? null,
    actionResolvedVia: row.actionResolvedVia ?? null,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}

/**
 * The `state` of every stored affordance of one row.
 *
 * @param row - The stored document.
 * @returns One state per element of `actions`, in stored order.
 */
function actionStates(row: Record<string, unknown>): string[] {
  return (row.actions as { readonly state: string }[]).map((action) => action.state);
}

describe("closeActionAffordance — the shared §7.3 closure", () => {
  it("A1: closes every affordance of the named target and leaves every other row untouched", async () => {
    const closedTarget = new ObjectId();
    const otherSubscriptionTarget = new ObjectId();
    const invitationTarget = new ObjectId();
    const closed = await seedRow({
      kind: "subscription",
      targetId: closedTarget.toHexString(),
      typeKey: "billing.payment.failed",
      actions: ["pay_now", "view_invoice"],
    });
    const sibling = await seedRow({
      kind: "subscription",
      targetId: otherSubscriptionTarget.toHexString(),
      typeKey: "billing.payment.failed",
      actions: ["pay_now"],
    });
    const otherKind = await seedRow({
      kind: "invitation",
      targetId: invitationTarget.toHexString(),
      typeKey: "collab.invite.sent",
      actions: ["accept", "reject"],
    });
    const untouchedBefore = [
      closureSurface(await requireStoredRow(sibling.id)),
      closureSurface(await requireStoredRow(otherKind.id)),
    ];

    // Act: close the subscription target, naming no decision channel.
    await closeActionAffordance(
      app.db,
      { kind: "subscription", id: closedTarget.toHexString() },
      CLOSED_AT
    );

    // Assert: the closed row's affordances are all unavailable, its target is
    // resolved at the supplied instant, and its `updatedAt` moved.
    const closedRow = await requireStoredRow(closed.id);
    expect(actionStates(closedRow)).toEqual(["unavailable", "unavailable"]);
    // The closure flips `state`; it does not rewrite the affordance itself.
    expect(
      (closedRow.actions as { readonly key: string; readonly label: string }[]).map((action) => [
        action.key,
        action.label,
      ])
    ).toEqual([
      ["pay_now", "Pay now"],
      ["view_invoice", "View invoice"],
    ]);
    expect(closedRow.actionTarget).toEqual({
      kind: "subscription",
      id: closedTarget.toHexString(),
      state: "resolved",
    });
    expect(closedRow.actionResolvedAt).toEqual(CLOSED_AT);
    expect((closedRow.updatedAt as Date).getTime()).toBeGreaterThan(SEEDED_AT.getTime());

    // Assert: the same-kind sibling and the other kind are byte-for-byte
    // unchanged — the write is filtered on the pair, never on one half of it.
    expect([
      closureSurface(await requireStoredRow(sibling.id)),
      closureSurface(await requireStoredRow(otherKind.id)),
    ]).toEqual(untouchedBefore);
  });
});

describe("closeInvitationAffordance — the invitation arm of the same closure", () => {
  it("A2: closes the invitation's affordances and records the deciding channel", async () => {
    const invitationTarget = new ObjectId();
    const invitationId = invitationTarget.toHexString();
    const seeded = await seedRow({
      kind: "invitation",
      targetId: invitationId,
      typeKey: "collab.invite.sent",
      actions: ["accept", "reject"],
    });

    // Act: the OP-121 decision path closes the row on the in-app channel.
    await closeInvitationAffordance(app.db, invitationId, CLOSED_AT, "in_app");

    // Assert: the same closure fields the generic helper writes, plus the
    // channel the decision arrived on.
    const closedRow = await requireStoredRow(seeded.id);
    expect(actionStates(closedRow)).toEqual(["unavailable", "unavailable"]);
    expect(closedRow.actionTarget).toEqual({
      kind: "invitation",
      id: invitationId,
      state: "resolved",
    });
    expect(closedRow.actionResolvedVia).toBe("in_app");
    expect(closedRow.actionResolvedAt).toEqual(CLOSED_AT);
  });
});
