/**
 * Capability derivation for `GET /me` (OP-90, contract §1.2, §0.14).
 *
 * `capabilities` is the **advisory** projection the shell paints before any
 * tenant-scoped call. It is a pure function of the caller's platform role,
 * account status and **active** tenant memberships, so a suspended or
 * deletion-pending account can never be advertised a capability the write guard
 * would deny, and the body can never drift from the memberships it was read
 * with.
 *
 * The `tenants` input is the active-only membership list the route already
 * built from `tenantMembers` (`status == "active"`); this function deliberately
 * does not re-filter by membership status.
 */

/** A workspace role, distinct from the event-level role (§13.4). */
export type CapabilityTenantRole = "owner" | "admin" | "member";

/** One active membership the route passes in. */
export interface CapabilityTenant {
  readonly role: CapabilityTenantRole;
}

/** The account status the projection branches on (§13.2). */
export type AccountStatus = "active" | "suspended" | "deletion_pending" | "deleted";

/** The platform role (§13.2). */
export type PlatformRole = "client" | "admin";

/** Inputs to {@link deriveCapabilities}. */
export interface CapabilityInput {
  readonly platformRole: PlatformRole;
  readonly status: AccountStatus;
  readonly tenants: readonly CapabilityTenant[];
}

/** The advisory capability projection (§1.2). */
export interface Capabilities {
  readonly canCreateEvent: boolean;
  readonly canPurchase: boolean;
  readonly isAdmin: boolean;
}

/** True when any active membership carries one of `roles`. */
function hasRole(
  tenants: readonly CapabilityTenant[],
  ...roles: readonly CapabilityTenantRole[]
): boolean {
  return tenants.some((tenant) => roles.includes(tenant.role));
}

/**
 * Derive the advisory capability projection.
 *
 * @param input - Platform role, account status and the active-only memberships.
 * @returns The `{ canCreateEvent, canPurchase, isAdmin }` projection.
 */
export function deriveCapabilities(input: CapabilityInput): Capabilities {
  const active = input.status === "active";

  return {
    canCreateEvent: active && hasRole(input.tenants, "owner", "admin"),
    canPurchase: active && hasRole(input.tenants, "owner"),
    isAdmin: active && input.platformRole === "admin",
  };
}
