import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { E2E_BASE_URL } from "./ports";

/**
 * E1 — checkout through the deployed HTTP surface (OP-107, contract §3.3;
 * ADR-0420).
 *
 * The integration suite drives the route handler in-process with the Cashfree
 * adapter behind MSW; this spec proves the same journey through a real
 * `next start` server, the middleware (CSRF + Origin), a real Better Auth
 * session cookie, the `current` tenant alias and the **in-process memory
 * provider** the e2e server selects by default (`APP_ENV=e2e`, no
 * `PAYMENT_PROVIDER`):
 *
 *   sign in → the first tenant-scoped write provisions the workspace →
 *   `POST /tenants/current/billing/checkout` answers `201` with an opaque
 *   hosted-mandate URL → `GET /tenants/current/subscription` shows an
 *   `incomplete` subscription.
 *
 * The subscription must stay `incomplete`: §3.3 is explicit that a landing on
 * the return URL is **not** proof of success and only a verified webhook may
 * move the state to `active`.
 *
 * ## Prerequisite this spec pins (stated in the handoff)
 *
 * The e2e database is empty, so the pricing catalogue must be provisioned at
 * boot — exactly as the notification catalogue already is
 * (`src/instrumentation.ts`, the `APP_ENV === "e2e"` branch, ADR-0131). Without
 * `seedPlans()` there on the e2e boot, the checkout of a self-serve tier has no
 * plan to resolve and answers `422`.
 *
 * The email is unique per run so the `auth.otp` limit never bleeds into a re-run
 * when `reuseExistingServer` keeps the e2e server alive.
 */

/** The literal alias the tenant stage resolves (contract §0.4). */
const CURRENT_PATH = "/api/v1/tenants/current";

/** The memory provider's hosted-mandate URL prefix (ADR-0383). */
const MEMORY_CHECKOUT_PREFIX = "https://memory.openpic.local/checkout/";

/** The CSRF pair every mutating e2e request carries. */
const CSRF_HEADERS = {
  origin: E2E_BASE_URL,
  "x-requested-with": "XMLHttpRequest",
};

/**
 * The sorted own keys of a JSON object value.
 *
 * §0.15 is a rule about **fields**, so the never-return check has to look at key
 * names: a `not.toMatch(/cashfree/i)` sweep over the serialised body is a rule
 * about *strings* — it would pass a `cf_subscription_id` leak, because neither
 * that key nor a realistic value contains the vendor name.
 */
function keysOf(value: unknown): string[] {
  return value !== null && typeof value === "object" ? Object.keys(value).sort() : [];
}

test.describe("POST /api/v1/tenants/current/billing/checkout", () => {
  test("E1: an owner checks out and the subscription read shows it as incomplete", async ({
    request,
  }) => {
    const email = `e2e-op107-${String(Date.now())}-${Math.random().toString(16).slice(2)}@example.com`;

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

    // The organizer action: the first tenant-scoped write provisions the
    // workspace, so `current` resolves for every later billing call.
    const provisioned = await request.patch(CURRENT_PATH, {
      headers: CSRF_HEADERS,
      data: { name: "E2E Billing Studio" },
    });
    expect(provisioned.status()).toBe(200);

    // Act — subscribe to the self-serve Starter tier.
    const checkout = await request.post(`${CURRENT_PATH}/billing/checkout`, {
      headers: { ...CSRF_HEADERS, "idempotency-key": randomUUID() },
      data: {
        planKey: "starter",
        priceKey: "starter-monthly-inr",
        returnUrl: `${E2E_BASE_URL}/billing/return`,
      },
    });

    // Assert — the §3.3 envelope, with the opaque hosted-mandate URL.
    expect(checkout.status()).toBe(201);
    const envelope = (await checkout.json()) as Record<string, unknown>;
    const checkoutView = envelope.checkout as
      { kind?: unknown; url?: unknown; expiresAt?: unknown } | undefined;
    expect(envelope.status).toBe("incomplete");
    expect(envelope.paymentMethodKind).toBe("mandate_upi");
    expect(typeof envelope.subscriptionId).toBe("string");
    expect(checkoutView?.kind).toBe("redirect");
    expect(typeof checkoutView?.url).toBe("string");
    expect(String(checkoutView?.url).startsWith(MEMORY_CHECKOUT_PREFIX)).toBe(true);
    expect(checkout.headers().location).toBe(checkoutView?.url);

    // No vendor field may reach the client (§3.3, §0.15). This is a rule about
    // **fields**, so the pin is the exact §0.5 key set of the bare single
    // resource at both levels — not a substring sweep that a `cf_subscription_id`
    // key (or any other vendor-side id) would slip through.
    expect(keysOf(envelope)).toEqual([
      "amountMinor",
      "checkout",
      "currency",
      "paymentMethodKind",
      "status",
      "subscriptionId",
    ]);
    expect(keysOf(envelope.checkout)).toEqual(["expiresAt", "kind", "url"]);

    // The state is `incomplete` and stays there: only a verified webhook may
    // move it to `active`.
    const subscription = await request.get(`${CURRENT_PATH}/subscription`);
    expect(subscription.status()).toBe(200);
    const view = (await subscription.json()) as {
      exists?: unknown;
      status?: unknown;
      activePlanKey?: unknown;
    };
    expect(view.exists).toBe(true);
    expect(view.status).toBe("incomplete");
    expect(view.activePlanKey).toBe("starter");
  });
});
