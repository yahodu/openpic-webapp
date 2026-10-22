import { createHmac } from "node:crypto";

/**
 * E2E unsubscribe-token minting (OP-99, contract §7.5; ADR-0240).
 *
 * The unsubscribe endpoints are **public** and take the token as their only
 * credential, so the e2e suite has to mint one. Rather than expose a test-only
 * mint route in the app (a "mute any user" primitive), the e2e server is booted
 * with this fixed test secret (`playwright.config.ts` passes it as
 * `UNSUBSCRIBE_SIGNING_SECRET`, and `e2e/start-server.mjs` only generates a
 * throwaway when none is supplied), and this helper produces a token in the
 * documented shape: `base64url(payload).hmacSha256Hex(payload)` with
 * `payload = { userId, scope, typeKey?, exp }`.
 *
 * Nothing here is a credential: the value is a per-run test fixture, exactly
 * like the throwaway secrets the launcher already generates. The token format is
 * pinned independently by the unit suite (`unsubscribe.test.ts`, U1–U3), so a
 * change in format fails there first; this helper mirrors the same contract.
 */

/** The fixed signing secret the `api` project's server is booted with. */
export const E2E_UNSUBSCRIBE_SIGNING_SECRET = "e2e-unsubscribe-signing-secret-0123456789abcd";

/** The contract's 90-day token lifetime (contract §7.5). */
export const E2E_UNSUBSCRIBE_TTL_SECONDS = 90 * 24 * 60 * 60;

/** The scope a token may carry (contract §7.5). */
export type E2eUnsubscribeScope = "type" | "marketing" | "all";

/** A token payload as the e2e helper mints it. */
export interface E2eUnsubscribeTokenPayload {
  readonly userId: string;
  readonly scope: E2eUnsubscribeScope;
  readonly typeKey?: string;
}

/**
 * Mint an unsubscribe token for the e2e server's signing secret.
 *
 * @param payload - The signed payload (the `exp` claim is added here).
 * @param now - The minting instant; defaults to the wall clock.
 * @returns The `base64url(payload).signature` token.
 */
export function mintE2eUnsubscribeToken(
  payload: E2eUnsubscribeTokenPayload,
  now: Date = new Date()
): string {
  const body = Buffer.from(
    JSON.stringify({
      userId: payload.userId,
      scope: payload.scope,
      ...(payload.typeKey === undefined ? {} : { typeKey: payload.typeKey }),
      exp: Math.floor(now.getTime() / 1000) + E2E_UNSUBSCRIBE_TTL_SECONDS,
    }),
    "utf8"
  ).toString("base64url");

  const signature = createHmac("sha256", E2E_UNSUBSCRIBE_SIGNING_SECRET)
    .update(body, "utf8")
    .digest("hex");

  return `${body}.${signature}`;
}
