import { expect, test } from "@playwright/test";

import { E2E_BASE_URL } from "./ports";
import { mintE2eUnsubscribeToken } from "./unsubscribe-token";

/**
 * E1 — the one-click unsubscribe journey over the deployed HTTP surface (OP-99,
 * contract §7.5; design §19.6; ADR-0240).
 *
 * The integration suite drives the route handlers in-process with a hand-seeded
 * session. This spec proves the same journey end to end, through a real
 * `next start` server:
 *
 *   1. a recipient signs in through the real email-OTP handshake;
 *   2. the settings screen is read through `GET /api/v1/me/notification-preferences`
 *      and yields the first type the user is allowed to mute by email;
 *   3. a footer token is minted for that type (the e2e test secret);
 *   4. `GET /api/v1/notifications/unsubscribe/{token}` previews the mute and
 *      writes nothing;
 *   5. `POST` (public: no session cookie, as a mail client sends it) applies it;
 *   6. the settings screen now resolves that type's email channel `off`.
 *
 * ## What this spec deliberately does not assert
 *
 * The transport-side `List-Unsubscribe` / `List-Unsubscribe-Post` header
 * emission (design §19.6) — the footer's token is minted by the e2e helper
 * instead, because the challenge here is the public endpoint, not the mail
 * adapter (a later story).
 */

/** One resolved channel group as the settings read serves it (contract §7.4). */
interface ResolvedChannel {
  readonly effective: "on" | "off";
  readonly optOutAllowed: boolean;
  readonly source: string;
}

/** The settings read body (the fields this spec consumes). */
interface PreferencesBody {
  readonly resolved: {
    readonly types: {
      readonly typeKey: string;
      readonly channels: Record<string, ResolvedChannel>;
    }[];
  }[];
}

/** The unsubscribe response body (contract §7.5). */
interface UnsubscribeBody {
  readonly applied: boolean;
  readonly scope: string;
  readonly typeKey?: string;
  readonly mutedTypeKeys: string[];
  readonly stillReceiving: string[];
  readonly managePreferencesUrl: string;
}

test.describe("one-click unsubscribe (E1)", () => {
  test("E1: preview then apply a type-scoped unsubscribe through the API", async ({ request }) => {
    const email = `e2e-op99-${String(Date.now())}-${Math.random().toString(16).slice(2)}@example.com`;

    // Sign in through the real email-OTP handshake.
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
    const sessionCookie = (signedIn.headers()["set-cookie"] ?? "").split(";")[0] ?? "";
    expect(sessionCookie).toContain("better-auth.session_token=");

    const me = await request.get("/api/v1/me", { headers: { cookie: sessionCookie } });
    expect(me.status()).toBe(200);
    const { id } = (await me.json()) as { id: string };
    expect(id).toMatch(/^[0-9a-f]{24}$/);

    // The settings screen: the first type whose email channel can be muted.
    const preferences = await request.get("/api/v1/me/notification-preferences", {
      headers: { cookie: sessionCookie },
    });
    expect(preferences.status()).toBe(200);
    const settings = (await preferences.json()) as PreferencesBody;
    const optOutable = settings.resolved
      .flatMap((category) => category.types)
      .find((type) => type.channels.email?.optOutAllowed === true);
    expect(optOutable).toBeDefined();
    const typeKey = optOutable?.typeKey ?? "";

    const token = mintE2eUnsubscribeToken({ userId: id, scope: "type", typeKey });

    // Preview: nothing is muted yet.
    const preview = await request.get(`/api/v1/notifications/unsubscribe/${token}`);
    expect(preview.status()).toBe(200);
    const previewBody = (await preview.json()) as UnsubscribeBody;
    expect(previewBody.applied).toBe(false);
    expect(previewBody.scope).toBe("type");
    expect(previewBody.typeKey).toBe(typeKey);
    expect(previewBody.mutedTypeKeys).toEqual([typeKey]);
    expect(previewBody.managePreferencesUrl).toBe(`${E2E_BASE_URL}/settings/notifications`);

    const afterPreview = await request.get("/api/v1/me/notification-preferences", {
      headers: { cookie: sessionCookie },
    });
    const previewSettings = (await afterPreview.json()) as PreferencesBody;
    const previewChannel = previewSettings.resolved
      .flatMap((category) => category.types)
      .find((type) => type.typeKey === typeKey)?.channels.email;
    expect(previewChannel?.effective).toBe("on");

    // Apply: the public POST. Playwright's jar carries the session cookie the
    // sign-in above set, so the browser-profile CSRF headers are supplied; the
    // integration suite pins that the endpoint works with **no** cookie at all
    // (route invoked directly), which is how a mail client calls it.
    const applied = await request.post(`/api/v1/notifications/unsubscribe/${token}`, {
      headers: { origin: E2E_BASE_URL, "x-requested-with": "XMLHttpRequest" },
    });
    expect(applied.status()).toBe(200);
    const appliedBody = (await applied.json()) as UnsubscribeBody;
    expect(appliedBody.applied).toBe(true);
    expect(appliedBody.scope).toBe("type");
    expect(appliedBody.mutedTypeKeys).toEqual([typeKey]);
    expect(appliedBody.stillReceiving.length).toBeGreaterThan(0);

    // The settings screen now resolves the muted channel as an off override.
    const afterApply = await request.get("/api/v1/me/notification-preferences", {
      headers: { cookie: sessionCookie },
    });
    expect(afterApply.status()).toBe(200);
    const appliedSettings = (await afterApply.json()) as PreferencesBody;
    const appliedChannel = appliedSettings.resolved
      .flatMap((category) => category.types)
      .find((type) => type.typeKey === typeKey)?.channels.email;
    expect(appliedChannel).toEqual({ effective: "off", optOutAllowed: true, source: "type" });
  });
});
