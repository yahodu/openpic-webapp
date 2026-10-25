import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { memoryPaymentProvider } from "../src/server/adapters/memory-payment-provider";

import { E2E_BASE_URL } from "./ports";

/**
 * E1 — a checkout followed by its signed activation webhook turns the
 * subscription active (OP-108, contract §10.1 / §3.2; ADR-0440).
 *
 * The integration suite drives the inbox handler in-process; this spec proves
 * the same journey through a real `next start` server: the middleware (which
 * exempts `/api/v1/webhooks/**` from the CSRF + Origin gate because webhooks are
 * signature-verified, §0.10 / ADR-0004), a real Better Auth session for the
 * checkout half, the `current` tenant alias, the **in-process memory provider**
 * the e2e server selects by default (`APP_ENV=e2e`, no `PAYMENT_PROVIDER`), and
 * that provider's `signWebhook` — the same signature scheme the vendor adapter
 * verifies (ADR-0383 §3).
 *
 *   sign in → provision the workspace → `POST /billing/checkout` (`201`,
 *   `incomplete`) → `POST /api/v1/webhooks/memory` with a signed normalized
 *   event → `GET /subscription` shows `active`.
 *
 * ## Two affordances this spec relies on, stated in the handoff (ADR-0440)
 *
 * - **The mandate id comes out of the hosted link.** The projection matches the
 *   subscription by `{externalRefs.provider, externalRefs.id}`, and no endpoint
 *   may hand a provider ref back (§0.15), so the only place an e2e can learn the
 *   ref is the link itself: the memory adapter's `checkoutUrl` is
 *   `https://memory.openpic.local/checkout/<id>` with the *same* `<id>` it stores
 *   as `externalRefs[0].id` (ADR-0383, pinned by
 *   `payments-memory-provider.test.ts`). The spec asserts the id's shape rather
 *   than trusting the derivation blindly.
 * - **The read polls.** §10.1 step 5/6 make the projection post-response work
 *   (`after()`), so the `active` state is observable *shortly after* the `200`
 *   returns; `expect.poll` is the web-first way to observe it (never a sleep).
 *
 * The email is unique per run so the `auth.otp` limit never bleeds into a re-run
 * when `reuseExistingServer` keeps the e2e server alive.
 */

/** The literal alias the tenant stage resolves (contract §0.4). */
const CURRENT_PATH = "/api/v1/tenants/current";

/** The memory provider's hosted-mandate URL prefix (ADR-0383). */
const MEMORY_CHECKOUT_PREFIX = "https://memory.openpic.local/checkout/";

/** The CSRF pair every mutating *session* request carries (the webhook needs none). */
const CSRF_HEADERS = {
  origin: E2E_BASE_URL,
  "x-requested-with": "XMLHttpRequest",
};

/** The amount the seeded `starter-monthly-inr` price charges, in minor units. */
const STARTER_AMOUNT_MINOR = 49_900;

test.describe("POST /api/v1/webhooks/{provider}", () => {
  test("E1: a checkout then a signed activation webhook leaves the subscription active", async ({
    request,
  }) => {
    const email = `e2e-op108-${String(Date.now())}-${Math.random().toString(16).slice(2)}@example.com`;

    const sent = await request.post("/api/auth/email-otp/send-verification-otp", {
      headers: { origin: E2E_BASE_URL },
      data: { email, type: "sign-in" },
    });
    expect(sent.status()).toBe(200);

    const captured = await request.get(
      `/api/v1/__test__/otp?contact=${encodeURIComponent(email)}&channel=email`
    );
    expect(captured.status()).toBe(200);
    const { code } = (await captured.json()) as { code: string | null };
    expect(typeof code).toBe("string");

    const signedIn = await request.post("/api/auth/sign-in/email-otp", {
      headers: { origin: E2E_BASE_URL },
      data: { email, otp: code },
    });
    expect(signedIn.status()).toBe(200);

    // The organizer action: the first tenant-scoped write provisions the workspace.
    const provisioned = await request.patch(CURRENT_PATH, {
      headers: CSRF_HEADERS,
      data: { name: "E2E Webhook Studio" },
    });
    expect(provisioned.status()).toBe(200);

    // Act 1 — start the mandate; the state is `incomplete` and must stay there
    // until a *verified* webhook moves it (§3.3).
    const checkout = await request.post(`${CURRENT_PATH}/billing/checkout`, {
      headers: { ...CSRF_HEADERS, "idempotency-key": randomUUID() },
      data: {
        planKey: "starter",
        priceKey: "starter-monthly-inr",
        returnUrl: `${E2E_BASE_URL}/billing/return`,
      },
    });
    expect(checkout.status()).toBe(201);

    const envelope = (await checkout.json()) as {
      subscriptionId?: unknown;
      status?: unknown;
      checkout?: { url?: string };
    };
    expect(envelope.status).toBe("incomplete");
    const checkoutUrl = envelope.checkout?.url ?? "";
    expect(checkoutUrl.startsWith(MEMORY_CHECKOUT_PREFIX)).toBe(true);
    const mandateId = new URL(checkoutUrl).pathname.split("/").filter(Boolean).at(-1) ?? "";
    expect(mandateId).toMatch(/^mem_sub_/);

    // Act 2 — the provider's activation, signed with the memory adapter's own
    // signer (the scheme a production adapter would verify).
    const rawBody = JSON.stringify({
      provider: "memory",
      kind: "subscription_activated",
      occurredAt: new Date().toISOString(),
      providerEventId: "mem_evt_op108_e1",
      externalRefs: [{ provider: "memory", env: "sandbox", kind: "subscription", id: mandateId }],
      status: "active",
      mandateStatus: "active",
      transaction: {
        kind: "authorization",
        status: "succeeded",
        amountMinor: STARTER_AMOUNT_MINOR,
        currency: "INR",
        failureCategory: null,
      },
    });
    const signature = memoryPaymentProvider({ env: "sandbox" }).signWebhook(rawBody);

    const delivered = await request.post("/api/v1/webhooks/memory", {
      headers: { "content-type": "application/json", ...signature },
      data: rawBody,
    });

    // Assert — acknowledged first…
    expect(delivered.status()).toBe(200);
    expect(await delivered.json()).toEqual({ status: "received" });

    // …then the deferred projection lands and the organizer sees the paid state.
    await expect
      .poll(async () => {
        const response = await request.get(`${CURRENT_PATH}/subscription`);
        const view = (await response.json()) as { status?: unknown };
        return view.status;
      })
      .toBe("active");

    const subscription = await request.get(`${CURRENT_PATH}/subscription`);
    expect(subscription.status()).toBe(200);
    const view = (await subscription.json()) as {
      exists?: unknown;
      status?: unknown;
      activePlanKey?: unknown;
    };
    expect(view.exists).toBe(true);
    expect(view.status).toBe("active");
    expect(view.activePlanKey).toBe("starter");
  });
});
