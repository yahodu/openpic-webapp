import { describe, expect, it } from "vitest";

import { deriveCapabilities } from "./capabilities";

/**
 * Unit — capability derivation for `GET /me` (OP-90, contract §1.2).
 *
 * `capabilities` is the advisory projection the shell uses to decide what to
 * paint on first render, before any tenant-scoped call. It is derived from the
 * caller's platform role, account status and **active** tenant memberships:
 *
 *   isAdmin         platformRole === "admin" AND status === "active"
 *   canCreateEvent  status === "active" AND an active owner/admin membership
 *   canPurchase     status === "active" AND an active owner membership
 *
 * A non-active account grants nothing: even if the read route is reachable, the
 * projection must not claim a capability the write guard would deny.
 *
 * `tenants` is the active-only list the route already builds from
 * `tenantMembers` (`status == "active"`), so a removed membership is never
 * passed in and this pure function does not re-filter by membership status.
 *
 * Contract expected of the implementation:
 *
 *   @/server/me/capabilities exports deriveCapabilities(input): Capabilities
 *   input:  { platformRole: "client" | "admin";
 *             status: "active" | "suspended" | "deletion_pending" | "deleted";
 *             tenants: readonly { role: "owner" | "admin" | "member" }[] }
 *   output: { canCreateEvent: boolean; canPurchase: boolean; isAdmin: boolean }
 */

interface TenantRole {
  readonly role: "owner" | "admin" | "member";
}

/** Build the active-only membership list the route derives. */
function tenants(...roles: Array<TenantRole["role"]>): TenantRole[] {
  return roles.map((role) => ({ role }));
}

describe("deriveCapabilities (§1.2)", () => {
  it("U1: grants every capability to an active client who owns a tenant", () => {
    expect(
      deriveCapabilities({ platformRole: "client", status: "active", tenants: tenants("owner") })
    ).toEqual({ canCreateEvent: true, canPurchase: true, isAdmin: false });
  });

  it("U1: an active admin member can create events but cannot purchase", () => {
    expect(
      deriveCapabilities({ platformRole: "client", status: "active", tenants: tenants("admin") })
    ).toEqual({ canCreateEvent: true, canPurchase: false, isAdmin: false });
  });

  it("U1: a plain member can neither create events nor purchase", () => {
    expect(
      deriveCapabilities({ platformRole: "client", status: "active", tenants: tenants("member") })
    ).toEqual({ canCreateEvent: false, canPurchase: false, isAdmin: false });
  });

  it("U1: a pure attendee (no tenant) has no capabilities", () => {
    expect(deriveCapabilities({ platformRole: "client", status: "active", tenants: [] })).toEqual({
      canCreateEvent: false,
      canPurchase: false,
      isAdmin: false,
    });
  });

  it("U1: an active admin is isAdmin even without a tenant", () => {
    expect(deriveCapabilities({ platformRole: "admin", status: "active", tenants: [] })).toEqual({
      canCreateEvent: false,
      canPurchase: false,
      isAdmin: true,
    });
  });

  it("U1: a suspended owner loses every capability", () => {
    expect(
      deriveCapabilities({ platformRole: "admin", status: "suspended", tenants: tenants("owner") })
    ).toEqual({ canCreateEvent: false, canPurchase: false, isAdmin: false });
  });

  it("U1: a deletion-pending owner loses every capability", () => {
    expect(
      deriveCapabilities({
        platformRole: "client",
        status: "deletion_pending",
        tenants: tenants("owner"),
      })
    ).toEqual({ canCreateEvent: false, canPurchase: false, isAdmin: false });
  });
});
