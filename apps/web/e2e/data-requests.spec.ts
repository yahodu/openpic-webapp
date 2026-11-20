import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { clientIpFor } from "./client-ip";
import { E2E_BASE_URL } from "./ports";

const CLIENT_IP = clientIpFor("data-requests.spec.ts");

/**
 * E1 — file an erasure request and poll its status over the deployed HTTP
 * surface (OP-138, contract §8.1).
 *
 * The integration suite drives the route handlers directly. This spec proves
 * the same journey through a real `next start` server, middleware (CSRF and
 * rate limiting) and a real Better Auth session cookie:
 *
 *   sign in via email OTP → POST /me/data-requests (Idempotency-Key, no scope)
 *   answers `202` with a statutory deadline and a `pollUrl` → GET that
 *   `pollUrl` answers the same request with `status: "received"` and an empty
 *   execution log.
 *
 * The email is unique per run so `auth.otp`'s limit never bleeds into a re-run
 * when `reuseExistingServer` keeps the e2e server alive.
 */

/** The §8.1 answer a filed request carries. */
interface FiledRequest {
  readonly id: string;
  readonly requestType: string;
  readonly status: string;
  readonly slaDueAt: string;
  readonly acknowledgement: string;
  readonly pollUrl: string;
}

test.describe("data-subject requests over the API", () => {
  test("E1: a user files an erasure request and polls its status", async ({ request }) => {
    const email = `e2e-op138-${String(Date.now())}-${randomUUID().slice(0, 8)}@example.com`;

    // Sign in with a real email OTP session cookie.
    const sent = await request.post("/api/auth/email-otp/send-verification-otp", {
      headers: { origin: E2E_BASE_URL, "x-forwarded-for": CLIENT_IP },
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

    // File the erasure request. No scope means "all of my data, everywhere".
    const filed = await request.post("/api/v1/me/data-requests", {
      headers: {
        origin: E2E_BASE_URL,
        "x-requested-with": "XMLHttpRequest",
        "idempotency-key": randomUUID(),
      },
      data: { requestType: "erasure", regulation: "dpdpa" },
    });
    expect(filed.status()).toBe(202);

    const receipt = (await filed.json()) as FiledRequest;
    expect(receipt.status).toBe("received");
    expect(receipt.requestType).toBe("erasure");
    expect(receipt.pollUrl).toBe(`/api/v1/me/data-requests/${receipt.id}`);
    expect(Number.isNaN(Date.parse(receipt.slaDueAt))).toBe(false);
    expect(receipt.acknowledgement.length).toBeGreaterThan(0);

    // Poll the receipt the acknowledgement pointed at.
    const polled = await request.get(`/api/v1/me/data-requests/${receipt.id}`);
    expect(polled.status()).toBe(200);

    const polledBody = (await polled.json()) as Record<string, unknown>;
    expect(polledBody.id).toBe(receipt.id);
    expect(polledBody.requestType).toBe("erasure");
    expect(polledBody.status).toBe("received");
    expect(polledBody.slaDueAt).toBe(receipt.slaDueAt);
    expect(polledBody.executionLog).toEqual([]);
    expect(polledBody.export).toBeNull();
  });
});
