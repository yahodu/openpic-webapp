import { createHash, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { clientIpFor } from "./client-ip";
import { E2E_BASE_URL } from "./ports";

const CLIENT_IP = clientIpFor("uploads-single-put.spec.ts");

/**
 * E1 — the single-PUT upload journey through the deployed HTTP surface (OP-124,
 * contract §5.1 / §5.3 / §4.x; ADR-0720).
 *
 * The integration suite drives the three route handlers in-process; this spec
 * proves the same journey end to end against a real `next start` server, the
 * middleware, a real Better Auth session and the **memory** storage adapter:
 *
 *   sign up (email OTP + a verified phone, so `user:complete` passes) →
 *   `POST /tenants/current/events` → `POST …/uploads/params` (the presigned PUT)
 *   → **PUT the bytes straight to the storage URL** → `POST …/complete` →
 *   `GET …/events/{eventId}/images` lists the image.
 *
 * The bytes never transit the control plane: the spec puts them at the object
 * store's own URL, exactly as Uppy's `@uppy/aws-s3` plugin does. In the e2e
 * boot `STORAGE_PROVIDER` is the in-memory adapter, so its presigned URL points
 * at the test-only storage route on the same origin, and the store mints the
 * `ETag` the completion echoes.
 *
 * ## What this spec pins about the presigned envelope
 *
 * - The `params` answer is exactly `{ uploadSessionId, method, url, headers,
 *   expiresAt, completeUrl }` — no bucket, object key or location field
 *   (§0.15). The URL is opaque: it must not spell the content hash out, so a
 *   client cannot forge or read the object's coordinates.
 * - The PUT answers an `ETag`, like S3 does, because the client sends it back
 *   on completion.
 * - `GET …/images` is the client's proof the gallery sees the upload: one item
 *   whose `id` is the completion's `eventImageId`, `sequence: 1` and
 *   `processing.status: "queued"`.
 */

/** A minimal but real JPEG: SOI, an APP0 JFIF header, then EOI. */
const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

/** The content hash the client computes (the upload's identity, §5.1). */
const CONTENT_HASH = createHash("sha256").update(JPEG_BYTES).digest("hex");

/** The `complete` body's `etag` placeholder is read from the PUT response. */
test.describe("single-PUT upload over the real HTTP surface", () => {
  test("E1: params → PUT to the storage URL → complete → the gallery lists it", async ({
    request,
  }) => {
    const stamp = randomUUID();
    const email = `e2e-op124-${stamp}@example.com`;
    const phone = `+91${String(700000000 + (parseInt(stamp.replace(/-/g, "").slice(0, 9), 16) % 200000000))}`;
    const origin = E2E_BASE_URL;
    const mutating = {
      origin,
      "x-requested-with": "XMLHttpRequest",
      "idempotency-key": randomUUID(),
    };

    // 1. Sign up with the email OTP handshake.
    const sent = await request.post("/api/auth/email-otp/send-verification-otp", {
      headers: { origin, "x-forwarded-for": CLIENT_IP },
      data: { email, type: "sign-in" },
    });
    expect(sent.status()).toBe(200);

    const emailOtp = await request.get(
      `/api/v1/__test__/otp?contact=${encodeURIComponent(email)}&channel=email`
    );
    expect(emailOtp.status()).toBe(200);
    const emailCode = ((await emailOtp.json()) as { code: string | null }).code;
    expect(typeof emailCode).toBe("string");

    const signedIn = await request.post("/api/auth/sign-in/email-otp", {
      headers: { origin },
      data: { email, otp: emailCode },
    });
    expect(signedIn.status()).toBe(200);

    // 2. Complete the account (`user:complete` is the create route's guard).
    const phoneSent = await request.post("/api/auth/phone-number/send-otp", {
      headers: { origin, "x-forwarded-for": CLIENT_IP },
      data: { phoneNumber: phone },
    });
    expect(phoneSent.status()).toBe(200);

    const phoneOtp = await request.get(
      `/api/v1/__test__/otp?contact=${encodeURIComponent(phone)}&channel=sms`
    );
    expect(phoneOtp.status()).toBe(200);
    const phoneCode = ((await phoneOtp.json()) as { code: string | null }).code;
    expect(typeof phoneCode).toBe("string");

    const phoneVerified = await request.post("/api/auth/phone-number/verify", {
      headers: { origin },
      data: { phoneNumber: phone, code: phoneCode },
    });
    expect(phoneVerified.status()).toBe(200);

    // 3. An event to upload into (this call also provisions the workspace).
    const now = Date.now();
    const created = await request.post("/api/v1/tenants/current/events", {
      headers: mutating,
      data: {
        name: "E2E Upload Wedding",
        description: "Single-PUT journey",
        startAt: new Date(now + 2 * 86_400_000).toISOString(),
        endAt: new Date(now + 3 * 86_400_000).toISOString(),
        displayTimeZone: "Asia/Kolkata",
        logoAssetId: null,
        watermarkAssetId: null,
        publish: true,
      },
    });
    expect(created.status()).toBe(201);
    const tenantId = created.headers()["x-tenant-id"];
    const eventId = ((await created.json()) as { id?: string }).id;
    expect(typeof tenantId).toBe("string");
    expect(typeof eventId).toBe("string");
    if (typeof tenantId !== "string" || typeof eventId !== "string") {
      throw new Error("expected the tenant and event ids");
    }
    const uploadBase = `/api/v1/tenants/${tenantId}/events/${eventId}/uploads`;

    // 4. The single-PUT presign.
    const batchId = randomUUID();
    const params = await request.post(`${uploadBase}/params`, {
      headers: mutating,
      data: {
        batchId,
        hash: CONTENT_HASH,
        size: JPEG_BYTES.byteLength,
        fileName: "DSC_0421.JPG",
        mimeType: "image/jpeg",
      },
    });
    expect(params.status()).toBe(201);
    const presigned = (await params.json()) as {
      uploadSessionId: string;
      method: string;
      url: string;
      headers: Record<string, string>;
      expiresAt: string;
      completeUrl: string;
    };
    expect(Object.keys(presigned).sort()).toEqual([
      "completeUrl",
      "expiresAt",
      "headers",
      "method",
      "uploadSessionId",
      "url",
    ]);
    expect(presigned.method).toBe("PUT");
    expect(presigned.completeUrl).toBe(`${uploadBase}/${presigned.uploadSessionId}/complete`);
    // §0.15 — the URL is opaque: no content hash, no location name in it.
    expect(presigned.url).not.toContain(CONTENT_HASH);
    expect(presigned.url).not.toContain("images/");

    // 5. The bytes go straight to storage — never through the control plane.
    const put = await request.put(presigned.url, {
      headers: { ...presigned.headers, origin, "x-requested-with": "XMLHttpRequest" },
      data: JPEG_BYTES,
    });
    expect([200, 204]).toContain(put.status());
    const etag = put.headers().etag;
    expect(typeof etag).toBe("string");
    expect(etag ?? "").not.toBe("");

    // 6. The completion registers the asset, the image and the counters.
    const completed = await request.post(presigned.completeUrl, {
      headers: { ...mutating, "idempotency-key": randomUUID() },
      data: { etag, bytes: JPEG_BYTES.byteLength },
    });
    expect(completed.status()).toBe(201);
    const image = (await completed.json()) as {
      id: string;
      assetId: string;
      sequence: number;
      bytes: number;
      contentType: string;
      processing: { status: string };
    };
    expect(typeof image.id).toBe("string");
    expect(typeof image.assetId).toBe("string");
    expect(image.sequence).toBe(1);
    expect(image.bytes).toBe(JPEG_BYTES.byteLength);
    expect(image.contentType).toBe("image/jpeg");
    expect(image.processing.status).toBe("queued");

    // 7. The gallery lists the upload — the user-visible end of the journey.
    const listed = await request.get(`/api/v1/tenants/${tenantId}/events/${eventId}/images`, {
      headers: { origin },
    });
    expect(listed.status()).toBe(200);
    const page = (await listed.json()) as {
      data?: readonly { id?: string; sequence?: number; processing?: { status?: string } }[];
      summary?: { total?: number };
    };
    const items = page.data ?? [];
    expect(items.map((item) => item.id)).toContain(image.id);
    const listedImage = items.find((item) => item.id === image.id);
    expect(listedImage?.sequence).toBe(1);
    expect(listedImage?.processing?.status).toBe("queued");
    expect(page.summary?.total).toBe(1);
  });
});
