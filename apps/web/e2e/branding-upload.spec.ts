import { expect, test } from "@playwright/test";

import { E2E_BASE_URL } from "./ports";

/**
 * E1 — branding asset upload through the deployed HTTP surface (OP-114, API
 * contract §2.1 — "the single byte-accepting endpoint").
 *
 * This spec proves the byte-accepting upload contract through a real `next
 * start` server: sign in with the email OTP flow, provision the workspace with
 * the first organizer write, then `POST /api/v1/tenants/{tenantId}/assets/branding`
 * a real PNG as `multipart/form-data` and read back
 * `201 { assetId, kind, url, bytes }` with a **signed** media URL
 * (`https://pic.openpic.in/t/<sha256>.png?exp=&sig=`).
 *
 * The e2e server mints a throwaway `MEDIA_SIGNING_SECRET_CURRENT` per boot, so
 * the signature is verified structurally (origin, `/t/` segment, 64-hex hash,
 * `exp`/`sig` query) rather than with the signing secret.
 */

/** A real 1×1 transparent PNG. */
const ONE_PX_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

test.describe("branding asset upload over the API", () => {
  test("E1: uploads a PNG via the API and gets a 201 with a signed URL", async ({ request }) => {
    const email = `e2e-op114-${String(Date.now())}-${Math.random().toString(16).slice(2)}@example.com`;
    const origin = E2E_BASE_URL;

    const sent = await request.post("/api/auth/email-otp/send-verification-otp", {
      headers: { origin },
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
      headers: { origin },
      data: { email, otp: code },
    });
    expect(signedIn.status()).toBe(200);

    // The first organizer write provisions the workspace.
    const provisioned = await request.patch("/api/v1/tenants/current", {
      headers: { origin, "x-requested-with": "XMLHttpRequest" },
      data: { name: "E2E Branding Studio" },
    });
    expect(provisioned.status()).toBe(200);
    const tenantId = provisioned.headers()["x-tenant-id"];
    expect(typeof tenantId).toBe("string");
    if (tenantId === undefined) {
      throw new Error("expected an x-tenant-id header");
    }

    const uploaded = await request.post(`/api/v1/tenants/${tenantId}/assets/branding`, {
      headers: { origin, "x-requested-with": "XMLHttpRequest" },
      multipart: {
        kind: "event_logo",
        file: { name: "logo.png", mimeType: "image/png", buffer: ONE_PX_PNG },
      },
    });
    expect(uploaded.status()).toBe(201);

    const created = (await uploaded.json()) as {
      assetId: string;
      kind: string;
      url: string;
      bytes: number;
    };
    expect(typeof created.assetId).toBe("string");
    expect(created.kind).toBe("event_logo");
    expect(created.bytes).toBe(ONE_PX_PNG.length);

    // The signed media URL: the /t/ derivative of the content-addressed key.
    const url = new URL(created.url);
    expect(url.origin).toBe("https://pic.openpic.in");
    expect(url.pathname).toMatch(/^\/t\/[0-9a-f]{64}\.png$/);
    expect(url.searchParams.get("exp")).toMatch(/^\d+$/);
    expect(url.searchParams.get("sig")).not.toBeNull();
  });
});
