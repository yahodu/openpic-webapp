import { describe, expect, it } from "vitest";

import {
  canPatchTenantField,
  TENANT_PATCH_PERMISSIONS,
  type TenantPatchField,
  type TenantRole,
} from "@/server/tenancy/permissions";

/**
 * Unit — the role/permission map for `PATCH /api/v1/tenants/{tenantId}` (OP-100,
 * contract §2.1, schema §13.4).
 *
 * The patch body has five documented fields and the contract splits them across
 * two permission levels:
 *
 *   - `name`, `settings.defaultTimeZone`, `settings.brandLogoAssetId`,
 *     `settings.defaultWatermarkAssetId` — role `owner` **or** `admin`;
 *   - `billingContactUserId` — **owner only** (contract §2.1: "`billingContactUserId`
 *     (owner only; must be an active `tenantMembers` row → `422
 *     invalid_billing_contact`)").
 *
 * A `member` may patch nothing (the integration spec pins the `403 forbidden`
 * that follows). Keeping the matrix as data — not as `if (role === "owner")`
 * spread across handlers — is what makes the boundary reviewable in one place.
 *
 * ## Contract expected of the implementation
 *
 * `@/server/tenancy/permissions` must export:
 *
 *   - `type TenantRole = "owner" | "admin" | "member"`;
 *   - `type TenantPatchField = "name" | "settings.defaultTimeZone" |
 *     "settings.brandLogoAssetId" | "settings.defaultWatermarkAssetId" |
 *     "billingContactUserId"`;
 *   - `TENANT_PATCH_PERMISSIONS: Readonly<Record<TenantRole, readonly
 *     TenantPatchField[]>>` — the fields each role may set;
 *   - `canPatchTenantField(role, field): boolean` — the same decision as a
 *     predicate, for a handler that validates one supplied key at a time.
 */

/** Every field `PATCH /tenants/{tenantId}` may set (contract §2.1). */
const PATCH_FIELDS: readonly TenantPatchField[] = [
  "name",
  "settings.defaultTimeZone",
  "settings.brandLogoAssetId",
  "settings.defaultWatermarkAssetId",
  "billingContactUserId",
];

/** The expected `canPatchTenantField` answer for every (role, field) pair. */
const CASES: ReadonlyArray<readonly [TenantRole, TenantPatchField, boolean]> = [
  ["owner", "name", true],
  ["owner", "settings.defaultTimeZone", true],
  ["owner", "settings.brandLogoAssetId", true],
  ["owner", "settings.defaultWatermarkAssetId", true],
  ["owner", "billingContactUserId", true],
  ["admin", "name", true],
  ["admin", "settings.defaultTimeZone", true],
  ["admin", "settings.brandLogoAssetId", true],
  ["admin", "settings.defaultWatermarkAssetId", true],
  ["admin", "billingContactUserId", false],
  ["member", "name", false],
  ["member", "settings.defaultTimeZone", false],
  ["member", "settings.brandLogoAssetId", false],
  ["member", "settings.defaultWatermarkAssetId", false],
  ["member", "billingContactUserId", false],
];

describe("tenant PATCH field permissions", () => {
  it.each(CASES)("U2: canPatchTenantField(%s, %s) is %s", (role, field, expected) => {
    expect(canPatchTenantField(role, field)).toBe(expected);
  });

  it("U2: lets an owner patch every documented field", () => {
    expect([...TENANT_PATCH_PERMISSIONS.owner].sort()).toEqual([...PATCH_FIELDS].sort());
  });

  it("U2: lets an admin patch name, time zone and branding but not the billing contact", () => {
    expect([...TENANT_PATCH_PERMISSIONS.admin].sort()).toEqual(
      [
        "name",
        "settings.defaultTimeZone",
        "settings.brandLogoAssetId",
        "settings.defaultWatermarkAssetId",
      ].sort()
    );
  });

  it("U2: lets a member patch no field", () => {
    expect(TENANT_PATCH_PERMISSIONS.member).toEqual([]);
  });

  it("U2: exposes a permission map that agrees with canPatchTenantField", () => {
    const entries = Object.entries(TENANT_PATCH_PERMISSIONS) as Array<
      [TenantRole, readonly TenantPatchField[]]
    >;
    for (const [role, allowed] of entries) {
      for (const field of PATCH_FIELDS) {
        expect(allowed.includes(field)).toBe(canPatchTenantField(role, field));
      }
    }
  });
});
