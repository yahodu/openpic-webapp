import { ObjectId } from "mongodb";

import type { TenantRole } from "./permissions";
import type { Tenant } from "./schema";

/**
 * `tenants` → §2.1 DTO projection (OP-100).
 *
 * The stored document is read field by field with explicit coercions so a
 * missing counter reads as `0` and a missing date as `null` rather than leaking
 * `undefined` into a response. Two values are deliberate constants rather than
 * copies of stored data:
 *
 *   - `counters.approximate` is always `true` — §2.1 makes it mandatory; the
 *     document does not carry it;
 *   - the branding URLs are always `null` until the OP-117 signer exists, which
 *     is what `settings.brandLogoAssetId`/`defaultWatermarkAssetId` are for.
 */

/** Read a stored value as a hex id string, or `null`. */
function toHexOrNull(value: unknown): string | null {
  if (value instanceof ObjectId) {
    return value.toHexString();
  }
  return typeof value === "string" ? value : null;
}

/** Read a stored value as an integer, defaulting to `0`. */
function toInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
}

/** Read a stored value as an ISO-8601 string, or `null`. */
function toIsoOrNull(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

/** True for a plain document (never an array or `null`). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a stored value as a plain object, or an empty one when it is not. */
function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** The single IANA zone fallback, matching the provisioning default. */
const DEFAULT_TIME_ZONE = "Asia/Kolkata";

/**
 * Project a stored `tenants` document onto the §2.1 DTO.
 *
 * @param raw - The stored tenant document.
 * @param myRole - The caller's role in this workspace (the `myRole` field).
 * @returns The wire DTO, ready for `serializeResponse`.
 */
export function projectTenant(raw: Record<string, unknown>, myRole: TenantRole): Tenant {
  const counters = asRecord(raw.counters);
  const settings = asRecord(raw.settings);

  return {
    id: toHexOrNull(raw._id) ?? "",
    slug: typeof raw.slug === "string" ? raw.slug : "",
    name: typeof raw.name === "string" ? raw.name : "",
    status: raw.status === "suspended" || raw.status === "closed" ? raw.status : "active",
    ownerUserId: toHexOrNull(raw.ownerUserId),
    billingContactUserId: toHexOrNull(raw.billingContactUserId),
    dataRegion: raw.dataRegion === "eu" ? "eu" : "in",
    myRole,
    counters: {
      eventCount: toInteger(counters.eventCount),
      activeEventCount: toInteger(counters.activeEventCount),
      imageCount: toInteger(counters.imageCount),
      storageBytes: toInteger(counters.storageBytes),
      attendeeCount: toInteger(counters.attendeeCount),
      approximate: true,
      reconciledAt: toIsoOrNull(counters.reconciledAt),
    },
    settings: {
      defaultTimeZone:
        typeof settings.defaultTimeZone === "string" && settings.defaultTimeZone !== ""
          ? settings.defaultTimeZone
          : DEFAULT_TIME_ZONE,
      // Null until the OP-117 media signer lands (GREEN scope §3).
      brandLogoUrl: null,
      defaultWatermarkUrl: null,
    },
    createdAt: toIsoOrNull(raw.createdAt) ?? "",
  };
}
