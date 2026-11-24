import { randomUUID } from "node:crypto";

import { ObjectId, type Db } from "mongodb";
import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { POST as startCheckout } from "@/app/api/v1/tenants/[tenantId]/billing/checkout/route";
import { POST as upgradePlan } from "@/app/api/v1/tenants/[tenantId]/billing/upgrade/route";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { seedPlans } from "@/server/plans/seed-plans";
import * as subscriptions from "@/server/services/subscriptions";

import {
  makeCashfreeCreateSubscriptionResponse,
  TEST_CASHFREE_WEBHOOK_SECRET,
} from "../factories/payment";
import { body } from "../helpers/auth-requests";
import { APP_ORIGIN, makeIdentity, startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { server } from "./setup";

/**
 * Integration / contract — the stored hosted link and the delegate read seam
 * (OP-140 precondition, contract §7.3 `subscription` × `complete_mandate`;
 * ADR-0403).
 *
 * The OP-140 notification-action endpoint delegates the §7.3 row
 * `subscription × complete_mandate` to the owning document: the delegate "returns
 * the stored `checkout.url`". ADR-0942 §2 measured the gap: `POST
 * …/billing/checkout` writes `subscriptions.checkout = { url, expiresAt }`
 * (`billing/checkout/route.ts:422`) and `decideExistingSubscription` reads it
 * back (`server/services/subscriptions/checkout.ts:163`), but `POST
 * …/billing/upgrade` mints its row **without** that field
 * (`billing/upgrade/route.ts:336`) and answers `mandate.checkoutUrl` inline in
 * the response body only. No seam exists for a delegate to read the value.
 *
 * ## Contract expected of the implementation
 *
 * 1. **The upgrade mint path persists the same two fields the checkout path
 *    writes.** The `subscriptions.insertOne` in `POST
 *    /api/v1/tenants/:tenantId/billing/upgrade` stores
 *    `checkout: { url: mandate.checkoutUrl, expiresAt }` where `expiresAt =
 *    new Date(mandate.expiresAt)` — the mandate's own instant, exactly as
 *    `billing/checkout/route.ts:416-422` derives it. No invented TTL and no
 *    copied constant: `I1` pins the stored instant against the **vendor
 *    fixture's** `subscription_expiry_time`, so a row that stored
 *    `now + <constant>` fails.
 * 2. **A read seam in `@/server/services/subscriptions`** (the barrel this
 *    suite imports; the recommended module is
 *    `server/services/subscriptions/stored-checkout.ts`):
 *
 *    ```ts
 *    export interface StoredCheckout {
 *      readonly url: string;
 *      readonly expiresAt: Date;
 *    }
 *    export function readStoredCheckout(input: {
 *      readonly db: Db;
 *      readonly subscriptionId: ObjectId;
 *    }): Promise<StoredCheckout | null>;
 *    ```
 *
 *    It answers the **named row's own** `checkout` block — `null` when that row
 *    stores none and `null` when no row carries that `_id` — and never throws
 *    for either absence. The `db`-only input means the read is id-keyed, not
 *    tenant-keyed: the delegate will hold the row's own id (`actionTarget.id`,
 *    the 24-hex form of the same `ObjectId`), never a tenant id.
 *
 * ## Why the route is driven, not a mocked provider
 *
 * Both arms go through the real route modules with the Cashfree adapter
 * selected (`PAYMENT_PROVIDER=cashfree` + the four `CASHFREE_*` names) and MSW
 * intercepting the vendor calls, so the persisted value has one provenance: the
 * mandate the provider answered. The seam is then read back through the barrel —
 * the arrow a delegate will use. Nothing asserts the row's field shape
 * directly; every assertion is "what the mint handed the caller, the seam
 * answers for that subscription".
 *
 * ## Numbering
 *
 * `I1` the upgrade mint answers through the seam; `I2` the seam answers the
 * **named** row, not the workspace's newest row; `I3` the checkout mint keeps
 * answering its own link (the `reuse` arm's dependency); `I4` a row that stores
 * no link answers `null`; `I5` an id that names no subscription answers `null`.
 */

const TENANTS_PATH = "/api/v1/tenants";

/** The sandbox mandate endpoint the Cashfree adapter creates a subscription on. */
const CASHFREE_CREATE_URL = "https://sandbox.cashfree.com/pg/subscriptions";

/** The pinned v2025-01-01 Manage Subscription endpoint (ADR-0460 §1). */
const CASHFREE_MANAGE_URL = "https://sandbox.cashfree.com/pg/subscriptions/:subscriptionId/manage";

/** The vendor subscription id the pre-existing (starter) mandate carries. */
const OLD_VENDOR_SUBSCRIPTION_ID = "cf_prev_001";

/** The fixed vendor decision expiry the upgrade's create call answers with. */
const UPGRADE_MANDATE_EXPIRES_AT = "2026-11-01T05:00:46.000Z";

/** The hosted link the upgrade's fresh mandate answers with. */
const UPGRADE_CHECKOUT_URL = "https://payments-test.cashfree.com/links/upgrade-0403";

/** A **different** decision expiry, so the checkout arm cannot share a constant. */
const CHECKOUT_MANDATE_EXPIRES_AT = "2026-11-02T06:30:00.000Z";

/** The hosted link the checkout's mandate answers with. */
const CHECKOUT_URL = "https://payments-test.cashfree.com/links/checkout-0403";

/** The payments selection this suite drives the routes with. */
const PAYMENTS_ENV: Record<string, string> = {
  PAYMENT_PROVIDER: "cashfree",
  CASHFREE_CLIENT_ID: "test-client-id",
  CASHFREE_CLIENT_SECRET: "test-client-secret",
  CASHFREE_API_VERSION: "2025-01-01",
  CASHFREE_WEBHOOK_SECRET: TEST_CASHFREE_WEBHOOK_SECRET,
};

/** The `returnUrl` every accepted mutation carries (an allow-listed origin). */
const RETURN_URL = new URL("/billing/return", APP_ORIGIN).toString();

/** The §3.3 mint envelope both arms answer with, as served. */
const mintedEnvelopeSchema = z.object({
  subscriptionId: z.string().regex(/^[0-9a-f]{24}$/i),
  status: z.literal("incomplete"),
  checkout: z.object({
    kind: z.literal("redirect"),
    url: z.string().min(1),
    expiresAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
      message: "not an ISO date-time",
    }),
  }),
});

/** The parsed §3.3 mint envelope. */
type MintedEnvelope = z.infer<typeof mintedEnvelopeSchema>;

/** The seam's input, as this suite calls it. */
interface ReadStoredCheckoutInput {
  readonly db: Db;
  readonly subscriptionId: ObjectId;
}

/** What the seam answers for a row that stores a hosted link. */
interface StoredCheckout {
  readonly url: string;
  readonly expiresAt: Date;
}

/** The seam's contract. */
type ReadStoredCheckout = (input: ReadStoredCheckoutInput) => Promise<StoredCheckout | null>;

/**
 * The seam as the barrel exports it, or `undefined` while it does not exist.
 *
 * A named import of a missing export from an **existing** module is `undefined`
 * rather than a load error, so reading it through a typed guard is what turns
 * "the seam is absent" into a failure message that names the export and its
 * signature instead of `TypeError: readStoredCheckout is not a function`.
 */
const readStoredCheckoutExport = (
  subscriptions as unknown as { readStoredCheckout?: ReadStoredCheckout }
).readStoredCheckout;

/**
 * Read a subscription's stored hosted link through the barrel seam.
 *
 * @param input - The database handle and the row's own `ObjectId`.
 * @returns The stored `{ url, expiresAt }`, or `null`.
 */
function readStoredCheckout(input: ReadStoredCheckoutInput): Promise<StoredCheckout | null> {
  if (typeof readStoredCheckoutExport !== "function") {
    throw new Error(
      "@/server/services/subscriptions must export readStoredCheckout({ db, subscriptionId }) answering { url, expiresAt } | null"
    );
  }
  return readStoredCheckoutExport(input);
}

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op140-stored-checkout", env: PAYMENTS_ENV });
  // Both arms resolve the sold price from the plan catalogue (§14.1).
  await seedPlans({ db: app.db });
  // §3.3's one-live-row invariant is arbitrated by
  // `subscriptions_active_tenant_unique`, so the upgrade's cancel-then-insert
  // runs against the real index.
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

/** Merge fields into a caller's auto-provisioned `userProfiles` row. */
async function updateProfile(userId: ObjectId, fields: Record<string, unknown>): Promise<void> {
  const result = await app.db
    .collection(COLLECTIONS.userProfiles)
    .updateOne({ userId }, { $set: { ...fields, updatedAt: new Date() } });
  expect(result.matchedCount).toBe(1);
}

/** Insert a tenant (schema §13.3) and return its id. */
async function insertTenant(fields: { slug: string; ownerUserId: ObjectId }): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.tenants).insertOne({
    _id,
    slug: fields.slug,
    name: "OP140 Billing Studio",
    status: "active",
    ownerUserId: fields.ownerUserId,
    billingContactUserId: fields.ownerUserId,
    dataRegion: "in",
    counters: {
      eventCount: 0,
      activeEventCount: 0,
      imageCount: 0,
      storageBytes: 0,
      attendeeCount: 0,
      reconciledAt: null,
    },
    settings: {
      defaultTimeZone: "Asia/Kolkata",
      brandLogoAssetId: null,
      defaultWatermarkAssetId: null,
    },
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    schemaVersion: 1,
  });
  return _id;
}

/** Seed a workspace whose `current` alias resolves to the new tenant. */
async function seedWorkspace(options: { userId: ObjectId; slug: string }): Promise<ObjectId> {
  const tenantId = await insertTenant({ slug: options.slug, ownerUserId: options.userId });
  await app.db.collection(COLLECTIONS.tenantMembers).insertOne({
    tenantId,
    userId: options.userId,
    role: "owner",
    status: "active",
    joinedAt: new Date(),
  });
  await updateProfile(options.userId, { primaryTenantId: tenantId });
  return tenantId;
}

/** The stored `subscriptions` shape one case starts from. */
interface SeedSubscriptionOptions {
  readonly tenantId: string;
  readonly status: "incomplete" | "active";
  /** The hosted link the row carries (absent by default). */
  readonly checkout?: { readonly url: string; readonly expiresAt: Date };
}

/**
 * Seed the workspace's **live** `subscriptions` row (schema §14.3) and return
 * its id.
 *
 * `cancelledAt` stays `null`, so the row occupies the
 * `subscriptions_active_tenant_unique` slot the upgrade has to release. The
 * `checkout` block is written only when the case supplies one, so `I4`'s
 * link-less row is genuinely link-less.
 */
async function seedSubscription(options: SeedSubscriptionOptions): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.subscriptions).insertOne({
    _id,
    tenantId: options.tenantId,
    subscribedPlanKey: "starter",
    subscribedPlanVersion: 1,
    activePlanKey: "starter",
    status: options.status,
    ...(options.checkout === undefined ? {} : { checkout: options.checkout }),
    priceKey: "starter-monthly-inr",
    billingCycle: "monthly",
    paymentMethodKind: "mandate_upi",
    mandateStatus: options.status === "active" ? "active" : "pending",
    currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
    nextChargeAt: new Date("2026-10-01T00:00:00.000Z"),
    gracePeriodEndsAt: null,
    pendingDueMinor: 0,
    currency: "INR",
    dunning: { attemptCount: 0, lastAttemptAt: null, remindersSent: [], nextReminderAt: null },
    cancelAt: null,
    cancelledAt: null,
    cancelReason: null,
    scheduledChange: null,
    previousSubscriptionId: null,
    statusHistory: [],
    externalRefs: [
      {
        provider: "cashfree",
        env: "sandbox",
        kind: "subscription",
        id: OLD_VENDOR_SUBSCRIPTION_ID,
      },
    ],
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  });
  return _id;
}

/** The vendor's Manage Subscription response, as Cashfree v2025-01-01 answers it. */
function makeManageResponse(vendorSubscriptionId: string): Record<string, unknown> {
  return {
    ...makeCashfreeCreateSubscriptionResponse({
      subscription_id: vendorSubscriptionId,
      subscription_status: "CANCELLED",
    }),
    subscription_first_charge_time: null,
    next_schedule_date: null,
  };
}

/**
 * Answer a mandate create on either arm, recording what the wire was told.
 *
 * @param answer - The hosted link and decision expiry the vendor answers with.
 * @returns A record whose `creates()` is the ordered list of create calls.
 */
function answerVendorCalls(answer: { readonly checkoutUrl: string; readonly expiresAt: string }): {
  readonly creates: () => number;
} {
  let creates = 0;
  server.use(
    http.post(CASHFREE_MANAGE_URL, ({ params }) =>
      HttpResponse.json(makeManageResponse(String(params.subscriptionId)))
    ),
    http.post(CASHFREE_CREATE_URL, () => {
      creates += 1;
      return HttpResponse.json(
        makeCashfreeCreateSubscriptionResponse({
          subscription_id: "sub_new_0403",
          cf_subscription_id: "98765432",
          subscription_expiry_time: answer.expiresAt,
          auth_link: answer.checkoutUrl,
        })
      );
    })
  );
  return { creates: () => creates };
}

/** A `POST …/billing/upgrade` request carrying an idempotency key. */
function upgradeRequest(options: { tenantPath: string; cookie: string }): Request {
  return new Request(new URL(`${TENANTS_PATH}/${options.tenantPath}/billing/upgrade`, APP_ORIGIN), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: options.cookie,
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify({
      targetPlanKey: "professional",
      priceKey: "professional-monthly-inr",
      returnUrl: RETURN_URL,
    }),
  });
}

/** A `POST …/billing/checkout` request carrying an idempotency key. */
function checkoutRequest(options: { tenantPath: string; cookie: string }): Request {
  return new Request(
    new URL(`${TENANTS_PATH}/${options.tenantPath}/billing/checkout`, APP_ORIGIN),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: options.cookie,
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify({
        planKey: "starter",
        priceKey: "starter-monthly-inr",
        returnUrl: RETURN_URL,
      }),
    }
  );
}

/**
 * Assert a `201` and parse the §3.3 mint envelope.
 *
 * @param response - The route's answer.
 * @returns The parsed envelope.
 */
async function mintedEnvelope(response: Response): Promise<MintedEnvelope> {
  const parsed = await body(response);
  // The served error envelope is the context a non-201 failure needs.
  expect(response.status, JSON.stringify(parsed)).toBe(201);
  return mintedEnvelopeSchema.parse(parsed);
}

describe("the stored hosted link of a minted subscription (OP-140 precondition)", () => {
  it("I1: a subscription minted by the upgrade path answers the mandate's link and expiry through the seam", async () => {
    const owner = await app.signIn(makeIdentity("op140-upgrade"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      slug: `op140-upgrade-${new ObjectId().toHexString()}`,
    });
    await seedSubscription({ tenantId: tenantId.toHexString(), status: "active" });
    answerVendorCalls({ checkoutUrl: UPGRADE_CHECKOUT_URL, expiresAt: UPGRADE_MANDATE_EXPIRES_AT });

    const envelope = await mintedEnvelope(
      await upgradePlan(
        upgradeRequest({ tenantPath: tenantId.toHexString(), cookie: owner.cookie })
      )
    );

    const stored = await readStoredCheckout({
      db: app.db,
      subscriptionId: new ObjectId(envelope.subscriptionId),
    });

    // The vendor answered this link and this decision expiry; the row the
    // upgrade minted must answer both back, unchanged.
    expect(envelope.checkout.url).toBe(UPGRADE_CHECKOUT_URL);
    expect(stored).toEqual({
      url: UPGRADE_CHECKOUT_URL,
      expiresAt: new Date(UPGRADE_MANDATE_EXPIRES_AT),
    });
    // The stored instant is the mandate's, not an interval measured from now.
    expect(stored?.expiresAt.toISOString()).toBe(
      new Date(UPGRADE_MANDATE_EXPIRES_AT).toISOString()
    );
    expect(stored?.expiresAt.toISOString()).toBe(envelope.checkout.expiresAt);
  });

  it("I2: the seam answers the named row, not the workspace's newest subscription", async () => {
    const owner = await app.signIn(makeIdentity("op140-named-row"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      slug: `op140-named-${new ObjectId().toHexString()}`,
    });
    const predecessorId = await seedSubscription({
      tenantId: tenantId.toHexString(),
      status: "active",
    });
    answerVendorCalls({ checkoutUrl: UPGRADE_CHECKOUT_URL, expiresAt: UPGRADE_MANDATE_EXPIRES_AT });

    const envelope = await mintedEnvelope(
      await upgradePlan(
        upgradeRequest({ tenantPath: tenantId.toHexString(), cookie: owner.cookie })
      )
    );

    const minted = await readStoredCheckout({
      db: app.db,
      subscriptionId: new ObjectId(envelope.subscriptionId),
    });
    const superseded = await readStoredCheckout({ db: app.db, subscriptionId: predecessorId });

    expect(minted?.url).toBe(UPGRADE_CHECKOUT_URL);
    // The upgrade cancelled the predecessor and left it link-less; a read that
    // returns "the workspace's newest row" answers the new link here instead.
    expect(superseded).toBeNull();
  });

  it("I3: a subscription minted by the checkout path keeps answering its own link through the seam", async () => {
    const owner = await app.signIn(makeIdentity("op140-checkout"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      slug: `op140-checkout-${new ObjectId().toHexString()}`,
    });
    answerVendorCalls({ checkoutUrl: CHECKOUT_URL, expiresAt: CHECKOUT_MANDATE_EXPIRES_AT });

    const envelope = await mintedEnvelope(
      await startCheckout(
        checkoutRequest({ tenantPath: tenantId.toHexString(), cookie: owner.cookie })
      )
    );

    const stored = await readStoredCheckout({
      db: app.db,
      subscriptionId: new ObjectId(envelope.subscriptionId),
    });

    expect(stored).toEqual({
      url: CHECKOUT_URL,
      expiresAt: new Date(CHECKOUT_MANDATE_EXPIRES_AT),
    });
    expect(stored?.url).not.toBe(UPGRADE_CHECKOUT_URL);
  });

  it("I4: a subscription that stores no hosted link answers null", async () => {
    const tenantId = new ObjectId();
    const subscriptionId = await seedSubscription({
      tenantId: tenantId.toHexString(),
      status: "active",
    });

    const stored = await readStoredCheckout({ db: app.db, subscriptionId });

    expect(stored).toBeNull();
  });

  it("I5: an id that names no subscription answers null", async () => {
    const stored = await readStoredCheckout({ db: app.db, subscriptionId: new ObjectId() });

    expect(stored).toBeNull();
  });
});
