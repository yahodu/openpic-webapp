import type { AttendeePrincipal, UserPrincipal } from "@/server/auth/guards";

/**
 * Factories for the auth-guard principal fixtures (OP-86).
 *
 * These are the typed inputs the pure `evaluateAuth` decision table is driven
 * with. They exist so a spec states only the field it cares about and every
 * other field stays a documented, valid default — the same shape the real
 * `resolvePrincipal` must produce from a Better Auth session plus a
 * `userProfiles` document (schema §13.1/§13.2).
 *
 * The defaults describe the *most permissive* valid principal: an active,
 * fully-complete client with no ban — so a spec that grants a denial is
 * provably denying for the one field it overrode.
 */

let principalSeq = 0;

/** A stable "email and phone verified" completion instant (deterministic). */
export const VERIFIED_AT = new Date("2026-01-01T00:00:00.000Z");

/**
 * Build a `UserPrincipal` with every field defaulted to the permissive case.
 *
 * @param overrides - The fields this fixture pins.
 * @returns A fully-populated user principal.
 */
export function makeUserPrincipal(overrides: Partial<UserPrincipal> = {}): UserPrincipal {
  principalSeq += 1;
  const serial = String(principalSeq).padStart(4, "0");
  return {
    kind: "user",
    userId: `usr_${serial}`,
    status: "active",
    platformRole: "client",
    accountCompletedAt: VERIFIED_AT,
    emailVerified: true,
    phoneNumberVerified: true,
    twoFactorEnabled: false,
    sessionTwoFactorVerified: false,
    banned: false,
    banReason: null,
    banExpires: null,
    ...overrides,
  };
}

/**
 * Build an `AttendeePrincipal` (an anonymous attendee session).
 *
 * @param overrides - The fields this fixture pins.
 * @returns A fully-populated attendee principal.
 */
export function makeAttendeePrincipal(
  overrides: Partial<AttendeePrincipal> = {}
): AttendeePrincipal {
  principalSeq += 1;
  const serial = String(principalSeq).padStart(4, "0");
  return {
    kind: "attendee",
    sessionId: `att_${serial}`,
    eventId: null,
    ...overrides,
  };
}
