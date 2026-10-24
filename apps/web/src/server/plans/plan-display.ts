import type { Entitlement } from "./plans";

/**
 * The `GET /plans` entitlement `display` projection (OP-102, contract §3.1,
 * ADR-0320).
 *
 * The stored entitlement has no copy: `plans.entitlements` is self-describing
 * data (`limit` + `resetPeriod` + `scope` + `enforcement`, plus an optional
 * `enabled` gate), so the pricing page renders it verbatim **plus** a
 * synthesised `display` string. That string is a pure function of the key and
 * its stored spec — never a hard-coded key list — because contract §3.1 makes
 * "adding an entitlement key a data edit with zero API change" and requires
 * clients to "render unknown keys generically from `display`". The formatter is
 * therefore total: every key, known or not, resolves to a non-empty string.
 */

/** Bytes in one binary gigabyte (`1024**3`) — the unit `formatBytes` renders in. */
const BYTES_PER_GIB = 1024 ** 3;

/** The suffix that marks a byte-quantity entitlement key (e.g. `storage.bytes`). */
const BYTES_KEY_SUFFIX = ".bytes";

/**
 * Format a byte quantity as binary GB (`1024**3`), at most one decimal place,
 * with a trailing `.0` removed.
 *
 * @param bytes - The quantity in bytes (a stored `limit`).
 * @returns The quantity rendered in GB, e.g. `2147483648` → `"2 GB"` and
 *   `536870912` → `"0.5 GB"`.
 */
export function formatBytes(bytes: number): string {
  const gigabytes = bytes / BYTES_PER_GIB;
  const rounded = Math.round(gigabytes * 10) / 10;
  return `${String(rounded)} GB`;
}

/**
 * Resolve the generic `display` string for one entitlement (contract §3.1).
 *
 * The classes are resolved in this order, so a `feature` spec whose `limit` is
 * `null` renders as a gate and never as "Unlimited":
 *
 *   1. `enforcement === "feature"` → `"Included"` when `enabled === true`,
 *      else `"Not included"`;
 *   2. `limit === null`            → `"Unlimited"`;
 *   3. a key ending in `.bytes`    → {@link formatBytes};
 *   4. otherwise                  → the bare integer `String(limit)`.
 *
 * Counts are deliberately **not** locale-formatted: `toLocaleString()` would
 * make the served body depend on the runner's default locale, so the same
 * request could answer differently on two machines.
 *
 * @param key - The entitlement key (used only to detect a byte quantity).
 * @param spec - The stored entitlement spec.
 * @returns A non-empty display string for the entitlement.
 */
export function formatEntitlementDisplay(key: string, spec: Entitlement): string {
  if (spec.enforcement === "feature") {
    return spec.enabled === true ? "Included" : "Not included";
  }
  if (spec.limit === null) {
    return "Unlimited";
  }
  if (key.endsWith(BYTES_KEY_SUFFIX)) {
    return formatBytes(spec.limit);
  }
  return String(spec.limit);
}
