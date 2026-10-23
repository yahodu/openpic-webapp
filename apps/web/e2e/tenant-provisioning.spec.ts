import { expect, test } from "@playwright/test";

import { E2E_BASE_URL } from "./ports";

/**
 * E1 — tenant provisioning through the deployed HTTP surface (OP-100, contract
 * §0.4 + §2.1).
 *
 * The integration suite drives the route handlers in-process; this spec proves
 * the same contract through a real `next start` server, the middleware (CSRF +
 * Origin), a real Better Auth session cookie and the `current` alias:
 *
 *   sign in → `GET /tenants/current` is `404` (the caller has no workspace) →
 *   the first tenant-scoped write provisions the workspace →
 *   `GET /tenants/current` returns the §2.1 DTO with `X-Tenant-Id` equal to the
 *   body id and the caller's `myRole: "owner"`.
 *
 * The email is unique per run so `auth.otp`'s limit never bleeds into a re-run
 * when `reuseExistingServer` keeps the e2e server alive.
 */

/** The literal alias the tenant stage must resolve (contract §0.4). */
const CURRENT_PATH = "/api/v1/tenants/current";

test.describe("tenant provisioning over the API", () => {
  test("E1: an organizer action provisions the workspace, then GET /tenants/current resolves it", async ({
    request,
  }) => {
    const email = `e2e-op100-${String(Date.now())}-${Math.random().toString(16).slice(2)}@example.com`;
    const workspaceName = "E2E Studio";

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

    // A brand-new account has no workspace: reading the alias must not create one.
    const before = await request.get(CURRENT_PATH);
    expect(before.status()).toBe(404);
    const beforeBody = (await before.json()) as { error?: { code?: string } };
    expect(beforeBody.error?.code).toBe("not_found");

    // The organizer action: the first tenant-scoped write (CSRF pair required).
    const written = await request.patch(CURRENT_PATH, {
      headers: {
        origin: E2E_BASE_URL,
        "x-requested-with": "XMLHttpRequest",
      },
      data: { name: workspaceName },
    });
    expect(written.status()).toBe(200);
    const writtenBody = (await written.json()) as Record<string, unknown>;
    expect(writtenBody.name).toBe(workspaceName);

    // The alias now resolves, and the resolved id is echoed on the wire.
    const after = await request.get(CURRENT_PATH);
    expect(after.status()).toBe(200);
    expect(typeof after.headers()["x-tenant-id"]).toBe("string");
    const resolved = (await after.json()) as Record<string, unknown>;
    expect(typeof resolved.id).toBe("string");
    expect(resolved.name).toBe(workspaceName);
    expect(resolved.myRole).toBe("owner");
    expect((resolved.counters as Record<string, unknown>).approximate).toBe(true);
    expect(after.headers()["x-tenant-id"]).toBe(resolved.id);

    // Persisted, and the same workspace — not a fresh one per request.
    const again = await request.get(CURRENT_PATH);
    expect(again.status()).toBe(200);
    const reflected = (await again.json()) as Record<string, unknown>;
    expect(reflected.id).toBe(resolved.id);
    expect(reflected.name).toBe(workspaceName);
  });
});
