/**
 * Tenant role/permission map (OP-100, contract §2.1, schema §13.4).
 *
 * `PATCH /api/v1/tenants/{tenantId}` has five documented fields and the
 * contract splits them across two permission levels:
 *
 *   - `name`, `settings.defaultTimeZone`, `settings.brandLogoAssetId`,
 *     `settings.defaultWatermarkAssetId` — role `owner` **or** `admin`;
 *   - `billingContactUserId` — **owner only** (contract §2.1:
 *     "`billingContactUserId` (owner only; must be an active `tenantMembers` row
 *     → `422 invalid_billing_contact`").
 *
 * Keeping the matrix as data — rather than as `if (role === "owner")` spread
 * across handlers — is what makes the boundary reviewable in one place. A
 * `member` may patch nothing.
 */

/** A workspace-level role (schema §13.4). */
export type TenantRole = "owner" | "admin" | "member";

/** Every field `PATCH /tenants/{tenantId}` may set (contract §2.1). */
export type TenantPatchField =
  | "name"
  | "settings.defaultTimeZone"
  | "settings.brandLogoAssetId"
  | "settings.defaultWatermarkAssetId"
  | "billingContactUserId";

/** The fields an `admin` may set (owner-only fields excluded). */
const ADMIN_FIELDS: readonly TenantPatchField[] = [
  "name",
  "settings.defaultTimeZone",
  "settings.brandLogoAssetId",
  "settings.defaultWatermarkAssetId",
];

/** Every patchable field, in the order the contract lists them. */
const OWNER_FIELDS: readonly TenantPatchField[] = [...ADMIN_FIELDS, "billingContactUserId"];

/** The fields each role may set (contract §2.1). */
export const TENANT_PATCH_PERMISSIONS: Readonly<Record<TenantRole, readonly TenantPatchField[]>> = {
  owner: OWNER_FIELDS,
  admin: ADMIN_FIELDS,
  member: [],
};

/**
 * Decide whether `role` may set `field`.
 *
 * The same decision as {@link TENANT_PATCH_PERMISSIONS}, as a predicate, for a
 * handler that validates one supplied key at a time.
 *
 * @param role - The caller's workspace role.
 * @param field - The supplied patch field.
 * @returns `true` when the role may set the field.
 */
export function canPatchTenantField(role: TenantRole, field: TenantPatchField): boolean {
  const allowed: readonly TenantPatchField[] =
    role === "owner" ? OWNER_FIELDS : role === "admin" ? ADMIN_FIELDS : [];
  return allowed.includes(field);
}

/**
 * Narrow an untyped stored role to a {@link TenantRole}.
 *
 * A `tenantMembers` row written by this application always carries one of the
 * three roles; a value outside the set (a hand-edited row, a future role) is
 * treated as the least privileged `member`, so an unrecognised role can never
 * be interpreted as greater privilege than it has.
 *
 * @param value - The stored `role` value.
 * @returns The matched role, or `"member"`.
 */
export function asTenantRole(value: unknown): TenantRole {
  return value === "owner" || value === "admin" ? value : "member";
}
