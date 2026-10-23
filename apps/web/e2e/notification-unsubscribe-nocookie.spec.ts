import { expect, test } from "@playwright/test";

import { E2E_BASE_URL } from "./ports";
import { mintE2eUnsubscribeToken } from "./unsubscribe-token";

/**
 * E2 — the one-click unsubscribe as a mail client sends it: a **cookie-less**
 * public `POST` through the real `next start` middleware (OP-99 review finding
 * F4; contract §7.5; design §19.6; ADR-0240).
 *
 * E1 exercises the same endpoint through Playwright's `request` fixture, whose
 * jar carries the sign-in session cookie, and the spec pairs that with `origin`
 * / `x-requested-with`. An RFC-8058 one-click unsubscribe has none of that: the
 * mail client posts to the token URL with **no** session cookie and no CSRF
 * headers. `decideCsrf` exempts a request that carries no session cookie
 * (`apps/web/src/server/security/csrf.ts`) — but the integration suite drives the
 * route handler directly and so never passes the middleware, and E1 sends a
 * cookie. This is the only case that proves the cookie-less `POST` survives the
 * real edge gate; a regression in that exemption would leave every other OP-99
 * suite green.
 *
 * E1 is left byte-unchanged.
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

test.describe("cookie-less one-click unsubscribe (E2)", () => {
  test("E2: a cookie-less public POST applies the unsubscribe through the real middleware", async ({
    request,
    playwright,
  }) => {
    const email = `e2e-op99-nocookie-${String(Date.now())}-${Math.random().toString(16).slice(2)}@example.com`;

    // Sign in through the real email-OTP handshake (as E1 does).
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

    // The first type whose email channel the user is allowed to mute.
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

    // A brand-new request context carries no cookies: no session cookie, and no
    // `x-requested-with` — exactly the ambient authority an RFC-8058 one-click
    // mail-client POST withholds.
    const anon = await playwright.request.newContext({ baseURL: E2E_BASE_URL });
    try {
      const applied = await anon.post(`/api/v1/notifications/unsubscribe/${token}`);

      expect(applied.status()).toBe(200);
      const appliedBody = (await applied.json()) as UnsubscribeBody;
      expect(appliedBody.applied).toBe(true);
      expect(appliedBody.scope).toBe("type");
      expect(appliedBody.typeKey).toBe(typeKey);
      expect(appliedBody.mutedTypeKeys).toEqual([typeKey]);
    } finally {
      await anon.dispose();
    }

    // The mute landed: re-read with the session cookie and the target type
    // resolves `off` as a type-scoped override.
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
