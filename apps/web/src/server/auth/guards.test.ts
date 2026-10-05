import { describe, expect, it } from "vitest";

import {
  evaluateAuth,
  type AuthDenyCode,
  type GuardLabel,
  type GuardFacts,
} from "@/server/auth/guards";
import { makeAttendeePrincipal, makeUserPrincipal } from "@/test/factories/auth";

/**
 * Unit — the pure auth-guard decision table (OP-86, contract §0.3).
 *
 * `evaluateAuth(label, facts)` is the single, side-effect-free function every
 * auth label funnels through: the pipeline stage (`requireAuth`) resolves a
 * principal, then asks this function whether that principal satisfies the
 * label. Keeping the policy pure is what makes "one guard per auth label" a
 * data question a reviewer can read off a table rather than untangle from HTTP
 * plumbing.
 *
 * Observable contract pinned here:
 *
 *   - `public`          always allows (no credential).
 *   - `user`            requires a `user` principal whose profile is `active`.
 *   - `user:complete`   additionally requires `accountCompletedAt != null`.
 *   - `attendee`        accepts a `user` principal **or** an `attendee` one.
 *   - `admin`           requires `platformRole == "admin"` **and** this session
 *                       passed the second factor.
 *
 * A denial is `{ allowed: false, code, details? }` where `code` is the stable
 * client-facing code (contract Appendix A.1) the transport turns into the
 * matching HTTP status. `evaluateAuth` never throws and never touches the
 * network, a clock or a database — `facts.now` is injected so a ban-expiry
 * boundary is exact.
 */

const NOW = new Date("2026-06-01T00:00:00.000Z");

/** The future/past boundaries the ban tests pivot on. */
const FUTURE = new Date("2026-09-01T00:00:00.000Z");
const PAST = new Date("2026-01-01T00:00:00.000Z");

/** Build the facts for a principal at `NOW`, unless a spec overrides them. */
function facts(
  principal: GuardFacts["principal"],
  overrides: Partial<GuardFacts> = {}
): GuardFacts {
  return { principal, now: NOW, ...overrides };
}

interface AllowCase {
  readonly name: string;
  readonly label: GuardLabel;
  readonly principal: GuardFacts["principal"];
  readonly overrides?: Partial<GuardFacts>;
}

/**
 * U1 — labels that must allow. Each row is a principal fixture × label pair;
 * the name reads as a sentence so a failure says exactly which pair regressed.
 */
describe("U1: label decision table — allow", () => {
  const cases: readonly AllowCase[] = [
    {
      name: "public allows an unauthenticated request",
      label: "public",
      principal: null,
    },
    {
      name: "public allows an authenticated request",
      label: "public",
      principal: makeUserPrincipal(),
    },
    {
      name: "user allows an active, complete user",
      label: "user",
      principal: makeUserPrincipal(),
    },
    {
      name: "user allows an active user whose profile is not complete",
      label: "user",
      // `user` (unlike `user:complete`) does not gate on completion.
      principal: makeUserPrincipal({ accountCompletedAt: null, phoneNumberVerified: false }),
    },
    {
      name: "user:complete allows an active, complete user",
      label: "user:complete",
      principal: makeUserPrincipal(),
    },
    {
      name: "attendee allows a user principal",
      label: "attendee",
      principal: makeUserPrincipal(),
    },
    {
      name: "attendee allows an attendee principal",
      label: "attendee",
      principal: makeAttendeePrincipal(),
    },
    {
      name: "admin allows an admin whose session passed the second factor",
      label: "admin",
      principal: makeUserPrincipal({
        platformRole: "admin",
        twoFactorEnabled: true,
        sessionTwoFactorVerified: true,
      }),
    },
  ];

  it.each(cases)("$name", ({ label, principal, overrides }) => {
    expect(evaluateAuth(label, facts(principal, overrides)).allowed).toBe(true);
  });
});

interface DenyCase {
  readonly name: string;
  readonly label: GuardLabel;
  readonly principal: GuardFacts["principal"];
  readonly code: AuthDenyCode;
  readonly overrides?: Partial<GuardFacts>;
}

/** U1 — labels that must deny, and the exact code they deny with. */
describe("U1: label decision table — deny", () => {
  const cases: readonly DenyCase[] = [
    {
      name: "user denies an unauthenticated request",
      label: "user",
      principal: null,
      code: "authentication_required",
    },
    {
      name: "user denies an attendee session",
      label: "user",
      principal: makeAttendeePrincipal(),
      code: "authentication_required",
    },
    {
      name: "user:complete denies an unauthenticated request",
      label: "user:complete",
      principal: null,
      code: "authentication_required",
    },
    {
      name: "user denies a suspended profile",
      label: "user",
      principal: makeUserPrincipal({ status: "suspended" }),
      code: "account_suspended",
    },
    {
      name: "user denies a deletion-pending profile",
      label: "user",
      principal: makeUserPrincipal({ status: "deletion_pending" }),
      code: "forbidden",
    },
    {
      name: "user denies a deleted profile",
      label: "user",
      principal: makeUserPrincipal({ status: "deleted" }),
      code: "forbidden",
    },
    {
      name: "user:complete denies an active but incomplete account",
      label: "user:complete",
      principal: makeUserPrincipal({ accountCompletedAt: null, phoneNumberVerified: false }),
      code: "account_incomplete",
    },
    {
      name: "attendee denies an unauthenticated request",
      label: "attendee",
      principal: null,
      code: "authentication_required",
    },
    {
      name: "admin denies an unauthenticated request",
      label: "admin",
      principal: null,
      code: "authentication_required",
    },
    {
      name: "admin denies a non-admin user",
      label: "admin",
      principal: makeUserPrincipal({ platformRole: "client", twoFactorEnabled: true }),
      code: "forbidden",
    },
    {
      name: "admin denies an admin without 2FA enabled",
      label: "admin",
      principal: makeUserPrincipal({ platformRole: "admin", twoFactorEnabled: false }),
      code: "admin_2fa_required",
    },
    {
      name: "admin denies an admin whose flag is on but whose session never passed the second factor",
      label: "admin",
      principal: makeUserPrincipal({
        platformRole: "admin",
        twoFactorEnabled: true,
        sessionTwoFactorVerified: false,
      }),
      code: "admin_2fa_required",
    },
    {
      name: "admin denies a suspended admin before considering 2FA",
      label: "admin",
      principal: makeUserPrincipal({
        platformRole: "admin",
        twoFactorEnabled: true,
        sessionTwoFactorVerified: true,
        status: "suspended",
      }),
      code: "account_suspended",
    },
  ];

  it.each(cases)("$name with $code", ({ label, principal, code, overrides }) => {
    expect(evaluateAuth(label, facts(principal, overrides))).toMatchObject({
      allowed: false,
      code,
    });
  });
});

/**
 * U2 — ban expiry. `user.banned` is only meaningful for an unexpired ban;
 * `banExpires == null` is a permanent ban. A route flagged `allowBanned`
 * (`GET /me`, `POST /me/data-requests`) ignores the ban entirely.
 */
describe("U2: ban expiry", () => {
  it("denies a banned user whose ban has not yet expired", () => {
    const decision = evaluateAuth(
      "user",
      facts(
        makeUserPrincipal({
          banned: true,
          banReason: "spam",
          banExpires: FUTURE,
        })
      )
    );

    expect(decision).toMatchObject({
      allowed: false,
      code: "account_banned",
      details: { banReason: "spam", banExpires: FUTURE.toISOString() },
    });
  });

  it("denies a banned user with no expiry (permanent ban)", () => {
    const decision = evaluateAuth(
      "user",
      facts(makeUserPrincipal({ banned: true, banReason: "abuse", banExpires: null }))
    );

    expect(decision).toMatchObject({ allowed: false, code: "account_banned" });
  });

  it("treats a ban whose expiry is in the past as not banned", () => {
    const decision = evaluateAuth(
      "user",
      facts(makeUserPrincipal({ banned: true, banReason: "expired", banExpires: PAST }))
    );

    expect(decision.allowed).toBe(true);
  });

  it("treats a ban expiring exactly at `now` as expired", () => {
    // The boundary is inclusive: at the expiry instant the ban is over.
    const decision = evaluateAuth(
      "user",
      facts(makeUserPrincipal({ banned: true, banReason: "boundary", banExpires: NOW }))
    );

    expect(decision.allowed).toBe(true);
  });

  it("allows a banned user on a route exempted from the ban rule", () => {
    const decision = evaluateAuth(
      "user",
      facts(makeUserPrincipal({ banned: true, banReason: "spam", banExpires: FUTURE }), {
        allowBanned: true,
      })
    );

    expect(decision.allowed).toBe(true);
  });
});

/**
 * U3 — `account_incomplete` details. `missing` names exactly the unverified
 * contact(s), computed from the verification flags, so a client can route the
 * user straight at the step that is actually outstanding (email vs phone).
 */
describe("U3: account_incomplete details", () => {
  it("names both fields when neither email nor phone is verified", () => {
    const decision = evaluateAuth(
      "user:complete",
      facts(
        makeUserPrincipal({
          accountCompletedAt: null,
          emailVerified: false,
          phoneNumberVerified: false,
        })
      )
    );

    expect(decision).toMatchObject({
      allowed: false,
      code: "account_incomplete",
      details: { missing: ["emailVerified", "phoneNumberVerified"] },
    });
  });

  it("names only phoneNumberVerified when the email is verified", () => {
    const decision = evaluateAuth(
      "user:complete",
      facts(
        makeUserPrincipal({
          accountCompletedAt: null,
          emailVerified: true,
          phoneNumberVerified: false,
        })
      )
    );

    expect(decision).toMatchObject({
      allowed: false,
      code: "account_incomplete",
      details: { missing: ["phoneNumberVerified"] },
    });
  });

  it("names only emailVerified when the phone is verified", () => {
    const decision = evaluateAuth(
      "user:complete",
      facts(
        makeUserPrincipal({
          accountCompletedAt: null,
          emailVerified: false,
          phoneNumberVerified: true,
        })
      )
    );

    expect(decision).toMatchObject({
      allowed: false,
      code: "account_incomplete",
      details: { missing: ["emailVerified"] },
    });
  });

  it("carries a verifyUrl pointing at the completion step", () => {
    const decision = evaluateAuth(
      "user:complete",
      facts(makeUserPrincipal({ accountCompletedAt: null, phoneNumberVerified: false }))
    );

    expect(decision.allowed).toBe(false);
    if (decision.allowed) {
      throw new Error("expected account_incomplete");
    }
    const details = decision.details as { verifyUrl?: unknown };
    expect(typeof details.verifyUrl).toBe("string");
    expect(String(details.verifyUrl)).toMatch(/^\//);
  });

  it("still denies when both contacts are verified but accountCompletedAt was never materialised", () => {
    // `accountCompletedAt` is the gate; a null value with both flags true is a
    // data-inconsistency edge and must still fail closed.
    const decision = evaluateAuth(
      "user:complete",
      facts(makeUserPrincipal({ accountCompletedAt: null }))
    );

    expect(decision).toMatchObject({
      allowed: false,
      code: "account_incomplete",
      details: { missing: [] },
    });
  });
});

/**
 * U4 — `account_suspended` details (Appendix A.1). A suspended profile denies
 * with `{ reason, supportUrl }` so the client can explain the block and offer a
 * route to support. The contract fixes the key names, not the values: the
 * schema (§13.2) carries no suspension-reason field, so GREEN owns a stable
 * machine reason. This pins that both keys exist and are non-empty strings.
 */
describe("U4: account_suspended details", () => {
  it("carries a reason and a supportUrl", () => {
    const decision = evaluateAuth("user", facts(makeUserPrincipal({ status: "suspended" })));

    expect(decision.allowed).toBe(false);
    if (decision.allowed) {
      throw new Error("expected account_suspended");
    }
    const details = decision.details as { reason?: unknown; supportUrl?: unknown };
    expect(typeof details.reason).toBe("string");
    expect(String(details.reason).length).toBeGreaterThan(0);
    expect(typeof details.supportUrl).toBe("string");
    expect(String(details.supportUrl).length).toBeGreaterThan(0);
  });
});

/**
 * U5 — `forbidden` details (Appendix A.1). When the `admin` label denies a
 * principal whose role is not `admin`, the denial names the role the route
 * required so the surface can route a client (e.g. hide the admin nav). The
 * status/deletion `forbidden` cases carry no role.
 */
describe("U5: forbidden details", () => {
  it("names `admin` as the requiredRole when the admin label denies a client", () => {
    const decision = evaluateAuth("admin", facts(makeUserPrincipal({ platformRole: "client" })));

    expect(decision).toMatchObject({
      allowed: false,
      code: "forbidden",
      details: { requiredRole: "admin" },
    });
  });
});
