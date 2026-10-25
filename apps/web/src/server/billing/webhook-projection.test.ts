import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";

import { computeGraceEndsAt, reduceProviderEvent } from "@/server/billing/webhook-projection";
import type {
  NormalizedProviderEvent,
  NormalizedTransaction,
  ProviderRef,
} from "@/server/payments/payment-provider";
import {
  PLATFORM_SETTINGS_DEFAULTS,
  type PlatformSettings,
} from "@/server/settings/platform-settings";

/**
 * Unit contract — the payment-webhook projection reducer (OP-108 RED, contract
 * §10.1.2 / §14.3 / §14.4 / §23; ADR-0440).
 *
 * The user story: *as the platform I want provider webhooks verified,
 * deduplicated, acknowledged quickly and projected transactionally so that
 * billing state is correct even under replays and delays.*
 *
 * `reduceProviderEvent` is the **pure** half of that projection: given one
 * normalized provider event, the subscription row it matched and the platform
 * settings, it decides what §10.1.2 says the event does to *our* state — the
 * `subscriptions` patch, the `billingTransactions` ledger row that must be
 * inserted in the same transaction, and the domain-event keys to emit. It reads
 * no database, no clock and no environment, so every row of the §10.1.2 mapping
 * table is pinnable without Mongo (U1/U3), and the grace deadline it computes is
 * pinnable without a clock (U2).
 *
 * Renaming a field is not a refactor of this contract: the patch keys are the
 * §14.3 `subscriptions` field names themselves, the transaction keys are the
 * §14.4 `billingTransactions` field names, and the emitted keys are the
 * notification-catalogue `typeKey`s of §4.3 — the ledger, the sweep (OP-111) and
 * the fan-out all read them.
 *
 * ## Contract expected of the implementation
 *
 * - `@/server/billing/webhook-projection` exports the pure
 *   `reduceProviderEvent(input: ProjectionInput): ProjectionDecision` and
 *   `computeGraceEndsAt(failedAt: Date, settings: PlatformSettings): Date`,
 *   plus the transactional applier `projectProviderWebhookEvent(eventId,
 *   { db?, clock? })` that the route's deferred `after()` work and OP-111's
 *   `webhook-projection-sweep` both call (pinned at the integration level).
 * - `ProjectionInput` is `{ event, subscription, settings, now }`, where the
 *   subscription is the §14.3 row the event's `externalRefs` matched, shaped as
 *   this spec's fixture builds it (every §14.3 field present, nullable fields
 *   explicitly `null`).
 * - `ProjectionDecision` is `{ outcome, subscriptionPatch, transaction,
 *   emittedKeys }`: `outcome` is `"applied" | "ignored"`, the patch is the
 *   `$set` document for the matched row (**without** `_id`/`tenantId` — the
 *   caller owns the filter), `transaction` is `null` for a lifecycle row and
 *   otherwise the ledger draft, and `emittedKeys` lists the §10.1.2 domain
 *   events.
 *
 * ## Assumptions recorded in the handoff (ADR-0440)
 *
 * - `gracePeriodEndsAt` is `failedAt + dunning.gracePeriodDays`, read from the
 *   injected settings — never a constant (U2's values are 14, 7 and 1).
 * - `SUBSCRIPTION_PAYMENT_CANCELLED` is not a row of its own: the adapter
 *   normalizes it to `payment_failed` with `failure.category: "auth_required"`
 *   (ADR-0381 §2), so it duns exactly like any other failed charge.
 * - The exact billing-cycle arithmetic is **not** pinned here (only "the period
 *   fields are dates"); the integration suite pins that a successful charge
 *   extends the stored period and that an activation opens one.
 * - Two calls with the same input produce a deeply equal decision, and the
 *   ledger draft's `idempotencyKey` is a deterministic function of the event's
 *   identity (never a random value) — that is what makes a re-projection after a
 *   crash safe.
 */

/** The fixed instant every unit case projects at. */
const NOW = new Date("2026-10-25T10:31:35.000Z");

/** The fixed event instant every unit case carries (one second before `NOW`). */
const OCCURRED_AT = new Date("2026-10-25T10:31:34.000Z");

/** The subscription ref (`subscriptions.externalRefs[]`) every case matched on. */
const SUBSCRIPTION_REF: ProviderRef = {
  provider: "cashfree",
  env: "sandbox",
  kind: "subscription",
  id: "sub_test_001",
};

/** The period start the baseline `active` row carries. */
const BASELINE_PERIOD_START = new Date("2026-10-01T10:31:35.000Z");

/** The period end the baseline `active` row carries before a charge extends it. */
const BASELINE_PERIOD_END = new Date("2026-11-01T10:31:35.000Z");

/** One day in milliseconds. */
const MS_PER_DAY = 86_400_000;

/** `subscriptions.dunning` (§14.3) — the field shape the reducer patches. */
interface SubscriptionDunning {
  readonly attemptCount: number;
  readonly lastAttemptAt: Date | null;
  readonly remindersSent: readonly string[];
  readonly nextReminderAt: Date | null;
}

/**
 * The §14.3 `subscriptions` row as this spec builds it.
 *
 * Every documented field is present — a nullable field is explicitly `null`,
 * never absent — so the fixture is assignable to whatever input shape the
 * implementation declares for the matched row, and a case states only the
 * fields it cares about.
 */
interface SubscriptionRow {
  readonly _id: ObjectId;
  readonly tenantId: string;
  readonly subscribedPlanKey: string;
  readonly subscribedPlanVersion: number;
  readonly activePlanKey: string;
  readonly status: "incomplete" | "active" | "past_due" | "downgraded" | "cancelled" | "expired";
  readonly priceKey: string;
  readonly paymentMethodKind: string;
  readonly mandateStatus: "pending" | "active" | "paused" | "revoked" | "expired";
  readonly billingCycle: string;
  readonly currentPeriodStart: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly nextChargeAt: Date | null;
  readonly gracePeriodEndsAt: Date | null;
  readonly pendingDueMinor: number;
  readonly currency: string;
  readonly dunning: SubscriptionDunning;
  readonly cancelAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly cancelReason: string | null;
  readonly scheduledChange: unknown;
  readonly previousSubscriptionId: ObjectId | null;
  readonly externalRefs: readonly ProviderRef[];
  readonly statusHistory: readonly unknown[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The `incomplete` baseline every case starts from unless it says otherwise. */
const SUBSCRIPTION_BASELINE: SubscriptionRow = {
  _id: new ObjectId("6511111111111111111111aa"),
  tenantId: "6511111111111111111111bb",
  subscribedPlanKey: "starter",
  subscribedPlanVersion: 1,
  activePlanKey: "starter",
  status: "incomplete",
  priceKey: "starter-monthly-inr",
  paymentMethodKind: "mandate_upi",
  mandateStatus: "pending",
  billingCycle: "monthly",
  currentPeriodStart: null,
  currentPeriodEnd: null,
  nextChargeAt: null,
  gracePeriodEndsAt: null,
  pendingDueMinor: 0,
  currency: "INR",
  dunning: { attemptCount: 0, lastAttemptAt: null, remindersSent: [], nextReminderAt: null },
  cancelAt: null,
  cancelledAt: null,
  cancelReason: null,
  scheduledChange: null,
  previousSubscriptionId: null,
  externalRefs: [SUBSCRIPTION_REF],
  statusHistory: [],
  createdAt: new Date("2026-10-01T10:31:35.000Z"),
  updatedAt: new Date("2026-10-01T10:31:35.000Z"),
};

/** Build a `subscriptions` row for the reducer over the `incomplete` baseline. */
function makeSubscription(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return { ...SUBSCRIPTION_BASELINE, ...overrides };
}

/** A paid-up `active` row — the baseline for the renewal and dunning cases. */
function activeSubscription(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return makeSubscription({
    status: "active",
    mandateStatus: "active",
    currentPeriodStart: BASELINE_PERIOD_START,
    currentPeriodEnd: BASELINE_PERIOD_END,
    nextChargeAt: BASELINE_PERIOD_END,
    ...overrides,
  });
}

/** The validated `platformSettings` document the reducer reads its tunables from. */
function makeSettings(overrides: Partial<PlatformSettings["dunning"]> = {}): PlatformSettings {
  return {
    _id: "singleton",
    ...PLATFORM_SETTINGS_DEFAULTS,
    dunning: { ...PLATFORM_SETTINGS_DEFAULTS.dunning, ...overrides },
    updatedAt: "2026-10-25T00:00:00.000Z",
    updatedByUserId: null,
  };
}

/** A succeeded authorization — the `SUBSCRIPTION_AUTH_STATUS` success row (200 minor units). */
const AUTHORIZATION_SUCCEEDED: NormalizedTransaction = {
  kind: "authorization",
  status: "succeeded",
  amountMinor: 200,
  currency: "INR",
  failureCategory: null,
};

/** A succeeded monthly charge of ₹499 (₹499 → `49900` minor units). */
const CHARGE_SUCCEEDED: NormalizedTransaction = {
  kind: "charge",
  status: "succeeded",
  amountMinor: 49_900,
  currency: "INR",
  failureCategory: null,
};

/**
 * Build a normalized provider event.
 *
 * The port's own vocabulary, constructed directly — the `factories/payment.ts`
 * precedent for values that are not wire payloads.
 */
function makeEvent(overrides: Partial<NormalizedProviderEvent> = {}): NormalizedProviderEvent {
  return {
    provider: "cashfree",
    kind: "subscription_activated",
    occurredAt: OCCURRED_AT.toISOString(),
    providerEventId: "49988825",
    externalRefs: [SUBSCRIPTION_REF],
    status: "active",
    mandateStatus: "active",
    transaction: AUTHORIZATION_SUCCEEDED,
    ...overrides,
  };
}

/** One row of the §10.1.2 mapping table, as an executable case. */
interface ProjectionCase {
  /** The §10.1.2 row under test, named by its normalized kind and expected move. */
  readonly label: string;
  /** The normalized event the adapter produces for that vendor event. */
  readonly event: NormalizedProviderEvent;
  /** The matched subscription; defaults to the `incomplete` baseline. */
  readonly subscription?: SubscriptionRow;
  /**
   * The decision fields that must be present as given. Typed loosely on
   * purpose: the expected patch/transaction are *partial* documents, and
   * `toMatchObject` allows the actual document to carry the rest.
   */
  readonly expected: Readonly<Record<string, unknown>>;
  /** The domain-event keys the row emits, compared order-insensitively. */
  readonly emittedKeys: readonly string[];
}

/**
 * Every row of the §10.1.2 mapping table that moves our state.
 *
 * `SUBSCRIPTION_PAYMENT_CANCELLED` is absent by construction: the adapter
 * normalizes it to `payment_failed` with `auth_required` (ADR-0381 §2).
 */
const PROJECTION_CASES: ReadonlyArray<ProjectionCase> = [
  {
    label: "mandate_pending → the mandate is marked pending",
    event: makeEvent({
      kind: "mandate_pending",
      status: "incomplete",
      mandateStatus: "pending",
      providerEventId: null,
      transaction: null,
    }),
    expected: {
      outcome: "applied",
      subscriptionPatch: { status: "incomplete", mandateStatus: "pending" },
      transaction: null,
    },
    emittedKeys: ["billing.mandate.pending"],
  },
  {
    label: "subscription_activated → active, with the period opened and a succeeded authorization",
    event: makeEvent({}),
    expected: {
      outcome: "applied",
      subscriptionPatch: {
        status: "active",
        mandateStatus: "active",
        currentPeriodStart: expect.any(Date),
        currentPeriodEnd: expect.any(Date),
        nextChargeAt: expect.any(Date),
      },
      transaction: {
        kind: "authorization",
        status: "succeeded",
        amountMinor: 200,
        currency: "INR",
      },
    },
    emittedKeys: ["billing.subscription.activated"],
  },
  {
    label: "mandate_failed → the status stays incomplete and the authorization is recorded failed",
    event: makeEvent({
      kind: "mandate_failed",
      status: "incomplete",
      mandateStatus: "pending",
      transaction: {
        kind: "authorization",
        status: "failed",
        amountMinor: 200,
        currency: "INR",
        failureCategory: "insufficient_funds",
      },
    }),
    expected: {
      outcome: "applied",
      subscriptionPatch: { status: "incomplete" },
      transaction: {
        kind: "authorization",
        status: "failed",
        failureCategory: "insufficient_funds",
      },
    },
    emittedKeys: ["billing.mandate.failed"],
  },
  {
    label: "ignored → nothing moves and nothing is emitted",
    event: makeEvent({
      kind: "ignored",
      status: null,
      mandateStatus: null,
      providerEventId: null,
      transaction: null,
    }),
    subscription: activeSubscription(),
    expected: { outcome: "ignored", subscriptionPatch: null, transaction: null },
    emittedKeys: [],
  },
  {
    label: "payment_succeeded → the period extends, dunning resets and the charge is recorded",
    event: makeEvent({
      kind: "payment_succeeded",
      providerEventId: "49914526",
      transaction: CHARGE_SUCCEEDED,
    }),
    subscription: activeSubscription(),
    expected: {
      outcome: "applied",
      subscriptionPatch: {
        status: "active",
        pendingDueMinor: 0,
        gracePeriodEndsAt: null,
        currentPeriodEnd: expect.any(Date),
        dunning: { attemptCount: 0, lastAttemptAt: null, remindersSent: [], nextReminderAt: null },
      },
      transaction: { kind: "charge", status: "succeeded", amountMinor: 49_900, currency: "INR" },
    },
    emittedKeys: ["billing.payment.succeeded"],
  },
  {
    label: "payment_failed → past_due, with the grace deadline from settings and the due amount",
    event: makeEvent({
      kind: "payment_failed",
      providerEventId: "49914527",
      transaction: {
        kind: "charge",
        status: "failed",
        amountMinor: 49_900,
        currency: "INR",
        failureCategory: "mandate_revoked",
      },
    }),
    subscription: activeSubscription(),
    expected: {
      outcome: "applied",
      subscriptionPatch: {
        status: "past_due",
        gracePeriodEndsAt: new Date(NOW.getTime() + 14 * MS_PER_DAY),
        pendingDueMinor: 49_900,
        dunning: { attemptCount: 1, lastAttemptAt: NOW },
      },
      transaction: {
        kind: "charge",
        status: "failed",
        amountMinor: 49_900,
        failureCategory: "mandate_revoked",
      },
    },
    emittedKeys: ["billing.payment.failed"],
  },
  {
    label: "subscription_cancelled → cancelled, with the mandate revoked",
    event: makeEvent({
      kind: "subscription_cancelled",
      providerEventId: null,
      status: "cancelled",
      mandateStatus: "revoked",
      transaction: null,
    }),
    subscription: activeSubscription(),
    expected: {
      outcome: "applied",
      subscriptionPatch: { status: "cancelled", mandateStatus: "revoked" },
      transaction: null,
    },
    emittedKeys: ["billing.subscription.cancelled"],
  },
  {
    label: "refund_processed → the refund is recorded and the subscription is untouched",
    event: makeEvent({
      kind: "refund_processed",
      providerEventId: "700001",
      status: null,
      mandateStatus: null,
      transaction: {
        kind: "refund",
        status: "succeeded",
        amountMinor: 49_900,
        currency: "INR",
        failureCategory: null,
      },
    }),
    subscription: activeSubscription(),
    expected: {
      outcome: "applied",
      transaction: { kind: "refund", status: "succeeded", amountMinor: 49_900, currency: "INR" },
    },
    emittedKeys: ["billing.refund.processed"],
  },
];

/** The emitted keys as a comparable set — §10.1.2 pins the keys, not their order. */
function sortedKeys(keys: readonly string[]): string[] {
  return [...keys].sort();
}

describe("reduceProviderEvent — the §10.1.2 mapping table", () => {
  it.each(PROJECTION_CASES)("U1: $label", ({ event, subscription, expected, emittedKeys }) => {
    // Act
    const decision = reduceProviderEvent({
      event,
      subscription: subscription ?? makeSubscription(),
      settings: makeSettings(),
      now: NOW,
    });

    // Assert
    expect(decision).toMatchObject(expected);
    expect(sortedKeys(decision.emittedKeys)).toEqual(sortedKeys(emittedKeys));
  });

  it("U1: the same input reduces to a deeply equal decision, with a deterministic ledger key", () => {
    // Arrange
    const input = {
      event: makeEvent({
        kind: "payment_succeeded",
        providerEventId: "49914526",
        transaction: CHARGE_SUCCEEDED,
      }),
      subscription: activeSubscription(),
      settings: makeSettings(),
      now: NOW,
    };

    // Act
    const first = reduceProviderEvent(input);
    const second = reduceProviderEvent(input);

    // Assert — purity: no clock, no database, no random value inside.
    expect(first).toEqual(second);
    expect(first.transaction?.idempotencyKey).toBeTruthy();
  });

  it("U1: two different provider events get different ledger idempotency keys", () => {
    // Arrange
    const subscription = activeSubscription();
    const chargeKey = (providerEventId: string): string | undefined =>
      reduceProviderEvent({
        event: makeEvent({
          kind: "payment_succeeded",
          providerEventId,
          transaction: CHARGE_SUCCEEDED,
        }),
        subscription,
        settings: makeSettings(),
        now: NOW,
      }).transaction?.idempotencyKey;

    // Act
    const first = chargeKey("49914526");
    const second = chargeKey("49914527");

    // Assert — the ledger's replay protection is keyed on the intent, not the call.
    expect(first).toBeTruthy();
    expect(second).not.toBe(first);
  });
});

describe("computeGraceEndsAt — the grace deadline comes from settings", () => {
  it("U2: the documented 14-day default ends the window 14 days after the failure", () => {
    // Arrange
    const failedAt = new Date("2026-10-25T10:31:35.000Z");

    // Act
    const graceEndsAt = computeGraceEndsAt(failedAt, makeSettings());

    // Assert
    expect(graceEndsAt).toEqual(new Date("2026-11-08T10:31:35.000Z"));
  });

  it("U2: an operator's 7-day grace period is honoured, not the default", () => {
    // Arrange
    const failedAt = new Date("2026-10-25T10:31:35.000Z");

    // Act
    const graceEndsAt = computeGraceEndsAt(failedAt, makeSettings({ gracePeriodDays: 7 }));

    // Assert
    expect(graceEndsAt).toEqual(new Date("2026-11-01T10:31:35.000Z"));
  });

  it("U2: a one-day grace period is honoured at the boundary of the allowed range", () => {
    // Arrange
    const failedAt = new Date("2026-10-25T23:59:59.000Z");

    // Act
    const graceEndsAt = computeGraceEndsAt(failedAt, makeSettings({ gracePeriodDays: 1 }));

    // Assert
    expect(graceEndsAt).toEqual(new Date("2026-10-26T23:59:59.000Z"));
  });
});

describe("reduceProviderEvent — recovering a downgraded subscription", () => {
  it("U3: a payment success on a downgraded row reactivates the plan they pay for", () => {
    // Arrange — a dunned row: access on `free`, the paid plan still recorded.
    const downgraded = makeSubscription({
      status: "downgraded",
      mandateStatus: "revoked",
      activePlanKey: "free",
      subscribedPlanKey: "professional",
      subscribedPlanVersion: 2,
      pendingDueMinor: 49_900,
      gracePeriodEndsAt: new Date("2026-10-20T10:31:35.000Z"),
      currentPeriodStart: BASELINE_PERIOD_START,
      currentPeriodEnd: BASELINE_PERIOD_END,
      dunning: {
        attemptCount: 3,
        lastAttemptAt: new Date("2026-10-19T10:31:35.000Z"),
        remindersSent: ["d1", "d5", "d7"],
        nextReminderAt: new Date("2026-10-26T10:31:35.000Z"),
      },
    });

    // Act
    const decision = reduceProviderEvent({
      event: makeEvent({
        kind: "payment_succeeded",
        providerEventId: "49914526",
        transaction: CHARGE_SUCCEEDED,
      }),
      subscription: downgraded,
      settings: makeSettings(),
      now: NOW,
    });

    // Assert — reactivation is a status flip on the same record: `activePlanKey`
    // returns to `subscribedPlanKey` ("professional"), never to a hard-coded tier.
    expect(decision.outcome).toBe("applied");
    expect(decision.subscriptionPatch).toMatchObject({
      status: "active",
      activePlanKey: "professional",
      pendingDueMinor: 0,
      gracePeriodEndsAt: null,
      dunning: { attemptCount: 0, lastAttemptAt: null, remindersSent: [], nextReminderAt: null },
    });
    expect(sortedKeys(decision.emittedKeys)).toEqual(
      sortedKeys([
        "billing.payment.succeeded",
        "billing.subscription.reactivated",
        "usage.limit.restored",
      ])
    );
  });
});

describe("reduceProviderEvent — money is recorded even when access does not move", () => {
  it("an activation for a row that is already active still records the authorization", () => {
    // Act
    const decision = reduceProviderEvent({
      event: makeEvent({ transaction: AUTHORIZATION_SUCCEEDED }),
      subscription: activeSubscription(),
      settings: makeSettings(),
      now: NOW,
    });

    // Assert — the ledger is append-only (§14.4): a money event is recorded even
    // when the access state does not change.
    expect(decision.transaction).toMatchObject({
      kind: "authorization",
      status: "succeeded",
      amountMinor: 200,
    });
    expect(decision.subscriptionPatch).toMatchObject({ status: "active" });
  });

  it("a lifecycle event with no transaction leaves the ledger untouched", () => {
    // Act
    const decision = reduceProviderEvent({
      event: makeEvent({
        kind: "subscription_cancelled",
        status: "expired",
        mandateStatus: "expired",
        transaction: null,
      }),
      subscription: activeSubscription(),
      settings: makeSettings(),
      now: NOW,
    });

    // Assert
    expect(decision.transaction).toBeNull();
    expect(decision.outcome).toBe("applied");
  });
});
