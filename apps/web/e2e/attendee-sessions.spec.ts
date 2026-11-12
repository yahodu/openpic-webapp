import { expect, test } from "@playwright/test";

import { clientIpFor } from "./client-ip";
import { E2E_BASE_URL } from "./ports";

/**
 * E1 — an anonymous attendee session over the real deployed surface (OP-129,
 * contract §1.5, ADR-0780).
 *
 * The integration suite drives the two handlers in-process, so it never passes
 * the Next middleware and never exercises a real cookie jar. This spec proves
 * the browser-shaped journey end to end: `POST /api/v1/p/attendee-sessions`
 * creates a session and **sets** `op_att`, the client keeps it in its jar, and
 * a later `GET /api/v1/p/attendee-sessions/current` is authenticated **by that
 * cookie alone** — with no `X-Attendee-Session` header and no session cookie.
 *
 * The negative control is the point: a second, cookie-less request context asks
 * the same endpoint and must get `401`, so a server that answered `200` to any
 * caller would fail this spec.
 *
 * The spec does not sign in and does not read the database: everything it
 * asserts is what the attendee's browser can observe.
 */

const SESSIONS_PATH = "/api/v1/p/attendee-sessions";
const CURRENT_PATH = "/api/v1/p/attendee-sessions/current";

/** A private per-spec client address (see `e2e/client-ip.ts`). */
const CLIENT_IP = clientIpFor("attendee-sessions.spec.ts");

/** The §1.5 create body. */
interface CreatedSession {
  readonly sessionToken: string;
  readonly expiresAt: string;
  readonly issuedAt: string;
}

/** The §1.5 current body. */
interface CurrentSession {
  readonly id: string;
  readonly kind: string;
  readonly eventSlugs: readonly string[];
  readonly claimedByUserId: string | null;
  readonly expiresAt: string;
}

test.describe("anonymous attendee session", () => {
  test("E1: a created session's cookie authenticates GET .../current", async ({
    request,
    playwright,
  }) => {
    const created = await request.post(SESSIONS_PATH, {
      headers: {
        origin: E2E_BASE_URL,
        "x-requested-with": "XMLHttpRequest",
        "x-forwarded-for": CLIENT_IP,
      },
      data: {},
    });

    expect(created.status()).toBe(201);
    const session = (await created.json()) as CreatedSession;
    expect(Object.keys(session).sort()).toEqual(["expiresAt", "issuedAt", "sessionToken"]);
    expect(session.sessionToken).toMatch(/^opat_[A-Za-z0-9_-]{43}$/);

    const state = await request.storageState();
    const cookie = state.cookies.find((candidate) => candidate.name === "op_att");
    if (cookie === undefined) {
      throw new Error("the create response did not leave an op_att cookie in the client jar");
    }
    expect(cookie.value).toBe(session.sessionToken);
    expect(cookie.path).toBe("/");
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Lax");

    const current = await request.get(CURRENT_PATH, {
      headers: { "x-forwarded-for": CLIENT_IP },
    });
    expect(current.status()).toBe(200);

    const body = (await current.json()) as CurrentSession;
    expect(Object.keys(body).sort()).toEqual([
      "claimedByUserId",
      "eventSlugs",
      "expiresAt",
      "id",
      "kind",
    ]);
    expect(body.kind).toBe("anonymous");
    expect(body.eventSlugs).toEqual([]);
    expect(body.claimedByUserId).toBeNull();
    expect(body.expiresAt).toBe(session.expiresAt);
    // §0.15: the raw bearer token is served by its issuance response only.
    expect(JSON.stringify(body)).not.toContain(session.sessionToken);

    // Negative control: the same endpoint without the cookie is unauthenticated,
    // so the 200 above is attributable to the cookie and nothing else.
    const anonymous = await playwright.request.newContext({ baseURL: E2E_BASE_URL });
    try {
      const unauthenticated = await anonymous.get(CURRENT_PATH, {
        headers: { "x-forwarded-for": CLIENT_IP },
      });
      expect(unauthenticated.status()).toBe(401);
      const error = (await unauthenticated.json()) as { error: { code: string } };
      expect(error.error.code).toBe("authentication_required");
    } finally {
      await anonymous.dispose();
    }
  });
});
